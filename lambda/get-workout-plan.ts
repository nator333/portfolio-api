import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  PLAN_TARGET_PREFIX,
  PLAN_VERSION_PREFIX,
  planVersionSk,
  versionInEffect,
  type PlanVersionItem,
  type TargetSetItem,
} from './workout-plan-schema';
import { corsHeaders } from './cors';

/**
 * Admin-only read of the training program: what the lifter is *meant* to do,
 * the counterpart to the logged sets get-workout-sets.ts serves.
 *
 * Four ways to ask, each mapped onto the cheapest access the key design allows:
 *
 *   (no args)        the current program — one descending Query, Limit 1
 *   version=N        one exact GetItem
 *   date=YYYY-MM-DD  the program in force that day — needs every version's
 *                    window, so one full-partition Query
 *   history=true     the version list, projected to metadata only
 *
 * A program accumulates a handful of versions per year, so the partition scans
 * are small by construction; if that ever stops being true, the date lookup is
 * the one to reach for a secondary index.
 *
 * A program is stored as two item types on two timelines — the menu and the
 * weekly set targets — but is *served* as one document, with the targets in
 * force composed onto the version being returned. Splitting the storage was
 * about letting the halves move independently, not about making every caller
 * assemble a program for itself. `targetsVersion` says which set was composed
 * in; for a date lookup it is the set in force on that date, so the answer to
 * "what was my program that day" stays a single call.
 */

const region = process.env.WORKOUT_REGION;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}));

/** The program served when the caller names none. */
export const DEFAULT_PLAN_ID = 'upper-lower';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Metadata returned by `history=true`, without the bulky session lists. */
interface VersionSummary {
  version: number;
  name: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  changeNote: string;
  createdAt: string;
}

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

  const params = event.queryStringParameters ?? {};
  const planId = params.planId?.trim() || DEFAULT_PLAN_ID;

  if (params.history === 'true') {
    const versions = await listVersions(tableName, planId);
    return { statusCode: 200, headers, body: JSON.stringify({ planId, versions }) };
  }

  if (params.version !== undefined) {
    const version = Number(params.version);
    if (!Number.isInteger(version) || version < 1) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: '`version` must be a positive integer' }),
      };
    }
    const [plan, targets] = await Promise.all([
      getVersion(tableName, planId, version),
      currentTargets(tableName, planId),
    ]);
    return respond(plan, headers, `No version ${version} of plan "${planId}"`, targets);
  }

  if (params.date !== undefined) {
    if (!DATE_RE.test(params.date)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: '`date` must be YYYY-MM-DD' }),
      };
    }
    const [all, targetSets] = await Promise.all([
      allVersions(tableName, planId),
      allTargetSets(tableName, planId),
    ]);
    const plan = versionInEffect(all, params.date);
    // The targets in force *that day*, not today's — the whole point of asking
    // by date is what the program said at the time, and both halves have their
    // own effective windows.
    const targets = versionInEffect(targetSets, params.date) ?? latestOf(targetSets);
    return respond(
      plan,
      headers,
      `No version of plan "${planId}" was in effect on ${params.date}`,
      targets,
    );
  }

  const [plan, targets] = await Promise.all([
    latestStoredVersion(tableName, planId),
    currentTargets(tableName, planId),
  ]);
  return respond(plan, headers, `No plan "${planId}" has been published`, targets);
};

/**
 * Frames a found version, or a 404 when there is none. `sk` is dropped on the
 * way out: it is derivable from `version` and is storage detail the caller has
 * no use for.
 */
function respond(
  plan: PlanVersionItem | null,
  headers: Record<string, string>,
  notFound: string,
  targets: TargetSetItem | null = null,
): APIGatewayProxyResult {
  if (!plan) {
    return { statusCode: 404, headers, body: JSON.stringify({ message: notFound }) };
  }
  const { sk, weeklySetTargets: embedded, ...document } = plan;
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ...document,
      // The composed targets win; a legacy version's embedded copy is the
      // fallback until every such version has aged out.
      weeklySetTargets: targets?.weeklySetTargets ?? embedded ?? [],
      targetsVersion: targets?.version ?? null,
    }),
  };
}

/** The newest version: one descending Query, which is what the padded sk buys. */
async function latestStoredVersion(
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

async function getVersion(
  tableName: string,
  planId: string,
  version: number,
): Promise<PlanVersionItem | null> {
  const result = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { planId, sk: planVersionSk(version) } }),
  );
  return (result.Item as PlanVersionItem | undefined) ?? null;
}

/** Every version in full — only for the date lookup, which needs all windows. */
async function allVersions(tableName: string, planId: string): Promise<PlanVersionItem[]> {
  return queryPartition<PlanVersionItem>(tableName, planId);
}

/** Every version projected to metadata, so listing history stays cheap. */
async function listVersions(tableName: string, planId: string): Promise<VersionSummary[]> {
  const items = await queryPartition<VersionSummary>(tableName, planId, {
    // `name` and `version` are DynamoDB reserved words; alias every attribute
    // rather than remembering which ones need it.
    ProjectionExpression: '#v, #n, #from, #to, #note, #created',
    ExpressionAttributeNames: {
      '#v': 'version',
      '#n': 'name',
      '#from': 'effectiveFrom',
      '#to': 'effectiveTo',
      '#note': 'changeNote',
      '#created': 'createdAt',
    },
  });
  return items.sort((a, b) => a.version - b.version);
}

async function queryPartition<T>(
  tableName: string,
  planId: string,
  extra: {
    ProjectionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
  } = {},
): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'planId = :p AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':p': planId, ':prefix': PLAN_VERSION_PREFIX },
        ExclusiveStartKey: exclusiveStartKey,
        ...extra,
      }),
    );
    items.push(...((result.Items ?? []) as T[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
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

/** Every target set, for the date lookup, which needs all the windows. */
async function allTargetSets(tableName: string, planId: string): Promise<TargetSetItem[]> {
  const items: TargetSetItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'planId = :p AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':p': planId, ':prefix': PLAN_TARGET_PREFIX },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as TargetSetItem[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

/**
 * Newest set, used when no window covers the requested date. Target sets are
 * typically open-ended on both ends, so this is the common path rather than an
 * edge case: falling back to "the ones we have" beats reporting none.
 */
const latestOf = (sets: readonly TargetSetItem[]): TargetSetItem | null =>
  sets.reduce<TargetSetItem | null>((best, s) => (!best || s.version > best.version ? s : best), null);
