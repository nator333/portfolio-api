import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SOURCE_WEIGHT_UNIT } from './workout-schema';
import { corsHeaders } from './cors';

/**
 * Admin-only read of the individual logged sets, the detail the public
 * `/workout` summaries deliberately discard: per-set weight, reps and the
 * free-text note attached to each entry.
 *
 * The sets table is partitioned by date (`date` HASH, `sk` RANGE), so a single
 * day is one cheap Query but a range costs one Query per day in it. That shape
 * is why this endpoint is day-scoped and caps the span, rather than offering
 * the open-ended window `/workout` can afford over its constant-partition
 * summary table.
 */

const region = process.env.WORKOUT_REGION;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Widest span a single call may request. Each day is its own Query, so this is
 * the ceiling on fan-out per request; a month at a time keeps the worst case
 * well inside the Lambda's timeout while still covering a training block.
 */
export const MAX_SPAN_DAYS = 31;

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Every date from `from` to `to` inclusive, as YYYY-MM-DD. */
export function datesInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(isoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.WORKOUT_SETS_TABLE_NAME;
  if (!tableName) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'WORKOUT_SETS_TABLE_NAME is not configured' }),
    };
  }

  const params = event.queryStringParameters ?? {};
  // `date` is the single-day shorthand; from/to express a range. Defaulting a
  // missing `to` to `from` makes the common "just this day" call the cheapest.
  const from = params.from ?? params.date;
  const to = params.to ?? params.date ?? params.from;

  if (!from || !DATE_RE.test(from) || !to || !DATE_RE.test(to)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        message: 'Provide date=YYYY-MM-DD, or from=YYYY-MM-DD and to=YYYY-MM-DD',
      }),
    };
  }
  if (from > to) {
    return { statusCode: 400, headers, body: JSON.stringify({ message: '`from` must not be after `to`' }) };
  }

  const dates = datesInRange(from, to);
  if (dates.length > MAX_SPAN_DAYS) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        message: `Range too wide: ${dates.length} days requested, ${MAX_SPAN_DAYS} is the maximum`,
      }),
    };
  }

  const perDay = await Promise.all(dates.map((date) => querySets(tableName, date)));

  const days = dates
    .map((date, i) => ({ date, sets: perDay[i] }))
    // Rest days are simply absent from the table; omit them rather than
    // returning empty shells the caller has to filter out.
    .filter((day) => day.sets.length > 0);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      from,
      to,
      // Both units ride along for the same reason the summaries carry them: the
      // consumer never has to know the export's unit.
      unit: SOURCE_WEIGHT_UNIT,
      dayCount: days.length,
      setCount: days.reduce((total, day) => total + day.sets.length, 0),
      days,
    }),
  };
};

interface StoredSet {
  sk: string;
  exercise: string;
  setNo: number;
  weight: number;
  weightKg: number;
  reps: number;
  volume: number;
  volumeKg: number;
  muscle: string;
  notes: string;
}

async function querySets(tableName: string, date: string): Promise<StoredSet[]> {
  const items: StoredSet[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  // A single day is small, but paginate anyway: an unusually long session must
  // not silently truncate at DynamoDB's 1MB page.
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: '#d = :date',
        ExpressionAttributeNames: { '#d': 'date' },
        ExpressionAttributeValues: { ':date': date },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      items.push({
        sk: String(item.sk),
        exercise: String(item.exercise ?? ''),
        setNo: Number(item.setNo ?? 0),
        weight: Number(item.weight ?? 0),
        weightKg: Number(item.weightKg ?? 0),
        reps: Number(item.reps ?? 0),
        volume: Number(item.volume ?? 0),
        volumeKg: Number(item.volumeKg ?? 0),
        muscle: String(item.muscle ?? ''),
        notes: String(item.notes ?? ''),
      });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  // Query returns range-key order, which sorts "Bench#10" before "Bench#2";
  // ordering by the recorded set number is what a reader actually expects.
  return items.sort((a, b) =>
    a.exercise === b.exercise ? a.setNo - b.setNo : a.exercise.localeCompare(b.exercise),
  );
}
