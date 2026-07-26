import { z } from 'zod';

/**
 * Media uploads are admin-only (Cognito-gated) but still validated and bounded:
 * the presigned POST is the one place a browser talks directly to S3, so the
 * content-type allowlist and size cap below are enforced as S3 policy conditions
 * rather than trusted from the client.
 */

/** Hard ceiling on a single upload, mirrored into the presigned POST conditions. */
export const MEDIA_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Only raster image types the resize pipeline (sharp) can decode. */
export const MEDIA_ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

/** Where an uploaded image is meant to be used; purely organisational metadata. */
export const MEDIA_CATEGORIES = ['blog', 'project', 'general'] as const;

/** Raw uploads land here; the resize Lambda consumes and then deletes them. */
export const MEDIA_INCOMING_PREFIX = 'incoming/';
/** Optimised, CloudFront-served output lives here. */
export const MEDIA_PUBLIC_PREFIX = 'public/';

/**
 * Variants the resize pipeline emits, all WebP. `w1600` is the eye-catch/project
 * image; `thumb` backs list and picker views. Widths are an upper bound —
 * smaller originals are never enlarged.
 */
export const MEDIA_VARIANTS = [
  { label: 'w1600', width: 1600 },
  { label: 'thumb', width: 400 },
] as const;

/** The variant a stored asset's primary `cdnUrl` points at. */
export const MEDIA_PRIMARY_VARIANT = 'w1600';

export const createUploadRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.enum(MEDIA_ALLOWED_CONTENT_TYPES),
  category: z.enum(MEDIA_CATEGORIES).default('general'),
});

export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;

const variantSchema = z.object({
  key: z.string(),
  url: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/** One row in the MediaAssets catalog table (PK `assetId`). */
export const mediaAssetSchema = z.object({
  assetId: z.string(),
  category: z.enum(MEDIA_CATEGORIES),
  contentType: z.string(),
  originalFilename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  cdnUrl: z.string(),
  variants: z.record(z.string(), variantSchema),
  alt: z.string().default(''),
  title: z.string().default(''),
  uploadedAt: z.string(),
});

export type MediaAsset = z.infer<typeof mediaAssetSchema>;

/**
 * Reduce a client-supplied filename to a safe key segment: strip path traversal,
 * collapse separators and unsafe characters to single dashes, and keep it out of
 * the way of the object-key prefix structure. Never trusted as-is.
 */
export function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/\\/g, '/') // normalise Windows separators
    .replace(/(\.\.?\/)+/g, '') // drop ./ and ../ traversal segments
    .replace(/\//g, '-') // remaining separators become dashes
    .replace(/[^A-Za-z0-9._-]/g, '-') // spaces, parens, etc.
    .replace(/-+/g, '-') // collapse runs of dashes
    .replace(/-+\./g, '.') // no dash right before the extension dot
    .replace(/^-+|-+$/g, ''); // trim edge dashes
  return cleaned || 'file';
}

/** Incoming object key for a fresh upload: `incoming/<assetId>/<safe-name>`. */
export function incomingKey(assetId: string, filename: string): string {
  return `${MEDIA_INCOMING_PREFIX}${assetId}/${sanitizeFilename(filename)}`;
}

/** Public (CloudFront-served) key for a resized variant: `public/<assetId>/<label>.webp`. */
export function publicKey(assetId: string, variantLabel: string): string {
  return `${MEDIA_PUBLIC_PREFIX}${assetId}/${variantLabel}.webp`;
}
