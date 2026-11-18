import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { listDataPoints } from './google-health';
import {
  BASELINE_DAYS,
  addDays,
  parseDailyHrv,
  parseDailyRestingHeartRate,
  parseSleep,
  type DailyValue,
  type SleepSession,
} from './readiness';
import { HEALTH_LOG_PK, measureDay, type HealthLogItem, type MeasuredDay } from './health-log-schema';

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
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** The API's page-size ceiling for sleep. */
const SLEEP_PAGE_SIZE = 25;

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
    sleeps: sleepPoints.map((p) => parseSleep(p, timeZone)).filter((s): s is SleepSession => s !== null),
    hrv: hrvPoints.map((p) => parseDailyHrv(p)).filter((v): v is DailyValue => v !== null),
    restingHeartRate: rhrPoints
      .map((p) => parseDailyRestingHeartRate(p))
      .filter((v): v is DailyValue => v !== null),
  };
}

export type WriteRule = 'unsettled' | 'until-ready';

const CONDITIONS: Record<WriteRule, string> = {
  unsettled: 'attribute_not_exists(#measured) OR #measured.#settled = :false',
  'until-ready': 'attribute_not_exists(#measured) OR (#measured.#settled = :false AND #measured.#status <> :ready)',
};

/**
 * Write `measured` for `date` under `rule`, creating the day if it is missing.
 * Only `measured`, `measuredAt` and (once) `createdAt` are set, so notes are
 * never touched. Returns the day as stored, or null when the rule refused it.
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
          'SET #measured = :measured, #measuredAt = :measuredAt, #createdAt = if_not_exists(#createdAt, :measuredAt)',
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
 * Read Google for one day and record it under 'until-ready'. Returns the day as
 * stored, or null when it already had readiness by the time of the write.
 * Google errors are thrown for the caller to decide on.
 */
export async function recordReadiness(
  tableName: string,
  secretName: string,
  timeZone: string,
  date: string,
): Promise<HealthLogItem | null> {
  const signals = await fetchSignals(secretName, timeZone, date, date);
  const measured = measureDay({ date, ...signals });
  return writeMeasured(tableName, date, measured, new Date().toISOString(), 'until-ready');
}
