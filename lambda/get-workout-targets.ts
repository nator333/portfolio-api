import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  PLAN_TARGET_PREFIX,
  PLAN_VERSION_PREFIX,
  plannedWeeklySets,
  type PlanVersionItem,
  type TargetSetItem,
} from './workout-plan-schema';
import { MUSCLE_GROUPS } from './workout-muscles';
import { corsHeaders } from './cors';

/**
 * Admin read of the weekly set targets, for the page that edits them.
 *
 * Deliberately more than just the stored target set. A target is an intent
 * statement, and the one thing that makes it wrong is contradicting the menu it
 * is supposed to serve — so the editor is handed what the rotation actually
 * prescribes beside each target, and can say "the program asks for 14 here"
 * while you type rather than letting the save come back refused. The write path
 * still enforces it; this is so the rule is visible before it bites.
 *
 * The muscle vocabulary rides along for the same reason every other consumer
 * stopped keeping its own copy: a page offering "add a target for…" needs the
 * list, and a list hard-coded in the page is a list that drifts.
 */

const region = process.env.WORKOUT_REGION;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}));

export const DEFAULT_PLAN_ID = 'upper-lower';

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.WORKOUT_PLAN_TABLE_NAME;
  if (!tableName) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'WORKOUT_PLAN_TABLE_NAME is not configured' }),
    };
  }

  const planId = event.queryStringParameters?.planId?.trim() || DEFAULT_PLAN_ID;

  const [menu, targets] = await Promise.all([
    latest<PlanVersionItem>(tableName, planId, PLAN_VERSION_PREFIX),
    latest<TargetSetItem>(tableName, planId, PLAN_TARGET_PREFIX),
  ]);

  if (!menu) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ message: `No plan "${planId}" has been published` }),
    };
  }

  // Falls back to a legacy version's embedded copy, as every other reader does,
  // so the editor opens correctly on a plan whose targets have not been split
  // out yet — and reports version 0, meaning "none stored", which is also the
  // `baseVersion` the write path expects in that case.
  const weeklySetTargets = targets?.weeklySetTargets ?? menu.weeklySetTargets ?? [];

  const rotation = plannedWeeklySets(menu);
  const withBonus = plannedWeeklySets(menu, { includeBonus: true });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      planId,
      version: targets?.version ?? 0,
      weeklySetTargets,
      changeNote: targets?.changeNote ?? '',
      createdAt: targets?.createdAt ?? null,
      menu: {
        version: menu.version,
        name: menu.name,
        sessionsPerWeek: menu.sessionsPerWeek,
        /** Sets per muscle the rotation prescribes — the ceiling a target may not sit below. */
        prescribed: rotation,
        /** The same with the bonus session added, which `bonusWeekSets` answers to. */
        prescribedWithBonus: withBonus,
      },
      /** The muscle vocabulary, so the editor never hard-codes it. */
      muscles: MUSCLE_GROUPS,
    }),
  };
};

async function latest<T>(
  tableName: string,
  planId: string,
  prefix: string,
): Promise<T | null> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'planId = :p AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':p': planId, ':prefix': prefix },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  return (result.Items?.[0] as T | undefined) ?? null;
}
