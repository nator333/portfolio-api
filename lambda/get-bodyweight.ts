import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { BODYWEIGHT_ITEM_ID, type MonthlyBodyweight } from './bodyweight-schema';
import { corsHeaders } from './cors';

/**
 * Public monthly bodyweight for the Training page.
 *
 * Serves the snapshot bodyweight-ingest writes, as-is: monthly averages only,
 * already filtered to months with enough weigh-ins. This handler has no
 * Google Health access and needs none. An empty list (before the first ingest,
 * or on a deployment without one) is a normal answer, not an error, so the
 * page simply leaves the chart out.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };
  const tableName = process.env.CV_TABLE_NAME;
  if (!tableName) {
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'CV_TABLE_NAME is not configured' }) };
  }

  const result = await ddb.send(new GetCommand({ TableName: tableName, Key: { id: BODYWEIGHT_ITEM_ID } }));
  const months = (result.Item?.months ?? []) as MonthlyBodyweight[];
  const updatedAt = typeof result.Item?.updatedAt === 'string' ? result.Item.updatedAt : null;

  return { statusCode: 200, headers, body: JSON.stringify({ months, updatedAt }) };
};
