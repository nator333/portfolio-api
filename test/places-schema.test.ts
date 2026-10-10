import {
  MAX_MEMORIES,
  MAX_MEMORY_PHOTOS,
  MAX_MEMORY_TEXT_LENGTH,
  memorySchema,
  placesDataSchema,
} from '../lambda/places-schema';

const memory = {
  id: 'm_01',
  city: 'hachioji',
  x: 0.58,
  y: 0.53,
  name: 'JR Hachioji Station',
  kind: 'play',
  period: '2005–2008',
  text: 'Waited here every morning.',
  seasons: [],
  photos: ['https://cdn.example.com/abc/w1600.webp'],
  mapsUrl: 'https://www.google.com/maps/place/Hachioji+Station/@35.6556,139.339,17z',
  lat: 35.6556,
  lng: 139.339,
  createdAt: 1_700_000_000_000,
};

test('accepts a memory placed from a Google Maps link', () => {
  expect(memorySchema.safeParse(memory).success).toBe(true);
});

test('accepts a hand-placed memory with no link, coordinates, photos or season', () => {
  const placed = { ...memory, mapsUrl: '', lat: null, lng: null, photos: [], seasons: [] };
  expect(memorySchema.safeParse(placed).success).toBe(true);
});

test('accepts a memory shown in several seasons', () => {
  expect(memorySchema.safeParse({ ...memory, seasons: ['summer', 'autumn'] }).success).toBe(true);
});

test('rejects a memory on a town that has no map', () => {
  expect(memorySchema.safeParse({ ...memory, city: 'tokyo' }).success).toBe(false);
});

test('rejects a pin outside the map', () => {
  expect(memorySchema.safeParse({ ...memory, x: 1.2 }).success).toBe(false);
});

test('rejects more photos than the carousel holds', () => {
  const photos = Array.from({ length: MAX_MEMORY_PHOTOS + 1 }, () => memory.photos[0]);
  expect(memorySchema.safeParse({ ...memory, photos }).success).toBe(false);
});

test('rejects a non-https photo url', () => {
  expect(memorySchema.safeParse({ ...memory, photos: ['http://cdn.example.com/a.webp'] }).success).toBe(false);
});

test('rejects a javascript: maps link', () => {
  expect(memorySchema.safeParse({ ...memory, mapsUrl: 'javascript:alert(1)' }).success).toBe(false);
});

test('rejects text over the length limit', () => {
  expect(memorySchema.safeParse({ ...memory, text: 'x'.repeat(MAX_MEMORY_TEXT_LENGTH + 1) }).success).toBe(false);
});

test('accepts a places document with town facts', () => {
  const data = {
    memories: [memory],
    cities: {
      hachioji: {
        period: '2005–2008',
        summary: 'Hachioji lies about 40 km west of central Tokyo.',
        population: '579,605 (2020 census)',
        knownFor: ['Mt. Takao'],
        food: ['Hachioji ramen'],
        source: 'https://en.wikipedia.org/wiki/Hachi%C5%8Dji',
        fetchedAt: '2026-10-10',
      },
    },
  };
  expect(placesDataSchema.safeParse(data).success).toBe(true);
});

test('accepts an empty memory list as a deliberate clear', () => {
  expect(placesDataSchema.safeParse({ memories: [] }).success).toBe(true);
});

test('rejects duplicate memory ids', () => {
  expect(placesDataSchema.safeParse({ memories: [memory, { ...memory, name: 'Again' }] }).success).toBe(false);
});

test('rejects facts for a town that has no map', () => {
  expect(placesDataSchema.safeParse({ memories: [], cities: { tokyo: { summary: 'x' } } }).success).toBe(false);
});

test('rejects more memories than one document holds', () => {
  const memories = Array.from({ length: MAX_MEMORIES + 1 }, (_, i) => ({ ...memory, id: `m_${i}` }));
  expect(placesDataSchema.safeParse({ memories }).success).toBe(false);
});
