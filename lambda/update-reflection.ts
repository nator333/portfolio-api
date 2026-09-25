import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  isReflectionId,
  toReflection,
  updateReflectionSchema,
  type ReflectionItem,
} from './reflection-schema';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Correct an existing reflection's body and/or themes. Admin only.
 *
 * For fixing a note, not for rewriting history: the type and date are the
 * note's key and stay as they were, and the update is guarded so a wrong id is
 * a clean 404 rather than an upsert that conjures a note out of nothing.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.REFLECTIONS_TABLE_NAME;
  if (!tableName) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'REFLECTIONS_TABLE_NAME is not configured' }),
    };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Request body must be valid JSON' }) };
  }

  const validation = updateReflectionSchema.safeParse(parsedBody);
  if (!validation.success) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Invalid reflection update', errors: validation.error.issues }),
    };
  }

  const { type, id, body, themes } = validation.data;
  if (!isReflectionId(id)) {
    return { statusCode: 404, headers, body: JSON.stringify({ message: `No ${type} reflection "${id}"` }) };
  }

  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };
  const sets = ['#updatedAt = :updatedAt'];
  if (body !== undefined) {
    names['#body'] = 'body';
    values[':body'] = body;
    sets.push('#body = :body');
  }
  if (themes !== undefined) {
    names['#themes'] = 'themes';
    values[':themes'] = themes;
    sets.push('#themes = :themes');
  }

  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { type, sk: id },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(sk)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(toReflection(result.Attributes as ReflectionItem)),
    };
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return { statusCode: 404, headers, body: JSON.stringify({ message: `No ${type} reflection "${id}"` }) };
    }
    throw error;
  }
};
