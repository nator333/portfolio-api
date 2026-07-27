import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { S3Event, S3Handler } from 'aws-lambda';
import sharp from 'sharp';
import {
  MEDIA_CATEGORIES,
  MEDIA_INCOMING_PREFIX,
  MEDIA_PRIMARY_VARIANT,
  MEDIA_VARIANTS,
  type MediaAsset,
  publicKey,
} from './media-schema';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

type Category = (typeof MEDIA_CATEGORIES)[number];

function asCategory(value: string | undefined): Category {
  return (MEDIA_CATEGORIES as readonly string[]).includes(value ?? '')
    ? (value as Category)
    : 'general';
}

/**
 * S3 ObjectCreated handler for the `incoming/` prefix. Decodes the upload once,
 * emits every WebP variant to the public prefix, records a catalog row, then
 * deletes the original so the ingest prefix never accumulates raw uploads.
 */
export const handler: S3Handler = async (event: S3Event): Promise<void> => {
  const bucket = process.env.MEDIA_BUCKET_NAME;
  const tableName = process.env.MEDIA_TABLE_NAME;
  const cdnBaseUrl = process.env.MEDIA_CDN_BASE_URL;
  if (!bucket || !tableName || !cdnBaseUrl) {
    throw new Error('MEDIA_BUCKET_NAME, MEDIA_TABLE_NAME and MEDIA_CDN_BASE_URL must be configured');
  }

  for (const record of event.Records) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    if (!key.startsWith(MEDIA_INCOMING_PREFIX)) {
      continue;
    }

    // Key shape is `incoming/<assetId>/<filename>`.
    const assetId = key.slice(MEDIA_INCOMING_PREFIX.length).split('/')[0];
    if (!assetId) {
      continue;
    }

    const original = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await original.Body!.transformToByteArray();
    const buffer = Buffer.from(bytes);
    const metadata = original.Metadata ?? {};

    const variants: MediaAsset['variants'] = {};
    for (const { label, width } of MEDIA_VARIANTS) {
      const { data, info } = await sharp(buffer)
        .rotate() // honour EXIF orientation before dropping metadata
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });

      const variantKey = publicKey(assetId, label);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: variantKey,
          Body: data,
          ContentType: 'image/webp',
          CacheControl: IMMUTABLE_CACHE,
        }),
      );

      variants[label] = {
        key: variantKey,
        url: `${cdnBaseUrl}/${assetId}/${label}.webp`,
        width: info.width,
        height: info.height,
      };
    }

    const asset: MediaAsset = {
      assetId,
      category: asCategory(metadata['category']),
      contentType: original.ContentType ?? 'application/octet-stream',
      originalFilename: metadata['original-filename'] ?? key.split('/').pop() ?? assetId,
      sizeBytes: buffer.byteLength,
      cdnUrl: variants[MEDIA_PRIMARY_VARIANT]?.url ?? '',
      variants,
      alt: '',
      title: '',
      uploadedAt: new Date().toISOString(),
    };

    await ddb.send(new PutCommand({ TableName: tableName, Item: asset }));

    // Ingest prefix is transient: drop the raw upload now that variants exist.
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
};
