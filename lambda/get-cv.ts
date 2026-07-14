import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { CV_TABLE_ITEM_ID } from './cv-schema';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (): Promise<APIGatewayProxyResultV2> => {
  const tableName = process.env.CV_TABLE_NAME;
  if (!tableName) {
    return { statusCode: 500, body: JSON.stringify({ message: 'CV_TABLE_NAME is not configured' }) };
  }

  const result = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { id: CV_TABLE_ITEM_ID } }),
  );

  if (!result.Item) {
    return { statusCode: 404, body: JSON.stringify({ message: 'CV data not found' }) };
  }

  const { id, ...cvData } = result.Item;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cvData),
  };
};
