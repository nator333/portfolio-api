import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  MEDIA_MAX_UPLOAD_BYTES,
  createUploadRequestSchema,
  incomingKey,
} from './media-schema';
import { corsHeaders } from './cors';

const s3 = new S3Client({});

/**
 * Admin-only (Cognito-gated at the gateway): hands the SPA a short-lived
 * presigned POST so the browser uploads straight to the private ingest bucket.
 * The size cap and content-type are enforced as S3 policy conditions here, so a
 * tampered client cannot exceed them. The S3 ObjectCreated event on the
 * `incoming/` prefix then drives the resize pipeline.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const bucket = process.env.MEDIA_BUCKET_NAME;
  if (!bucket) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'MEDIA_BUCKET_NAME is not configured' }),
    };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Request body must be valid JSON' }) };
  }

  const validation = createUploadRequestSchema.safeParse(parsedBody);
  if (!validation.success) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Invalid upload request', errors: validation.error.issues }),
    };
  }

  const { filename, contentType, category } = validation.data;
  const assetId = randomUUID();
  const key = incomingKey(assetId, filename);

  const presigned = await createPresignedPost(s3, {
    Bucket: bucket,
    Key: key,
    Conditions: [
      ['content-length-range', 1, MEDIA_MAX_UPLOAD_BYTES],
      ['eq', '$Content-Type', contentType],
      // Category rides along on the object so the resize Lambda can carry it into
      // the catalog without a second round trip.
      ['eq', '$x-amz-meta-category', category],
      ['eq', '$x-amz-meta-original-filename', filename],
    ],
    Fields: {
      'Content-Type': contentType,
      'x-amz-meta-category': category,
      'x-amz-meta-original-filename': filename,
    },
    Expires: 300,
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ assetId, key, upload: presigned }),
  };
};
