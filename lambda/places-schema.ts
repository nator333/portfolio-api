import { z } from 'zod';

// Stored in the same single-document table as the CV, under a distinct id.
export const PLACES_TABLE_ITEM_ID = 'places';

// The five towns the Places page draws. The front owns each town's map
// (terrain, landmarks, georeference); the API only needs to know the ids so a
// memory cannot point at a map that does not exist.
export const PLACE_CITY_IDS = ['minamiuonuma', 'hachioji', 'ichikawa', 'vancouver', 'montreal'] as const;
export type PlaceCityId = (typeof PLACE_CITY_IDS)[number];

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

// One pixel sprite per kind on the map; the enum is the sprite set.
export const MEMORY_KINDS = ['home', 'school', 'work', 'food', 'play', 'other'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

// A memory is a short caption on a map, not a blog post. The caps keep the
// whole page one DynamoDB item (400 KB) with room for a few hundred memories.
export const MAX_MEMORIES = 500;
export const MAX_MEMORY_NAME_LENGTH = 60;
export const MAX_MEMORY_PERIOD_LENGTH = 40;
export const MAX_MEMORY_TEXT_LENGTH = 1200;
export const MAX_MEMORY_PHOTOS = 3;
export const MAX_URL_LENGTH = 2048;

// Per-town prose: the Wikipedia-derived facts card plus the owner's own notes.
export const MAX_CITY_SUMMARY_LENGTH = 1000;
export const MAX_CITY_FACT_LENGTH = 80;
export const MAX_CITY_CHIPS = 6;

// Served straight into an <img src> / <a href>, so only https URLs are accepted.
const httpsUrlSchema = z.string().url().max(MAX_URL_LENGTH).startsWith('https://');

export const memorySchema = z.object({
  // Client-minted (the editor keeps ids stable across saves so photo links and
  // deep links to a memory survive edits).
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  city: z.enum(PLACE_CITY_IDS),
  // Pin position as a fraction of the map's width/height. When lat/lng are
  // set the front re-derives the position from them, but it still stores the
  // last derived x/y so a map whose georeference changes can be compared.
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  name: z.string().min(1).max(MAX_MEMORY_NAME_LENGTH),
  kind: z.enum(MEMORY_KINDS),
  period: z.string().max(MAX_MEMORY_PERIOD_LENGTH),
  text: z.string().max(MAX_MEMORY_TEXT_LENGTH),
  // Empty means "every season"; otherwise the pin shows only in these.
  seasons: z.array(z.enum(SEASONS)).max(SEASONS.length),
  // Media-library CDN urls (w1600 variant), in carousel order.
  photos: z.array(httpsUrlSchema).max(MAX_MEMORY_PHOTOS),
  // The Google Maps link the owner pasted, kept for the "open in Google Maps"
  // link. Empty when the pin was placed by hand.
  mapsUrl: z.union([httpsUrlSchema, z.literal('')]),
  // Real coordinates the pin is derived from; null when placed by hand.
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  // Whether the public page may show the "Open in Google Maps" link. Absent
  // means no: the exact spot of a home stays with the owner (see
  // publicPlacesData for what the public GET withholds).
  mapsPublic: z.boolean().optional(),
  // Epoch milliseconds; orders the list.
  createdAt: z.number().int().nonnegative(),
});

export type Memory = z.infer<typeof memorySchema>;

// The front draws every town on a 48×32 tile grid (pixel-map.ts there).
export const MAP_TILES_X = 48;
export const MAP_TILES_Y = 32;

/**
 * What a visitor may see of a memory. Unless the owner opted the link in
 * (`mapsPublic`), the Google Maps link and the coordinates are withheld, and
 * the pin is snapped to the centre of its map tile: the front's
 * coordinate-to-map fit ships in the public bundle, so an exact pin position
 * could otherwise be inverted back to the address. A tile is a few hundred
 * metres to about a kilometre depending on the town, so the pin still sits in
 * the right neighbourhood.
 */
export function publicMemory(memory: Memory): Memory {
  if (memory.mapsPublic) {
    return memory;
  }
  const snap = (v: number, tiles: number): number =>
    Math.round(((Math.min(tiles - 1, Math.floor(v * tiles)) + 0.5) / tiles) * 10000) / 10000;
  return {
    ...memory,
    x: snap(memory.x, MAP_TILES_X),
    y: snap(memory.y, MAP_TILES_Y),
    mapsUrl: '',
    lat: null,
    lng: null,
  };
}

export const cityInfoSchema = z.object({
  // The owner's own lines.
  period: z.string().max(MAX_CITY_FACT_LENGTH).optional(),
  note: z.string().max(MAX_CITY_FACT_LENGTH * 3).optional(),
  // Facts card, Wikipedia-derived; every field optional so the card can be
  // filled in gradually. `summary` is the paragraph shown under the town tabs.
  summary: z.string().max(MAX_CITY_SUMMARY_LENGTH).optional(),
  population: z.string().max(MAX_CITY_FACT_LENGTH).optional(),
  metro: z.string().max(MAX_CITY_FACT_LENGTH).optional(),
  area: z.string().max(MAX_CITY_FACT_LENGTH).optional(),
  knownFor: z.array(z.string().min(1).max(MAX_CITY_FACT_LENGTH)).max(MAX_CITY_CHIPS).optional(),
  food: z.array(z.string().min(1).max(MAX_CITY_FACT_LENGTH)).max(MAX_CITY_CHIPS).optional(),
  source: httpsUrlSchema.optional(),
  // ISO date (YYYY-MM-DD) the facts were retrieved.
  fetchedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type CityInfo = z.infer<typeof cityInfoSchema>;

// A deliberately empty memory list is distinct from the item never having
// been saved (which GET reports as memories: null).
export const placesDataSchema = z
  .object({
    memories: z.array(memorySchema).max(MAX_MEMORIES),
    // Keyed by town id; a town with nothing to say is simply absent.
    cities: z.partialRecord(z.enum(PLACE_CITY_IDS), cityInfoSchema).optional(),
  })
  .refine((data) => new Set(data.memories.map((m) => m.id)).size === data.memories.length, {
    message: 'Memory ids must be unique',
    path: ['memories'],
  });

export type PlacesData = z.infer<typeof placesDataSchema>;

/**
 * Folds a seed document into what is already stored, for the seed script.
 * Town facts are merged per town (the seed's towns replace the stored ones,
 * other towns are kept). Memories are precious — they are typed in by hand
 * through the editor — so the stored list is kept unless the seed carries
 * memories of its own and `replaceMemories` is set; a seed with memories
 * against a non-empty store without the flag is refused.
 */
export function mergePlacesDocuments(
  existing: PlacesData | null,
  seed: PlacesData,
  options: { replaceMemories?: boolean } = {},
): PlacesData {
  const storedMemories = existing?.memories ?? [];
  let memories = storedMemories;
  if (seed.memories.length > 0) {
    if (storedMemories.length > 0 && !options.replaceMemories) {
      throw new Error(
        `The store already holds ${storedMemories.length} memories; pass --replace-memories to overwrite them with the seed's ${seed.memories.length}.`,
      );
    }
    memories = seed.memories;
  }
  return { memories, cities: { ...existing?.cities, ...seed.cities } };
}

/** The document as the public GET serves it (see publicMemory). */
export function publicPlacesData<T extends { memories: Memory[] | null }>(doc: T): T {
  return { ...doc, memories: doc.memories?.map(publicMemory) ?? doc.memories };
}
