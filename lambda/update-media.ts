import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { updateMediaRequestSchema } from './media-schema';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Admin metadata edit (Cognito-gated): sets any of alt / title / category on an
 * existing asset. Only the fields present in the body are written, and the
 * update is guarded so a missing asset is a clean 404 rather than an upsert.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.MEDIA_TABLE_NAME;
  if (!tableName) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'MEDIA_TABLE_NAME is not configured' }),
    };
  }

  const assetId = event.pathParameters?.id;
  if (!assetId) {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Missing asset id' }) };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Request body must be valid JSON' }) };
  }

  const validation = updateMediaRequestSchema.safeParse(parsedBody);
  if (!validation.success) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Invalid media update', errors: validation.error.issues }),
    };
  }

  // Build the SET clause from only the fields that were supplied.
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  for (const [field, value] of Object.entries(validation.data)) {
    names[`#${field}`] = field;
    values[`:${field}`] = value;
    sets.push(`#${field} = :${field}`);
  }

  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { assetId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(assetId)',
        ReturnValues: 'ALL_NEW',
      }),
    );
    return { statusCode: 200, headers, body: JSON.stringify(result.Attributes) };
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return { statusCode: 404, headers, body: JSON.stringify({ message: 'Asset not found' }) };
    }
    throw error;
  }
};
