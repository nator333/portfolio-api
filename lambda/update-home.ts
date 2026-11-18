import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { HOME_TABLE_ITEM_ID, homeDataSchema } from './home-schema';
import { corsHeaders } from './cors';
import { etag, ifMatch, preconditionFailed, putVersioned } from './content-version';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.CV_TABLE_NAME;
  if (!tableName) {
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'CV_TABLE_NAME is not configured' }) };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Request body must be valid JSON' }) };
  }

  const validation = homeDataSchema.safeParse(parsedBody);
  if (!validation.success) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Invalid home data', errors: validation.error.issues }),
    };
  }

  // `If-Match` is optional here (the front-end's editors save without it);
  // when sent, a document changed since that version is refused with 412.
  const version = await putVersioned(ddb, tableName, HOME_TABLE_ITEM_ID, validation.data, ifMatch(event));
  if (version === null) return preconditionFailed(headers, 'home');

  return { statusCode: 200, headers: { ...headers, ETag: etag(version) }, body: JSON.stringify(validation.data) };
};
