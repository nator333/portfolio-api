import { z } from 'zod';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  PLAN_TARGET_PREFIX,
  PLAN_VERSION_PREFIX,
  planVersionItem,
  planVersionSchema,
  targetSetItem,
  targetSetSchema,
  type PlanVersionItem,
  type TargetSetItem,
} from './workout-plan-schema';
import {
  applyPlanEdits,
  applyTargetEdits,
  planEditSchema,
  revisionMetaSchema,
  type PlanEdit,
} from './workout-plan-edits';
import { checkMenuAgainstTargets, describeBreach } from './workout-plan-compliance';
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
 *
 * A program has two halves on two timelines: the menu (sessions and rotation)
 * and the weekly set targets. Edits are routed by op — slot edits append a menu
 * version, target edits append a target set — and a revision touching both is
 * written as a single transaction, because a revision that half-lands is exactly
 * the state that let the two contradict each other in the first place.
 *
 * Menu edits are checked against the targets in force before being written. The
 * dependency is one-way by design: a menu must respect the targets, so a
 * rotation that would prescribe more than the intent allows is refused.
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
  /** The same guard for the targets, which move on their own sequence. */
  baseTargetsVersion: z.number().int().min(0).optional(),
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

  const { planId = DEFAULT_PLAN_ID, baseVersion, baseTargetsVersion, edits, ...meta } = parsed.data;

  // Routed by op, because the two families address different documents on
  // different timelines. A revision may carry both.
  const menuEdits = edits.filter(
    (e): e is Exclude<PlanEdit, { op: 'set-target' | 'remove-target' }> =>
      e.op !== 'set-target' && e.op !== 'remove-target',
  );
  const targetEdits = edits.filter(
    (e): e is Extract<PlanEdit, { op: 'set-target' | 'remove-target' }> =>
      e.op === 'set-target' || e.op === 'remove-target',
  );

  const [current, currentTargets] = await Promise.all([
    latestVersion(tableName, planId),
    latestTargetSet(tableName, planId),
  ]);

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

  // The targets move on their own sequence, so they get their own guard. A
  // caller that read version 3 of the targets and edits them must be refused if
  // someone published 4 in between, exactly as for the menu.
  const currentTargetsVersion = currentTargets?.version ?? 0;
  if (baseTargetsVersion !== undefined && baseTargetsVersion !== currentTargetsVersion) {
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        message: `Plan "${planId}" targets are at version ${currentTargetsVersion}, not the ${baseTargetsVersion} these edits were written against`,
        latestTargetsVersion: currentTargetsVersion,
      }),
    };
  }

  const now = new Date().toISOString();

  // --- the menu half -------------------------------------------------------
  let menuItem: PlanVersionItem | null = null;
  const { sk: _ignoredSk, ...base } = current;
  let nextMenu: typeof base = base;

  if (menuEdits.length > 0) {
    const applied = applyPlanEdits(base, menuEdits, meta);
    if (!applied.ok) {
      return { statusCode: 400, headers, body: JSON.stringify({ message: applied.error }) };
    }

    // Re-validate the whole document, not just the edited slots: a patch can break
    // an invariant that spans them (a duplicated position, a min above its max).
    const candidate = planVersionSchema.safeParse({ ...applied.plan, createdAt: now });
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
    menuItem = planVersionItem(candidate.data);
    nextMenu = candidate.data;
  }

  // --- the targets half ----------------------------------------------------
  let targetItem: TargetSetItem | null = null;
  let nextTargets = currentTargets?.weeklySetTargets ?? [];

  if (targetEdits.length > 0) {
    const applied = applyTargetEdits(nextTargets, targetEdits);
    if (!applied.ok) {
      return { statusCode: 400, headers, body: JSON.stringify({ message: applied.error }) };
    }
    const candidate = targetSetSchema.safeParse({
      planId,
      version: currentTargetsVersion + 1,
      weeklySetTargets: applied.targets,
      effectiveFrom: currentTargets?.effectiveFrom ?? null,
      effectiveTo: currentTargets?.effectiveTo ?? null,
      changeNote: meta.changeNote,
      createdAt: now,
    });
    if (!candidate.success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          message: 'The edited targets are not valid; nothing was written',
          issues: candidate.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
      };
    }
    targetItem = targetSetItem(candidate.data);
    nextTargets = candidate.data.weeklySetTargets;
  }

  if (!menuItem && !targetItem) {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'No edits were supplied' }) };
  }

  // --- the one-way dependency ---------------------------------------------
  // Checked on the *result* of both halves, so a revision that raises a target
  // and adds the slots to match passes as one coherent change, while either on
  // its own is judged against what the other actually says.
  const warnings: string[] = [];
  if (nextTargets.length > 0) {
    const { breaches, bonusWarnings } = checkMenuAgainstTargets(nextMenu, nextTargets);
    if (breaches.length > 0) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          message:
            'This revision would leave the menu prescribing more volume than the targets allow; ' +
            'nothing was written. Raise the target in the same revision if the extra volume is ' +
            'intended, or cut slots from the sessions.',
          breaches: breaches.map(describeBreach),
        }),
      };
    }
    warnings.push(...bonusWarnings.map((b) => `On a bonus week, ${describeBreach(b)}.`));
  }

  // --- the write -----------------------------------------------------------
  // Both halves go in one transaction when both changed: a half-applied
  // revision is the very state this split exists to prevent.
  const items = [menuItem, targetItem].filter((i): i is NonNullable<typeof i> => i !== null);
  try {
    if (items.length === 1) {
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: items[0],
          ConditionExpression: 'attribute_not_exists(sk)',
        }),
      );
    } else {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: items.map((Item) => ({
            Put: { TableName: tableName, Item, ConditionExpression: 'attribute_not_exists(sk)' },
          })),
        }),
      );
    }
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name !== 'ConditionalCheckFailedException' && name !== 'TransactionCanceledException') {
      throw error;
    }
    // Someone published between the read above and this write.
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        message: `Plan "${planId}" moved while these edits were being applied; re-read and retry`,
      }),
    };
  }

  return {
    statusCode: 201,
    headers,
    body: JSON.stringify({
      planId,
      ...(menuItem ? { version: menuItem.version, basedOn: current.version } : {}),
      ...(targetItem
        ? { targetsVersion: targetItem.version, targetsBasedOn: currentTargetsVersion }
        : {}),
      editsApplied: edits.length,
      createdAt: now,
      ...(warnings.length > 0 ? { warnings } : {}),
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

/** The target set in force, or null before the first one is published. */
async function latestTargetSet(
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
