import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { META_SK, SUMMARY_PK } from './workout-schema';
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

  const [dayItems, muscleItems, exerciseItems, metaItem] = await Promise.all([
    queryRange(tableName, SUMMARY_PK.day, from, to),
    queryAll(tableName, SUMMARY_PK.muscle),
    queryAll(tableName, SUMMARY_PK.exercise),
    ddb.send(new GetCommand({ TableName: tableName, Key: { pk: SUMMARY_PK.meta, sk: META_SK } })),
  ]);

  const days = dayItems.map((d) => ({
    date: d.sk,
    sets: d.sets,
    reps: d.reps,
    volume: d.volume,
    exerciseCount: d.exerciseCount,
    muscles: d.muscles ?? {},
  }));

  const muscles = muscleItems
    .map((m) => ({ muscle: m.sk, sets: m.sets, reps: m.reps, volume: m.volume, exercises: m.exercises }))
    .sort((a, b) => (b.volume as number) - (a.volume as number));

  const topExercises = exerciseItems
    .slice()
    .sort((a, b) => (b.volume as number) - (a.volume as number))
    .slice(0, TOP_EXERCISES)
    .map((e) => ({
      name: e.sk,
      muscle: e.muscle,
      sets: e.sets,
      volume: e.volume,
      maxWeight: e.maxWeight,
      lastDate: e.lastDate,
    }));

  const { pk, sk, ...totals } = metaItem.Item ?? {};

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ range: { from, to }, days, muscles, topExercises, totals }),
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
