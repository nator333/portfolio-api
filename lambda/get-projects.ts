import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PROJECTS_TABLE_ITEM_ID } from './projects-schema';
import { corsHeaders } from './cors';
import { INITIAL_VERSION, etag, splitVersion } from './content-version';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.CV_TABLE_NAME;
  if (!tableName) {
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'CV_TABLE_NAME is not configured' }) };
  }

  const result = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { id: PROJECTS_TABLE_ITEM_ID } }),
  );

  // A list resource returns an empty collection rather than 404 when unset.
  if (!result.Item) {
    headers.ETag = etag(INITIAL_VERSION);
    return { statusCode: 200, headers, body: JSON.stringify({ projects: [] }) };
  }

  // The version travels as the ETag, never in the document (see content-version.ts).
  const { version, rest: projectsData } = splitVersion(result.Item);
  headers.ETag = etag(version);

  return { statusCode: 200, headers, body: JSON.stringify(projectsData) };
};
