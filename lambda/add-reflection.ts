import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { addReflectionSchema, toReflection, type ReflectionItem } from './reflection-schema';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Append a reflection note. Admin only (reached through the MCP server's gate).
 *
 * Always a new item: a note is never overwritten by adding another, so a
 * repeated call leaves two notes rather than silently replacing the first. The
 * guard on the put is belt and braces — a fresh uuid cannot collide — but it
 * turns the impossible case into a refusal instead of a lost note.
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

  const validation = addReflectionSchema.safeParse(parsedBody);
  if (!validation.success) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Invalid reflection', errors: validation.error.issues }),
    };
  }

  const { type, date, body, themes = [] } = validation.data;
  const item: ReflectionItem = {
    type,
    sk: `${date}#${randomUUID()}`,
    date,
    body,
    themes,
    createdAt: new Date().toISOString(),
  };

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(sk)',
    }),
  );

  return { statusCode: 201, headers, body: JSON.stringify(toReflection(item)) };
};
