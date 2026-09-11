import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SUMMARY_PK } from './workout-schema';
import {
  PLAN_TARGET_PREFIX,
  PLAN_VERSION_PREFIX,
  type PlanVersionItem,
  type TargetSetItem,
  type WeeklySetTarget,
} from './workout-plan-schema';
import {
  muscleVolumeStatus,
  parseWindowDays,
  rollUpSets,
  windowBounds,
  type DayTally,
} from './muscle-volume-status';
import { corsHeaders } from './cors';

/**
 * Planned-versus-actual training volume, answered in one place.
 *
 * `/workout` serves the log and `/workout-plan` serves the program; deciding
 * whether a muscle is under, in range or over means holding both at once, and
 * every consumer that did that for itself arrived somewhere slightly different.
 * The progress page carried its own table of target ranges that had drifted from
 * the plan's (it judged chest against 10-22 while the program asked for 8-9, and
 * lats against 10-25 against a programmed 6), and an agent reading the log
 * through MCP re-derived the whole thing per conversation over whatever window
 * it picked. This endpoint is the answer both of them now ask for.
 *
 * Three reads, in parallel and on every request:
 *
 *   the targets  one descending Query, Limit 1 — the *current* target set, the
 *                half of the program this verdict actually depends on
 *   the menu     the same, for the current version; only `sessionsPerWeek` is
 *                needed, to tell a bonus week from an ordinary one
 *   the log      one Query over the day summaries in the window, whose stored
 *                per-muscle tallies are the same figures `/workout` charts
 *
 * Never a cached copy of any of them, so a revision published a second ago is
 * reflected in the next call rather than at the end of some TTL.
 *
 * Nothing is memoised between invocations. A warm Lambda holding yesterday's
 * targets is exactly the staleness this endpoint exists to remove, and the plan
 * read is a single-item Query against a partition of a handful of versions —
 * there is no cost worth trading correctness for.
 */

const region = process.env.WORKOUT_REGION;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}));

/** The program served when the caller names none; mirrors get-workout-plan.ts. */
export const DEFAULT_PLAN_ID = 'upper-lower';

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const summaryTable = process.env.WORKOUT_SUMMARY_TABLE_NAME;
  const planTable = process.env.WORKOUT_PLAN_TABLE_NAME;
  if (!summaryTable || !planTable) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        message:
          'WORKOUT_SUMMARY_TABLE_NAME and WORKOUT_PLAN_TABLE_NAME must both be configured',
      }),
    };
  }

  const params = event.queryStringParameters ?? {};
  const window = parseWindowDays(params.window);
  if ('error' in window) {
    return { statusCode: 400, headers, body: JSON.stringify({ message: window.error }) };
  }

  const planId = params.planId?.trim() || DEFAULT_PLAN_ID;

  // Stamped before the reads, not after: `asOf` is the instant the window was
  // measured from, and it is what bounds the window below. Taking it afterwards
  // would let a slow read shift the window out from under the answer.
  const asOf = new Date();
  const bounds = windowBounds(asOf, window.days);

  const [plan, targetSet, days] = await Promise.all([
    currentVersion(planTable, planId),
    currentTargets(planTable, planId),
    dayTallies(summaryTable, bounds.from, bounds.to),
  ]);

  if (!plan) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ message: `No plan "${planId}" has been published` }),
    };
  }

  /**
   * Targets come from their own item, falling back to the menu version's
   * embedded copy.
   *
   * The fallback is the bridge across the split: versions published before the
   * targets moved out still carry them, so this endpoint keeps answering
   * correctly between this code deploying and the first target set being
   * written. Once one exists it always wins, and the fallback is dead weight
   * that can go when the last legacy version stops mattering.
   */
  const targets: readonly WeeklySetTarget[] =
    targetSet?.weeklySetTargets ?? plan.weeklySetTargets ?? [];

  if (targets.length === 0) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({
        message: `Plan "${planId}" has no weekly set targets, so no volume status can be computed`,
      }),
    };
  }

  // Rest days are absent from the summary table, so the days that came back are
  // exactly the days trained — which is what the bonus-session test needs.
  const sessions = days.length;
  const status = muscleVolumeStatus(targets, rollUpSets(days), {
    days: window.days,
    sessions,
    sessionsPerWeek: plan.sessionsPerWeek,
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      asOf: asOf.toISOString(),
      window: bounds,
      plan: {
        planId: plan.planId,
        version: plan.version,
        name: plan.name,
        sessionsPerWeek: plan.sessionsPerWeek,
        // Which target set produced these verdicts. Null while a legacy version's
        // embedded targets are being used, which is itself worth seeing.
        targetsVersion: targetSet?.version ?? null,
      },
      sessions,
      bonusWindow: status.bonusWindow,
      muscles: status.muscles,
      untargeted: status.untargeted,
    }),
  };
};

/**
 * The newest stored version. Deliberately the same descending-Query-Limit-1
 * access get-workout-plan.ts uses for its no-argument read, so "current" means
 * the same thing on both endpoints — the padded sort key is what makes it one
 * cheap query rather than a partition scan.
 */
async function currentVersion(
  tableName: string,
  planId: string,
): Promise<PlanVersionItem | null> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'planId = :p AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':p': planId, ':prefix': PLAN_VERSION_PREFIX },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  return (result.Items?.[0] as PlanVersionItem | undefined) ?? null;
}

/** Day summaries within the window, paginated so a long window cannot truncate. */
async function dayTallies(tableName: string, from: string, to: string): Promise<DayTally[]> {
  const days: DayTally[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': SUMMARY_PK.day, ':from': from, ':to': to },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      days.push({
        date: String(item.sk),
        muscles: (item.muscles ?? {}) as Record<string, number>,
      });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return days;
}

/** The target set in force; null before the first one is published. */
async function currentTargets(
  tableName: string,
  planId: string,
): Promise<TargetSetItem | null> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'planId = :p AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':p': planId, ':prefix': PLAN_TARGET_PREFIX },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  return (result.Items?.[0] as TargetSetItem | undefined) ?? null;
}
