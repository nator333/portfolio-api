import { z } from 'zod';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  PLAN_TARGET_PREFIX,
  PLAN_VERSION_PREFIX,
  targetSetItem,
  targetSetSchema,
  weeklySetTargetSchema,
  type PlanVersionItem,
  type TargetSetItem,
} from './workout-plan-schema';
import { checkMenuAgainstTargets, describeBreach } from './workout-plan-compliance';
import { corsHeaders } from './cors';

/**
 * Admin write of the weekly set targets, for the page that edits them.
 *
 * Takes the whole target list rather than a patch, because that is what an
 * editor holds: the page loads every entry, the user changes some of them, and
 * the result is what they mean the targets to be. The append-only versioning is
 * unchanged — this publishes the next target set, it never edits one — so the
 * history still answers "what was I aiming at when I logged this?".
 *
 * `baseVersion` is required, not optional as it is on the MCP revision tool. A
 * form is filled in over minutes and submitted against a version that was read
 * at the start of them, so a blind write here would quietly discard whatever
 * was published in between; on the MCP path the caller reads and writes in one
 * breath and can reasonably decline the guard. Version 0 means "nothing stored
 * yet", which is what the read returns for a plan whose targets have not been
 * split out of the menu.
 *
 * The one-way rule between a program's halves is enforced here as it is
 * everywhere else: a target the current menu already exceeds is refused, and the
 * response names the muscles so the page can point at them.
 */

const region = process.env.WORKOUT_REGION;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}));

export const DEFAULT_PLAN_ID = 'upper-lower';

const requestSchema = z.object({
  planId: z.string().optional(),
  /** The version the editor loaded; 0 when the plan had no stored target set. */
  baseVersion: z.number().int().min(0),
  changeNote: z.string().trim().min(1, 'a revision must say what changed and why'),
  weeklySetTargets: z.array(weeklySetTargetSchema).min(1),
  effectiveFrom: z.string().nullable().optional(),
  effectiveTo: z.string().nullable().optional(),
});

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

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Body must be valid JSON' }) };
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        message: 'Target set failed validation; nothing was written',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      }),
    };
  }

  const { planId = DEFAULT_PLAN_ID, baseVersion, changeNote, weeklySetTargets } = parsed.data;

  const [menu, current] = await Promise.all([
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

  const currentVersion = current?.version ?? 0;
  if (baseVersion !== currentVersion) {
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        message:
          `These targets were edited against version ${baseVersion}, but the plan is now at ` +
          `${currentVersion}. Reload so the change is applied on top of what is stored.`,
        latestVersion: currentVersion,
      }),
    };
  }

  const { breaches, bonusWarnings } = checkMenuAgainstTargets(menu, weeklySetTargets);
  if (breaches.length > 0) {
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        message:
          'These targets sit below what the training sessions already prescribe; nothing was ' +
          'written. Raise the target, or cut slots from the sessions first.',
        breaches: breaches.map(describeBreach),
      }),
    };
  }

  const candidate = targetSetSchema.safeParse({
    planId,
    version: currentVersion + 1,
    weeklySetTargets,
    effectiveFrom: parsed.data.effectiveFrom ?? current?.effectiveFrom ?? null,
    effectiveTo: parsed.data.effectiveTo ?? current?.effectiveTo ?? null,
    changeNote,
    createdAt: new Date().toISOString(),
  });
  if (!candidate.success) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        message: 'Target set failed validation; nothing was written',
        issues: candidate.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      }),
    };
  }

  const item = targetSetItem(candidate.data);
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(sk)',
      }),
    );
  } catch (error) {
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    // Published between the read above and this write; the version guard above
    // cannot see that window, so the conditional put is what actually closes it.
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        message: `Version ${item.version} was published while this edit was being saved; reload and retry`,
      }),
    };
  }

  return {
    statusCode: 201,
    headers,
    body: JSON.stringify({
      planId: item.planId,
      version: item.version,
      basedOn: currentVersion,
      createdAt: item.createdAt,
      ...(bonusWarnings.length > 0
        ? { warnings: bonusWarnings.map((b) => `On a bonus week, ${describeBreach(b)}.`) }
        : {}),
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
