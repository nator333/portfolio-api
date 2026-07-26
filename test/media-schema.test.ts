import {
  MEDIA_ALLOWED_CONTENT_TYPES,
  MEDIA_INCOMING_PREFIX,
  MEDIA_MAX_UPLOAD_BYTES,
  MEDIA_PUBLIC_PREFIX,
  createUploadRequestSchema,
  incomingKey,
  publicKey,
  sanitizeFilename,
  updateMediaRequestSchema,
} from '../lambda/media-schema';

const baseRequest = {
  filename: 'my-eye-catch.png',
  contentType: 'image/png',
  category: 'blog',
};

test('accepts a valid upload request', () => {
  expect(createUploadRequestSchema.safeParse(baseRequest).success).toBe(true);
});

test('defaults category to general when omitted', () => {
  const { category, ...request } = baseRequest;
  const parsed = createUploadRequestSchema.safeParse(request);
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.category).toBe('general');
  }
});

test('rejects a content type outside the image allowlist', () => {
  const request = { ...baseRequest, contentType: 'application/pdf' };
  expect(createUploadRequestSchema.safeParse(request).success).toBe(false);
});

test('every allowed content type is an image', () => {
  for (const type of MEDIA_ALLOWED_CONTENT_TYPES) {
    expect(type.startsWith('image/')).toBe(true);
  }
});

test('rejects an empty filename', () => {
  const request = { ...baseRequest, filename: '' };
  expect(createUploadRequestSchema.safeParse(request).success).toBe(false);
});

test('rejects an unknown category', () => {
  const request = { ...baseRequest, category: 'invoices' };
  expect(createUploadRequestSchema.safeParse(request).success).toBe(false);
});

test('caps uploads at 10MB', () => {
  expect(MEDIA_MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
});

test('sanitizeFilename strips path separators and unsafe characters', () => {
  expect(sanitizeFilename('../../etc/passwd')).toBe('etc-passwd');
  expect(sanitizeFilename('my photo (1).PNG')).toBe('my-photo-1.PNG');
  expect(sanitizeFilename('a\\b/c.png')).toBe('a-b-c.png');
});

test('incomingKey lands under the incoming prefix and never trusts the raw name', () => {
  const key = incomingKey('abc-123', '../../evil.png');
  expect(key.startsWith(MEDIA_INCOMING_PREFIX)).toBe(true);
  expect(key).toBe(`${MEDIA_INCOMING_PREFIX}abc-123/evil.png`);
});

test('publicKey lands under the public prefix with the variant label', () => {
  const key = publicKey('abc-123', 'w1600');
  expect(key.startsWith(MEDIA_PUBLIC_PREFIX)).toBe(true);
  expect(key).toBe(`${MEDIA_PUBLIC_PREFIX}abc-123/w1600.webp`);
});

test('accepts a metadata update of a single field', () => {
  expect(updateMediaRequestSchema.safeParse({ alt: 'A dog' }).success).toBe(true);
  expect(updateMediaRequestSchema.safeParse({ title: 'Hero', category: 'blog' }).success).toBe(true);
});

test('rejects an empty metadata update (nothing to change)', () => {
  expect(updateMediaRequestSchema.safeParse({}).success).toBe(false);
});

test('rejects an unknown category in a metadata update', () => {
  expect(updateMediaRequestSchema.safeParse({ category: 'invoices' }).success).toBe(false);
});

test('rejects an over-long alt text', () => {
  expect(updateMediaRequestSchema.safeParse({ alt: 'x'.repeat(501) }).success).toBe(false);
});
