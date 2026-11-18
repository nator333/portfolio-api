import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { listDataPoints } from './google-health';
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
import { HEALTH_LOG_PK, LOG_DAYS, logDates, measureDays } from './health-log-schema';

/**
 * Seeds and refreshes the health log's measured half, nightly at 22:00 local.
 *
 * Three Google Health reads per run, whatever the window: sleep over the
 * window, and HRV and resting heart rate over the window plus its baselines.
 * Each day is then judged locally and written with one UpdateItem that:
 *
 *   - creates the day if it does not exist yet, so every day has a record
 *     Claude can annotate, including days with no watch data;
 *   - sets only `measured` and `measuredAt` (and `createdAt` once), so the
 *     notes Claude has written are never touched;
 *   - is refused by its condition once the day is settled, so a settled
 *     day's numbers stay as they were.
 *
 * A Google failure throws: the scheduler retries, and the next night's run
 * covers the same days anyway. Nothing is written from a failed read.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** The API's page-size ceiling for sleep. */
const SLEEP_PAGE_SIZE = 25;

export interface IngestSummary {
  from: string;
  to: string;
  written: number;
  settledSkipped: number;
}

export const handler = async (): Promise<IngestSummary> => {
  const tableName = process.env.HEALTH_LOG_TABLE_NAME;
  const secretName = process.env.GOOGLE_HEALTH_SECRET_NAME;
  const timeZone = process.env.HEALTH_TIME_ZONE;
  if (!tableName || !secretName || !timeZone || !isValidTimeZone(timeZone)) {
    throw new Error('Missing required env: HEALTH_LOG_TABLE_NAME, GOOGLE_HEALTH_SECRET_NAME, HEALTH_TIME_ZONE');
  }

  const now = new Date();
  const today = localDate(now, timeZone);
  const dates = logDates(today, LOG_DAYS);
  const first = dates[0];
  const tomorrow = addDays(today, 1);
  const baselineFrom = addDays(first, -BASELINE_DAYS);

  const [sleepPoints, hrvPoints, rhrPoints] = await Promise.all([
    listDataPoints(
      secretName,
      'sleep',
      `sleep.interval.civil_end_time >= "${first}" AND sleep.interval.civil_end_time < "${tomorrow}"`,
      SLEEP_PAGE_SIZE,
    ),
    listDataPoints(
      secretName,
      'daily-heart-rate-variability',
      `daily_heart_rate_variability.date >= "${baselineFrom}" AND daily_heart_rate_variability.date < "${tomorrow}"`,
    ),
    listDataPoints(
      secretName,
      'daily-resting-heart-rate',
      `daily_resting_heart_rate.date >= "${baselineFrom}" AND daily_resting_heart_rate.date < "${tomorrow}"`,
    ),
  ]);
  const sleeps = sleepPoints.map((p) => parseSleep(p, timeZone)).filter((s): s is SleepSession => s !== null);
  const hrv = hrvPoints.map((p) => parseDailyHrv(p)).filter((v): v is DailyValue => v !== null);
  const restingHeartRate = rhrPoints
    .map((p) => parseDailyRestingHeartRate(p))
    .filter((v): v is DailyValue => v !== null);

  const measuredAt = now.toISOString();
  let written = 0;
  let settledSkipped = 0;
  // In series: 28 small writes, and one run a day. Not worth the throttling risk.
  for (const { date, measured } of measureDays(dates, { sleeps, hrv, restingHeartRate })) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: HEALTH_LOG_PK, date },
          UpdateExpression: 'SET #measured = :measured, #measuredAt = :measuredAt, #createdAt = if_not_exists(#createdAt, :measuredAt)',
          ConditionExpression: 'attribute_not_exists(#measured) OR #measured.#settled = :false',
          ExpressionAttributeNames: {
            '#measured': 'measured',
            '#measuredAt': 'measuredAt',
            '#createdAt': 'createdAt',
            '#settled': 'settled',
          },
          ExpressionAttributeValues: { ':measured': measured, ':measuredAt': measuredAt, ':false': false },
        }),
      );
      written += 1;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        settledSkipped += 1;
        continue;
      }
      throw error;
    }
  }

  const summary = { from: first, to: today, written, settledSkipped };
  console.log('Health log ingest', JSON.stringify(summary));
  return summary;
};
