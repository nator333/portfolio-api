import { z } from 'zod';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  PLAN_VERSION_PREFIX,
  planVersionItem,
  planVersionSchema,
  type PlanVersionItem,
} from './workout-plan-schema';
import { applyPlanEdits, planEditSchema, revisionMetaSchema } from './workout-plan-edits';
import { corsHeaders } from './cors';

/**
 * Admin-only slot-level revision of the training program: read the current
 * version, apply the edits, publish the result as the next version.
 *
 * This is a convenience over update-workout-plan.ts, not a different storage
 * model — the write is the same conditional append, and history is still
 * immutable. What it buys is that changing two numbers costs two numbers on the
 * wire instead of the whole ~10KB document, and that consecutive versions differ
 * only where the lifter actually changed something, which is what makes the
 * history worth keeping.
 */

const region = process.env.WORKOUT_REGION;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}));

export const DEFAULT_PLAN_ID = 'upper-lower';

const requestSchema = revisionMetaSchema.extend({
  planId: z.string().optional(),
  /**
   * The version the caller believes is current. Optional, but supplying it is
   * what makes a revision safe against a concurrent one: without it the edits
   * silently apply to whatever is latest at the moment of the read, which may
   * not be what the caller looked at.
   */
  baseVersion: z.number().int().min(1).optional(),
  edits: z.array(planEditSchema).min(1),
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
        message: 'Revision request failed validation; nothing was written',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      }),
    };
  }

  const { planId = DEFAULT_PLAN_ID, baseVersion, edits, ...meta } = parsed.data;

  const current = await latestVersion(tableName, planId);
  if (!current) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({
        message: `No plan "${planId}" has been published; use update_workout_plan to create version 1`,
      }),
    };
  }

  if (baseVersion !== undefined && baseVersion !== current.version) {
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        message: `Plan "${planId}" is at version ${current.version}, not the ${baseVersion} these edits were written against`,
        latestVersion: current.version,
      }),
    };
  }

  const { sk: _ignoredSk, ...base } = current;
  const applied = applyPlanEdits(base, edits, meta);
  if (!applied.ok) {
    return { statusCode: 400, headers, body: JSON.stringify({ message: applied.error }) };
  }

  // Re-validate the whole document, not just the edited slots: a patch can break
  // an invariant that spans them (a duplicated position, a min above its max).
  const candidate = planVersionSchema.safeParse({
    ...applied.plan,
    createdAt: new Date().toISOString(),
  });
  if (!candidate.success) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        message: 'The edited plan is not valid; nothing was written',
        issues: candidate.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      }),
    };
  }

  const item = planVersionItem(candidate.data);
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
    // Someone published between the read above and this write.
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        message: `Version ${item.version} of plan "${planId}" was published while these edits were being applied; re-read and retry`,
      }),
    };
  }

  return {
    statusCode: 201,
    headers,
    body: JSON.stringify({
      planId: item.planId,
      version: item.version,
      basedOn: current.version,
      editsApplied: edits.length,
      createdAt: item.createdAt,
    }),
  };
};

async function latestVersion(tableName: string, planId: string): Promise<PlanVersionItem | null> {
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
