import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GoogleHealthError, listDataPoints } from './google-health';
import {
  BASELINE_DAYS,
  addDays,
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
  type FetchErrorKind,
  type HealthLogItem,
  type MeasuredDay,
} from './health-log-schema';

/**
 * Reading Google Health and writing a day's measured half: the pieces the
 * scheduled runs and update_health_log share.
 *
 * Two write rules, by who is writing:
 *
 *   'unsettled'   the 22:00 run: rewrite until the day is settled.
 *   'until-ready' the 10:00 run and update_health_log: fill in a day that has
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

/** Which kind of failure `error` is, for `fetchError`. */
export function classifyFetchError(error: unknown): { kind: FetchErrorKind; message: string } {
  if (error instanceof GoogleHealthError) return { kind: error.kind, message: error.message };
  if (error instanceof UnreadableHealthDataError) return { kind: 'parse', message: error.message };
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  // fetch() rejects with TypeError when the request never completes, and the
  // client's AbortSignal.timeout with TimeoutError / AbortError.
  if (name === 'TimeoutError' || name === 'AbortError' || name === 'TypeError') {
    return { kind: 'network', message: `Google Health could not be reached: ${message}` };
  }
  if (error instanceof SyntaxError) return { kind: 'api', message: `Google Health sent an unreadable response: ${message}` };
  return { kind: 'unknown', message };
}

/** A read failed: carries what was recorded on the day(s) about it. */
export class ReadinessFetchFailure extends Error {
  constructor(readonly fetchError: FetchError, readonly cause: unknown) {
    super(fetchError.message);
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
  return { at: new Date().toISOString(), by, ...classifyFetchError(error) };
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
    console.error('Google Health read failed', date, fetchError.kind, error);
    await recordFetchError(tableName, [date], fetchError);
    throw new ReadinessFetchFailure(fetchError, error);
  }
  const dayIsOver = date < localDate(new Date(), timeZone);
  const measured = measureDay({ date, ...signals }, { dayIsOver });
  return writeMeasured(tableName, date, measured, new Date().toISOString(), 'until-ready');
}
