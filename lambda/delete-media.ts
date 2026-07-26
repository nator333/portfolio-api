import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { MediaAsset } from './media-schema';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const cloudfront = new CloudFrontClient({});

/**
 * Admin delete (Cognito-gated): removes every stored variant, the catalog row,
 * and best-effort invalidates the CDN path. Order matters — S3 objects and the
 * catalog go first so the asset is gone even if invalidation fails; a stale
 * cache entry self-heals at the TTL, whereas an orphaned object would not.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.MEDIA_TABLE_NAME;
  const bucket = process.env.MEDIA_BUCKET_NAME;
  const distributionId = process.env.MEDIA_DISTRIBUTION_ID;
  if (!tableName || !bucket) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'MEDIA_TABLE_NAME and MEDIA_BUCKET_NAME must be configured' }),
    };
  }

  const assetId = event.pathParameters?.id;
  if (!assetId) {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Missing asset id' }) };
  }

  const existing = await ddb.send(new GetCommand({ TableName: tableName, Key: { assetId } }));
  if (!existing.Item) {
    return { statusCode: 404, headers, body: JSON.stringify({ message: 'Asset not found' }) };
  }
  const asset = existing.Item as MediaAsset;

  const objects = Object.values(asset.variants ?? {}).map((variant) => ({ Key: variant.key }));
  if (objects.length > 0) {
    await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
  }

  await ddb.send(new DeleteCommand({ TableName: tableName, Key: { assetId } }));

  // Best-effort: a failed invalidation must not fail the delete — the objects
  // are already gone and the cache entry expires on its own.
  if (distributionId) {
    try {
      await cloudfront.send(
        new CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: {
            CallerReference: `delete-${assetId}-${Date.now()}`,
            Paths: { Quantity: 1, Items: [`/${assetId}/*`] },
          },
        }),
      );
    } catch (error) {
      console.error('CloudFront invalidation failed for', assetId, error);
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify({ assetId, deleted: true }) };
};
