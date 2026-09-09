import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PLAN_VERSION_PREFIX, planVersionItem, planVersionSchema } from './workout-plan-schema';
import { corsHeaders } from './cors';

/**
 * Admin-only publish of a training-program version.
 *
 * Deliberately *not* the replace-the-document write the other update_ handlers
 * perform. A program's history is the point of this table — "which program was I
 * running when I logged this?" is unanswerable once a revision overwrites its
 * predecessor — so every write is an append: the caller supplies the full
 * document with the next `version`, and the put is conditional on that version
 * not already existing. A repeat of the same call is refused, not absorbed,
 * which is exactly what makes a retried or duplicated agent call harmless.
 *
 * `createdAt` is stamped here rather than taken from the caller: when a version
 * was published is a fact about the server, and letting a client assert it would
 * let a mistaken clock reorder the history.
 */

const region = process.env.WORKOUT_REGION;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}));

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
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Body must be a plan document object' }),
    };
  }

  // `sk` is derived from the version, never supplied; drop it before validating
  // so a document round-tripped straight back from the read tool is accepted.
  const { sk: _ignoredSk, ...document } = body as Record<string, unknown>;
  const candidate = { ...document, createdAt: new Date().toISOString() };

  const parsed = planVersionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        message: 'Plan document failed validation; nothing was written',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      }),
    };
  }

  const item = planVersionItem(parsed.data);

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
    // Only on the conflict path is it worth a second round trip: naming the
    // version that already exists is what turns "rejected" into "send N+1".
    const latest = await latestVersionNumber(tableName, item.planId);
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        message: `Version ${item.version} of plan "${item.planId}" already exists and versions are immutable`,
        latestVersion: latest,
        nextVersion: latest === null ? item.version : latest + 1,
      }),
    };
  }

  return {
    statusCode: 201,
    headers,
    body: JSON.stringify({
      planId: item.planId,
      version: item.version,
      createdAt: item.createdAt,
    }),
  };
};

async function latestVersionNumber(tableName: string, planId: string): Promise<number | null> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'planId = :p AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':p': planId, ':prefix': PLAN_VERSION_PREFIX },
      ProjectionExpression: '#v',
      ExpressionAttributeNames: { '#v': 'version' },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const version = result.Items?.[0]?.version;
  return typeof version === 'number' ? version : null;
}
