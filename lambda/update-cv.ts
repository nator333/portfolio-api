import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CV_TABLE_ITEM_ID, cvDataSchema } from './cv-schema';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const tableName = process.env.CV_TABLE_NAME;
  if (!tableName) {
    return { statusCode: 500, body: JSON.stringify({ message: 'CV_TABLE_NAME is not configured' }) };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ message: 'Request body must be valid JSON' }) };
  }

  const validation = cvDataSchema.safeParse(parsedBody);
  if (!validation.success) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'Invalid CV data', errors: validation.error.issues }),
    };
  }

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: { id: CV_TABLE_ITEM_ID, ...validation.data },
    }),
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validation.data),
  };
};
