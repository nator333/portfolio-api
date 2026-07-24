import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { META_SK, SOURCE_WEIGHT_UNIT, SUMMARY_PK } from './workout-schema';
import { corsHeaders } from './cors';

/**
 * Public read endpoint for the workout summaries, consumed by portfolio-front's
 * per-day activity view. The summary table lives in us-west-2 (co-located with
 * ingestion), so this us-west-1 Lambda reads it cross-region — cheap, since the
 * whole API is behind the monthly usage-plan quota.
 */

const region = process.env.WORKOUT_REGION;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}));

const DEFAULT_WINDOW_DAYS = 365;
const TOP_EXERCISES = 10;
/** ISO weeks of sets-per-muscle history returned (~1 year). */
const WEEKS_RETURNED = 52;
/** Lifts returned in the strength-progression series. */
const TOP_LIFTS = 8;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.WORKOUT_SUMMARY_TABLE_NAME;
  if (!tableName) {
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'WORKOUT_SUMMARY_TABLE_NAME is not configured' }) };
  }

  const params = event.queryStringParameters ?? {};
  const to = params.to && DATE_RE.test(params.to) ? params.to : isoDate(new Date());
  let from: string;
  if (params.from && DATE_RE.test(params.from)) {
    from = params.from;
  } else {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - DEFAULT_WINDOW_DAYS);
    from = isoDate(d);
  }

  const [dayItems, muscleItems, exerciseItems, weekItems, metaItem] = await Promise.all([
    queryRange(tableName, SUMMARY_PK.day, from, to),
    queryAll(tableName, SUMMARY_PK.muscle),
    queryAll(tableName, SUMMARY_PK.exercise),
    queryAll(tableName, SUMMARY_PK.week),
    ddb.send(new GetCommand({ TableName: tableName, Key: { pk: SUMMARY_PK.meta, sk: META_SK } })),
  ]);

  // Volumes and weights are served in both the export's unit and kilograms
  // (`*Kg`), so the front end can present either without a conversion of its own.
  const days = dayItems.map((d) => ({
    date: d.sk,
    sets: d.sets,
    reps: d.reps,
    volume: d.volume,
    volumeKg: d.volumeKg,
    exerciseCount: d.exerciseCount,
    muscles: d.muscles ?? {},
  }));

  const muscles = muscleItems
    .map((m) => ({
      muscle: m.sk,
      sets: m.sets,
      reps: m.reps,
      volume: m.volume,
      volumeKg: m.volumeKg,
      exercises: m.exercises,
    }))
    .sort((a, b) => (b.volume as number) - (a.volume as number));

  // Sets per muscle per week — the actionable training-volume series, and what
  // the progress page should chart instead of total mass lifted.
  const weeks = weekItems
    .slice()
    .sort((a, b) => String(a.sk).localeCompare(String(b.sk)))
    .slice(-WEEKS_RETURNED)
    .map((w) => ({ week: w.sk, sets: w.sets, sessions: w.sessions, muscles: w.muscles ?? {} }));

  // Strength progression: best estimated 1RM per lift, most-trained lifts first.
  const lifts = exerciseItems
    .filter((e) => typeof e.bestE1rm === 'number' && (e.bestE1rm as number) > 0)
    .sort((a, b) => (b.sets as number) - (a.sets as number))
    .slice(0, TOP_LIFTS)
    .map((e) => ({
      name: e.sk,
      muscle: e.muscle,
      sets: e.sets,
      bestE1rm: e.bestE1rm,
      bestE1rmKg: e.bestE1rmKg,
      bestE1rmDate: e.bestE1rmDate,
    }));

  // Ranked by sets rather than volume: volume ranking surfaces whichever machine
  // has the heaviest stack, not what is actually trained most.
  const topExercises = exerciseItems
    .slice()
    .sort((a, b) => (b.sets as number) - (a.sets as number))
    .slice(0, TOP_EXERCISES)
    .map((e) => ({
      name: e.sk,
      muscle: e.muscle,
      sets: e.sets,
      volume: e.volume,
      volumeKg: e.volumeKg,
      maxWeight: e.maxWeight,
      maxWeightKg: e.maxWeightKg,
      lastDate: e.lastDate,
    }));

  const { pk, sk, ...totals } = metaItem.Item ?? {};

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      range: { from, to },
      unit: SOURCE_WEIGHT_UNIT,
      days,
      weeks,
      lifts,
      muscles,
      topExercises,
      totals,
    }),
  };
};

async function queryRange(
  tableName: string,
  pk: string,
  from: string,
  to: string,
): Promise<Record<string, unknown>[]> {
  return queryPaged(tableName, {
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: { ':pk': pk, ':from': from, ':to': to },
  });
}

async function queryAll(tableName: string, pk: string): Promise<Record<string, unknown>[]> {
  return queryPaged(tableName, {
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': pk },
  });
}

async function queryPaged(
  tableName: string,
  key: { KeyConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> },
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({ TableName: tableName, ...key, ExclusiveStartKey: lastKey }),
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return items;
}
