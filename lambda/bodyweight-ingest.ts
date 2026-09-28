import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { listDataPoints } from './google-health';
import { addDays, isValidTimeZone, localDate } from './readiness';
import { parseWeight, type Reading } from './weight-trend';
import {
  BODYWEIGHT_ITEM_ID,
  INGEST_MONTHS,
  mergeMonths,
  monthlyAverages,
  windowStart,
  type MonthlyBodyweight,
} from './bodyweight-schema';

/**
 * Refreshes the public monthly-bodyweight snapshot from the owner's smart
 * scale, once a day.
 *
 * Scheduled, unlike get-readiness and get-weight-trend, which read Google
 * Health at call time. Two reasons, and neither is about freshness (a monthly
 * average barely moves in a day):
 *
 *   - GET /bodyweight is public. Calling Google on a visitor's request would
 *     put the owner's Google grant and Google's quota behind an anonymous
 *     endpoint; reading a stored snapshot keeps the grant with this function
 *     and the admin MCP server only.
 *   - Only the averages are meant to exist outside Google Health. Computing
 *     them here, and writing nothing else, is how that is kept true.
 *
 * Each run re-reads the last INGEST_MONTHS months and overwrites those months
 * in the snapshot, so a late-syncing or deleted weigh-in is reflected; older
 * stored months are kept (see mergeMonths).
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (): Promise<void> => {
  const tableName = process.env.CV_TABLE_NAME;
  const secretName = process.env.GOOGLE_HEALTH_SECRET_NAME;
  const timeZone = process.env.HEALTH_TIME_ZONE;
  if (!tableName || !secretName || !timeZone || !isValidTimeZone(timeZone)) {
    throw new Error('Missing required env: CV_TABLE_NAME, GOOGLE_HEALTH_SECRET_NAME, HEALTH_TIME_ZONE');
  }

  const today = localDate(new Date(), timeZone);
  const from = windowStart(today, INGEST_MONTHS);
  // Widened a day each side so no local day is lost to the UTC offset; readings
  // are then kept by their local date.
  const points = await listDataPoints(
    secretName,
    'weight',
    `weight.sample_time.physical_time >= "${addDays(from, -1)}T00:00:00Z" AND ` +
      `weight.sample_time.physical_time < "${addDays(today, 2)}T00:00:00Z"`,
  );
  const readings = points
    .map((p) => parseWeight(p, timeZone))
    .filter((r): r is Reading => r !== null && r.date >= from && r.date <= today);

  const stored = await ddb.send(new GetCommand({ TableName: tableName, Key: { id: BODYWEIGHT_ITEM_ID } }));
  const months = mergeMonths(
    (stored.Item?.months ?? []) as MonthlyBodyweight[],
    monthlyAverages(readings, today),
    from.slice(0, 7),
  );

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: { id: BODYWEIGHT_ITEM_ID, months, updatedAt: new Date().toISOString() },
    }),
  );

  // Counts only: the readings themselves are not logged either.
  console.log(`Stored ${months.length} monthly averages from ${readings.length} of ${points.length} weigh-in points`);
};
