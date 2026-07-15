import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PROJECTS_TABLE_ITEM_ID } from './projects-schema';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.CV_TABLE_NAME;
  if (!tableName) {
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'CV_TABLE_NAME is not configured' }) };
  }

  const result = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { id: PROJECTS_TABLE_ITEM_ID } }),
  );

  // A list resource returns an empty collection rather than 404 when unset.
  if (!result.Item) {
    return { statusCode: 200, headers, body: JSON.stringify({ projects: [] }) };
  }

  const { id, ...projectsData } = result.Item;

  return { statusCode: 200, headers, body: JSON.stringify(projectsData) };
};
