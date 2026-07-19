import { homeDataSchema, MAX_MOTTO_COUNT, MAX_MOTTO_LENGTH } from '../lambda/home-schema';

test('accepts a valid home document', () => {
  const data = { mottoes: ['Scream Dependencies', 'Hide Complexities'] };
  expect(homeDataSchema.safeParse(data).success).toBe(true);
});

test('accepts the maximum number of mottoes', () => {
  const data = { mottoes: Array.from({ length: MAX_MOTTO_COUNT }, (_, i) => `Motto ${i + 1}`) };
  expect(homeDataSchema.safeParse(data).success).toBe(true);
});

test('rejects an empty motto list', () => {
  expect(homeDataSchema.safeParse({ mottoes: [] }).success).toBe(false);
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
