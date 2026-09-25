import {
  homeDataSchema,
  MAX_BACKGROUND_CAPTION_LENGTH,
  MAX_BACKGROUND_COUNT,
  MAX_MOTTO_COUNT,
  MAX_MOTTO_LENGTH,
} from '../lambda/home-schema';

const photo = {
  url: 'https://cdn.example.com/abc/w2560.webp',
  caption: 'Mt. Hakkai, Minamiuonuma',
  alt: 'Snow-capped Mt. Hakkai at dawn',
};

test('accepts a valid home document', () => {
  const data = { mottoes: ['Scream Dependencies', 'Hide Complexities'] };
  expect(homeDataSchema.safeParse(data).success).toBe(true);
});

test('accepts the maximum number of mottoes', () => {
  const data = { mottoes: Array.from({ length: MAX_MOTTO_COUNT }, (_, i) => `Motto ${i + 1}`) };
  expect(homeDataSchema.safeParse(data).success).toBe(true);
});

test('accepts an empty motto list as a deliberate clear', () => {
  expect(homeDataSchema.safeParse({ mottoes: [] }).success).toBe(true);
});

test('accepts the mottoesHidden flag', () => {
  const data = { mottoes: ['Scream Dependencies'], mottoesHidden: true };
  expect(homeDataSchema.safeParse(data).success).toBe(true);
});

test('rejects more mottoes than the layout supports', () => {
  const data = { mottoes: Array.from({ length: MAX_MOTTO_COUNT + 1 }, (_, i) => `Motto ${i + 1}`) };
  expect(homeDataSchema.safeParse(data).success).toBe(false);
});

test('rejects an empty motto line', () => {
  expect(homeDataSchema.safeParse({ mottoes: [''] }).success).toBe(false);
});

test('rejects a motto line over the length limit', () => {
  const data = { mottoes: ['x'.repeat(MAX_MOTTO_LENGTH + 1)] };
  expect(homeDataSchema.safeParse(data).success).toBe(false);
});

test('accepts background photos', () => {
  const data = { mottoes: [], backgrounds: [photo, { url: photo.url, caption: '' }] };
  expect(homeDataSchema.safeParse(data).success).toBe(true);
});

test('rejects more background photos than the cap', () => {
  const data = { mottoes: [], backgrounds: Array.from({ length: MAX_BACKGROUND_COUNT + 1 }, () => photo) };
  expect(homeDataSchema.safeParse(data).success).toBe(false);
});

test('rejects a non-https background url', () => {
  const data = { mottoes: [], backgrounds: [{ ...photo, url: 'http://cdn.example.com/a.webp' }] };
  expect(homeDataSchema.safeParse(data).success).toBe(false);
});

test('rejects a javascript: background url', () => {
  const data = { mottoes: [], backgrounds: [{ ...photo, url: 'javascript:alert(1)' }] };
  expect(homeDataSchema.safeParse(data).success).toBe(false);
});

test('rejects a background caption over the length limit', () => {
  const data = {
    mottoes: [],
    backgrounds: [{ ...photo, caption: 'x'.repeat(MAX_BACKGROUND_CAPTION_LENGTH + 1) }],
  };
  expect(homeDataSchema.safeParse(data).success).toBe(false);
});
