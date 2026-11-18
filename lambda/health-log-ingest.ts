import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isValidTimeZone, localDate } from './readiness';
import { HEALTH_LOG_PK, LOG_DAYS, awaitingDay, logDates, measureDays, type HealthLogItem } from './health-log-schema';
import {
  fetchSignals,
  hasReadiness,
  recordFetchError,
  recordReadiness,
  toFetchError,
  writeMeasured,
  type Signals,
} from './health-log-measure';

/**
 * Opens and measures the health log's days. Three schedules invoke it, all in
 * the owner's time zone:
 *
 *   00:05  `{ "mode": "open" }`: creates today with an "awaiting" placeholder,
 *          so Claude can annotate it during the day. No Google read; a day
 *          that already exists is left exactly as it is.
 *   10:00  `{ "mode": "morning" }`: records today's readiness if nothing has
 *          yet. The note tools try the same on the first note of the day,
 *          so this is the fallback for a day with no morning chat. Idempotent:
 *          if today already has a "ready" reading it returns without calling
 *          Google, and its write is conditioned on the same, so a note landing
 *          during the run cannot be overwritten either.
 *   22:00  no input: the measuring run below.
 *
 * The 22:00 run makes three Google reads covering the whole LOG_DAYS window,
 * judges each day locally, and writes each with the 'unsettled' rule (see
 * health-log-measure.ts): it creates a missing day, sets only the measured
 * half, and stops rewriting a day once it is settled. A Google failure throws:
 * `fetchError` is recorded on each unsettled day, the scheduler retries, and
 * the next night covers the same days anyway.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface IngestEvent {
  mode?: 'open' | 'morning' | 'measure';
}

export interface OpenSummary {
  mode: 'open';
  date: string;
  created: boolean;
}

export interface MorningSummary {
  mode: 'morning';
  date: string;
  /** "already_ready": nothing to do. "recorded": written now (possibly still not_synced). */
  outcome: 'already_ready' | 'recorded';
  status?: string;
}

export interface IngestSummary {
  from: string;
  to: string;
  written: number;
  settledSkipped: number;
}

export async function handler(event: { mode: 'open' }): Promise<OpenSummary>;
export async function handler(event: { mode: 'morning' }): Promise<MorningSummary>;
export async function handler(event?: { mode?: 'measure' }): Promise<IngestSummary>;
export async function handler(event?: IngestEvent): Promise<IngestSummary | OpenSummary | MorningSummary>;
export async function handler(event: IngestEvent = {}): Promise<IngestSummary | OpenSummary | MorningSummary> {
  if (event?.mode === 'open') return openToday();
  if (event?.mode === 'morning') return morning();
  return measure();
}

function env(needSecret: boolean) {
  const tableName = process.env.HEALTH_LOG_TABLE_NAME;
  const secretName = process.env.GOOGLE_HEALTH_SECRET_NAME;
  const timeZone = process.env.HEALTH_TIME_ZONE;
  if (!tableName || !timeZone || !isValidTimeZone(timeZone) || (needSecret && !secretName)) {
    throw new Error(
      `Missing required env: HEALTH_LOG_TABLE_NAME, HEALTH_TIME_ZONE${needSecret ? ', GOOGLE_HEALTH_SECRET_NAME' : ''}`,
    );
  }
  return { tableName, timeZone, secretName: secretName ?? '' };
}

async function openToday(): Promise<OpenSummary> {
  const { tableName, timeZone } = env(false);
  const now = new Date();
  const date = localDate(now, timeZone);
  let created = true;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: HEALTH_LOG_PK, date },
        UpdateExpression: 'SET #measured = :measured, #createdAt = :createdAt',
        // Never over an existing day: a re-run, or a hand-run backfill that
        // already measured it, keeps what is there.
        ConditionExpression: 'attribute_not_exists(#measured)',
        ExpressionAttributeNames: { '#measured': 'measured', '#createdAt': 'createdAt' },
        ExpressionAttributeValues: { ':measured': awaitingDay(), ':createdAt': now.toISOString() },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
    created = false;
  }
  const summary: OpenSummary = { mode: 'open', date, created };
  console.log('Health log open', JSON.stringify(summary));
  return summary;
}

async function morning(): Promise<MorningSummary> {
  const { tableName, timeZone, secretName } = env(true);
  const date = localDate(new Date(), timeZone);

  // Checked first so a day an update already recorded costs no Google call.
  const existing = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk: HEALTH_LOG_PK, date } }));
  let summary: MorningSummary;
  if (hasReadiness(existing.Item as HealthLogItem | undefined)) {
    summary = { mode: 'morning', date, outcome: 'already_ready' };
  } else {
    // A failed read records `fetchError` on today and throws, so the
    // scheduler retries and the failure is visible on the day meanwhile.
    const stored = await recordReadiness(tableName, secretName, timeZone, date, 'morning');
    // null: an update recorded it between the check and the write.
    summary = stored
      ? { mode: 'morning', date, outcome: 'recorded', status: stored.measured.status }
      : { mode: 'morning', date, outcome: 'already_ready' };
  }
  console.log('Health log morning', JSON.stringify(summary));
  return summary;
}

async function measure(): Promise<IngestSummary> {
  const { tableName, timeZone, secretName } = env(true);
  const now = new Date();
  const today = localDate(now, timeZone);
  const dates = logDates(today, LOG_DAYS);
  let signals: Signals;
  try {
    signals = await fetchSignals(secretName, timeZone, dates[0], today);
  } catch (error) {
    // Nothing measured is touched; each unsettled day says the read failed.
    const fetchError = toFetchError(error, 'nightly');
    console.error('Google Health read failed', fetchError.error.code, error);
    await recordFetchError(tableName, dates, fetchError);
    throw error;
  }

  const measuredAt = now.toISOString();
  let written = 0;
  let settledSkipped = 0;
  // In series: 28 small writes, and one run a day. Not worth the throttling risk.
  // 22:00: every day in the window is over, so an empty night is no_data.
  for (const { date, measured } of measureDays(dates, signals, { dayIsOver: true })) {
    if (await writeMeasured(tableName, date, measured, measuredAt, 'unsettled')) written += 1;
    else settledSkipped += 1;
  }

  const summary = { from: dates[0], to: today, written, settledSkipped };
  console.log('Health log ingest', JSON.stringify(summary));
  return summary;
}
