import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GoogleHealthError, listDataPoints } from './google-health';
import {
  BASELINE_DAYS,
  addDays,
  isValidTimeZone,
  localDate,
  parseDailyHrv,
  parseDailyRestingHeartRate,
  parseSleep,
  type DailyValue,
  type SleepSession,
} from './readiness';
import {
  HEALTH_LOG_PK,
  measureDay,
  type FetchError,
  type HealthLogItem,
  type MeasuredDay,
} from './health-log-schema';
import { toolError, type ToolError } from './tool-error';

/**
 * Reading Google Health and writing a day's measured half: the pieces the
 * scheduled runs and the note tools (add_health_note, update_health_log) share.
 *
 * Two write rules, by who is writing:
 *
 *   'unsettled'   the 22:00 run: rewrite until the day is settled.
 *   'until-ready' the 10:00 run and the note tools: fill in a day that has
 *                 no readiness yet (awaiting, not_synced, pending), but never
 *                 touch one that is already "ready". That is what makes the
 *                 10:00 run a no-op after an earlier update recorded the day,
 *                 and stops a later update replacing a morning reading.
 *
 * Empty versus failed. A read that succeeds with no data points is an answer
 * ("nothing recorded"), and is written as such: not_synced or no_data, with
 * each missing signal's newest date. A read that fails never touches
 * `measured`; it is recorded beside it as `fetchError` and cleared by the next
 * successful read. Data that came back but could not be parsed is a failure
 * (`parse`), not an empty day: the watch recorded something, this code could
 * not read it.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** The API's page-size ceiling for sleep. */
const SLEEP_PAGE_SIZE = 25;

/**
 * How far back a one-day read looks for sleep, so a missing night can say when
 * the last one was ("no sleep since the 12th": the watch has been off).
 */
const LATEST_LOOKBACK_DAYS = 7;

/** Google returned points for a signal and none of them could be read. */
export class UnreadableHealthDataError extends Error {
  constructor(readonly signal: string, readonly points: number) {
    super(`Google Health returned ${points} ${signal} point(s) and none could be read; the response shape may have changed`);
    this.name = 'UnreadableHealthDataError';
  }
}

/** A failed Google read as the shared ToolError (tool-error.ts). */
export function classifyFetchError(error: unknown): ToolError {
  if (error instanceof GoogleHealthError) {
    return error.kind === 'auth'
      ? toolError('upstream_auth', error.message)
      : toolError('upstream_unavailable', error.message, { details: { cause: 'api' } });
  }
  if (error instanceof UnreadableHealthDataError) {
    return toolError('internal', error.message, {
      fix: 'A parser in lambda/readiness.ts needs updating for the new response shape; retrying will not help.',
      details: { cause: 'parse', signal: error.signal, points: error.points },
    });
  }
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  // fetch() rejects with TypeError when the request never completes, and the
  // client's AbortSignal.timeout with TimeoutError / AbortError.
  if (name === 'TimeoutError' || name === 'AbortError' || name === 'TypeError') {
    return toolError('upstream_unavailable', `Google Health could not be reached: ${message}`, {
      details: { cause: 'network' },
    });
  }
  if (error instanceof SyntaxError) {
    return toolError('upstream_unavailable', `Google Health sent an unreadable response: ${message}`, {
      details: { cause: 'api' },
    });
  }
  return toolError('internal', message);
}

/** A read failed: carries what was recorded on the day(s) about it. */
export class ReadinessFetchFailure extends Error {
  constructor(readonly fetchError: FetchError, readonly cause: unknown) {
    super(fetchError.error.message);
    this.name = 'ReadinessFetchFailure';
  }
}

function parseAll<T>(signal: string, points: unknown[], parse: (p: unknown) => T | null): T[] {
  const parsed = points.map(parse).filter((v): v is T => v !== null);
  if (points.length > 0 && parsed.length === 0) throw new UnreadableHealthDataError(signal, points.length);
  if (parsed.length < points.length) {
    console.warn(`Unparseable ${signal} point`, JSON.stringify(points.find((p) => parse(p) === null)));
  }
  return parsed;
}

export interface Signals {
  sleeps: SleepSession[];
  hrv: DailyValue[];
  restingHeartRate: DailyValue[];
}

/**
 * Sleep ending on `from`..`to`, and daily HRV and resting heart rate over the
 * same days plus the baseline before `from`. Three reads, in parallel.
 */
export async function fetchSignals(secretName: string, timeZone: string, from: string, to: string): Promise<Signals> {
  const end = addDays(to, 1);
  const baselineFrom = addDays(from, -BASELINE_DAYS);
  const [sleepPoints, hrvPoints, rhrPoints] = await Promise.all([
    listDataPoints(
      secretName,
      'sleep',
      `sleep.interval.civil_end_time >= "${from}" AND sleep.interval.civil_end_time < "${end}"`,
      SLEEP_PAGE_SIZE,
    ),
    listDataPoints(
      secretName,
      'daily-heart-rate-variability',
      `daily_heart_rate_variability.date >= "${baselineFrom}" AND daily_heart_rate_variability.date < "${end}"`,
    ),
    listDataPoints(
      secretName,
      'daily-resting-heart-rate',
      `daily_resting_heart_rate.date >= "${baselineFrom}" AND daily_resting_heart_rate.date < "${end}"`,
    ),
  ]);
  return {
    sleeps: parseAll('sleep', sleepPoints, (p) => parseSleep(p, timeZone)),
    hrv: parseAll('hrv', hrvPoints, parseDailyHrv),
    restingHeartRate: parseAll('restingHeartRate', rhrPoints, parseDailyRestingHeartRate),
  };
}

export type WriteRule = 'unsettled' | 'until-ready';

const CONDITIONS: Record<WriteRule, string> = {
  unsettled: 'attribute_not_exists(#measured) OR #measured.#settled = :false',
  'until-ready': 'attribute_not_exists(#measured) OR (#measured.#settled = :false AND #measured.#status <> :ready)',
};

/**
 * Write `measured` for `date` under `rule`, creating the day if it is missing.
 * Only `measured`, `measuredAt` and (once) `createdAt` are set, and any earlier
 * `fetchError` is removed, since this read succeeded; notes are never touched.
 * Returns the day as stored, or null when the rule refused it.
 */
export async function writeMeasured(
  tableName: string,
  date: string,
  measured: MeasuredDay,
  measuredAt: string,
  rule: WriteRule,
): Promise<HealthLogItem | null> {
  const names: Record<string, string> = {
    '#measured': 'measured',
    '#measuredAt': 'measuredAt',
    '#createdAt': 'createdAt',
    '#settled': 'settled',
    '#fetchError': 'fetchError',
  };
  const values: Record<string, unknown> = { ':measured': measured, ':measuredAt': measuredAt, ':false': false };
  if (rule === 'until-ready') {
    names['#status'] = 'status';
    values[':ready'] = 'ready';
  }
  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: HEALTH_LOG_PK, date },
        UpdateExpression:
          'SET #measured = :measured, #measuredAt = :measuredAt, #createdAt = if_not_exists(#createdAt, :measuredAt) ' +
          'REMOVE #fetchError',
        ConditionExpression: CONDITIONS[rule],
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return (
      (result.Attributes as HealthLogItem | undefined) ?? {
        pk: HEALTH_LOG_PK,
        date,
        measured,
        measuredAt,
        createdAt: measuredAt,
      }
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return null;
    throw error;
  }
}

/** Does this day already have a readiness reading? */
export const hasReadiness = (item: Pick<HealthLogItem, 'measured'> | undefined | null): boolean =>
  item?.measured?.status === 'ready';

/**
 * Record a failed read on each of `dates` that exists and is not settled.
 * Leaves `measured` alone, so the last good answer stays visible beside the
 * failure. Never throws: it must not mask the failure it is recording.
 */
export async function recordFetchError(tableName: string, dates: readonly string[], fetchError: FetchError): Promise<void> {
  for (const date of dates) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: HEALTH_LOG_PK, date },
          UpdateExpression: 'SET #fetchError = :fetchError',
          ConditionExpression: 'attribute_exists(#measured) AND #measured.#settled = :false',
          ExpressionAttributeNames: { '#fetchError': 'fetchError', '#measured': 'measured', '#settled': 'settled' },
          ExpressionAttributeValues: { ':fetchError': fetchError, ':false': false },
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        console.error('Could not record fetchError on', date, error);
      }
    }
  }
}

/** Build the FetchError for `error`, now. */
export function toFetchError(error: unknown, by: FetchError['by']): FetchError {
  return { at: new Date().toISOString(), by, error: classifyFetchError(error) };
}

/**
 * Read Google for one day and record it under 'until-ready'. Returns the day as
 * stored, or null when it already had readiness by the time of the write.
 *
 * On a failed read, records `fetchError` on the day and throws a
 * ReadinessFetchFailure carrying it; `measured` is not touched.
 */
export async function recordReadiness(
  tableName: string,
  secretName: string,
  timeZone: string,
  date: string,
  by: FetchError['by'],
): Promise<HealthLogItem | null> {
  let signals: Signals;
  try {
    signals = await fetchSignals(secretName, timeZone, addDays(date, -LATEST_LOOKBACK_DAYS), date);
  } catch (error) {
    const fetchError = toFetchError(error, by);
    console.error('Google Health read failed', date, fetchError.error.code, error);
    await recordFetchError(tableName, [date], fetchError);
    throw new ReadinessFetchFailure(fetchError, error);
  }
  const dayIsOver = date < localDate(new Date(), timeZone);
  const measured = measureDay({ date, ...signals }, { dayIsOver });
  return writeMeasured(tableName, date, measured, new Date().toISOString(), 'until-ready');
}

/**
 * What happened when a note write tried to record readiness. The point is to
 * keep "Google had nothing" and "Google could not be asked" apart:
 *
 *   recorded  Google answered. `status` is what it said: "ready" with values,
 *             or "not_synced" / "no_data" when the night is empty (watch off,
 *             flat, or not synced yet), or "pending" while it processes.
 *   failed    Google could not be read. `error` says why (tool-error.ts); the day's measured
 *             values are unchanged and `fetchError` is set on it.
 */
export type ReadinessFetch =
  | { attempted: false; reason: 'already_ready' }
  | { attempted: true; outcome: 'already_ready' }
  | { attempted: true; outcome: 'recorded'; status: string }
  | { attempted: true; outcome: 'failed'; error: ToolError };

/**
 * After a note write: try to record the day's readiness if it has none, so
 * the first thing said about a day also captures its night. The values come
 * from Google, never from the caller. Never throws: a failure is reported
 * (and stored as `fetchError`) without undoing the note.
 */
export async function fillReadiness(
  tableName: string,
  item: HealthLogItem,
): Promise<{ item: HealthLogItem; readinessFetch: ReadinessFetch }> {
  if (hasReadiness(item)) return { item, readinessFetch: { attempted: false, reason: 'already_ready' } };

  const secretName = process.env.GOOGLE_HEALTH_SECRET_NAME;
  const timeZone = process.env.HEALTH_TIME_ZONE;
  if (!secretName || !timeZone || !isValidTimeZone(timeZone)) {
    return {
      item,
      readinessFetch: {
        attempted: true,
        outcome: 'failed',
        error: toolError('internal', 'Google Health is not configured on this endpoint'),
      },
    };
  }
  try {
    const stored = await recordReadiness(tableName, secretName, timeZone, item.date, 'chat');
    // null: something else recorded a ready reading first; the notes still stand.
    return stored
      ? { item: stored, readinessFetch: { attempted: true, outcome: 'recorded', status: stored.measured.status } }
      : { item, readinessFetch: { attempted: true, outcome: 'already_ready' } };
  } catch (error) {
    const fetchError = error instanceof ReadinessFetchFailure ? error.fetchError : toFetchError(error, 'chat');
    if (!(error instanceof ReadinessFetchFailure)) console.error('Readiness fetch on health log update failed', error);
    return {
      // recordReadiness has stored the same fetchError on the day.
      item: { ...item, fetchError },
      readinessFetch: { attempted: true, outcome: 'failed', error: fetchError.error },
    };
  }
}
