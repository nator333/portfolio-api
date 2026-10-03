import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { META_SK, SOURCE_WEIGHT_UNIT, SUMMARY_PK } from './workout-schema';
import { PLAN_VERSION_PREFIX, versionInEffect, type PlanVersion } from './workout-plan-schema';
import { selectStrengthLifts } from './strength-lifts';
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
/** Lifts returned in the strength-progression series when no plan is readable. */
const TOP_LIFTS = 8;
/** The program the strength chart follows; mirrors get-workout-plan.ts. */
const PLAN_ID = 'upper-lower';
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

  const [dayItems, muscleItems, exerciseItems, weekItems, e1rmItems, metaItem, planVersions] =
    await Promise.all([
      queryRange(tableName, SUMMARY_PK.day, from, to),
      queryAll(tableName, SUMMARY_PK.muscle),
      queryAll(tableName, SUMMARY_PK.exercise),
      queryAll(tableName, SUMMARY_PK.week),
      queryAll(tableName, SUMMARY_PK.exerciseMonth),
      ddb.send(new GetCommand({ TableName: tableName, Key: { pk: SUMMARY_PK.meta, sk: META_SK } })),
      readPlanVersions(),
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

  // Strength progression: the strength-range lifts of the plan in force on
  // `to`, then a few long-history lifts no longer logged (see strength-lifts.ts).
  const plan = versionInEffect(planVersions, to);
  const selected = selectStrengthLifts(
    plan,
    exerciseItems.map((e) => ({
      name: String(e.sk),
      sets: Number(e.sets ?? 0),
      lastDate: String(e.lastDate ?? ''),
      bestE1rmKg: Number(e.bestE1rmKg ?? 0),
    })),
    e1rmItems.map((m) => ({
      exercise: String(m.exercise),
      month: String(m.month),
      sets: Number(m.sets ?? 0),
    })),
    to,
    TOP_LIFTS,
  );
  const exerciseByName = new Map(exerciseItems.map((e) => [e.sk as string, e]));
  const lifts = selected.map(({ name, tracked }) => {
    const e = exerciseByName.get(name)!;
    return {
      name,
      muscle: e.muscle,
      sets: e.sets,
      bestE1rm: e.bestE1rm,
      bestE1rmKg: e.bestE1rmKg,
      bestE1rmDate: e.bestE1rmDate,
      tracked,
    };
  });

  // Strength-over-time: the monthly estimated-1RM series per lift, for exactly
  // the lifts surfaced above. Restricting to those keeps the payload bounded
  // (all lifts' months would be ~1,900 points); the front charts the honest
  // month-by-month best, so declines show rather than being smoothed away.
  const liftNames = new Set(lifts.map((l) => l.name));
  const seriesByLift = new Map<string, { month: string; e1rmKg: number }[]>();
  for (const item of e1rmItems) {
    const name = item.exercise as string;
    if (!liftNames.has(name)) continue;
    const e1rmKg = item.bestE1rmKg as number;
    if (!(e1rmKg > 0)) continue;
    const points = seriesByLift.get(name) ?? [];
    points.push({ month: item.month as string, e1rmKg });
    seriesByLift.set(name, points);
  }
  const strengthSeries = lifts.map((l) => ({
    name: l.name,
    muscle: l.muscle,
    tracked: l.tracked,
    points: (seriesByLift.get(l.name as string) ?? []).sort((a, b) => a.month.localeCompare(b.month)),
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
      strengthSeries,
      // When each plan version took effect, for marking block changes on the
      // strength chart. Version numbers and dates only: the program itself
      // stays behind the admin-gated MCP tools.
      planChanges: planVersions
        .filter((v) => v.effectiveFrom !== null)
        .map((v) => ({ version: v.version, effectiveFrom: v.effectiveFrom }))
        .sort((a, b) => a.version - b.version),
      muscles,
      topExercises,
      totals,
    }),
  };
};

/**
 * Every version of the program, for choosing the strength lifts and marking
 * block changes. Best-effort: this is the public endpoint, and a plan table
 * that is unconfigured or unreachable should cost the chart its plan-awareness,
 * not cost the page its data — the selection falls back to all-time ranking.
 */
async function readPlanVersions(): Promise<PlanVersion[]> {
  const planTable = process.env.WORKOUT_PLAN_TABLE_NAME;
  if (!planTable) return [];
  try {
    const items: PlanVersion[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(
        new QueryCommand({
          TableName: planTable,
          KeyConditionExpression: 'planId = :p AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':p': PLAN_ID, ':prefix': PLAN_VERSION_PREFIX },
          ExclusiveStartKey: lastKey,
        }),
      );
      items.push(...((page.Items ?? []) as PlanVersion[]));
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);
    return items;
  } catch (err) {
    console.error('Reading the workout plan failed; strength lifts fall back to all-time ranking', err);
    return [];
  }
}

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
