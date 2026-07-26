import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { MediaAsset } from './media-schema';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Admin media library (Cognito-gated): lists every catalog row, newest first.
 * A Scan is fine here — the catalog is a single admin's images, not a hot path —
 * and it paginates so a table that outgrows one page still returns in full.
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

  const assets: MediaAsset[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey }),
    );
    assets.push(...((page.Items ?? []) as MediaAsset[]));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  assets.sort((a, b) => (b.uploadedAt ?? '').localeCompare(a.uploadedAt ?? ''));

  return { statusCode: 200, headers, body: JSON.stringify({ assets }) };
};
