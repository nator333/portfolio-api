import { z } from 'zod';

// Stored in the same single-document table as the CV, under a distinct id.
export const HOME_TABLE_ITEM_ID = 'home';

// The home hero renders one heading per motto (h1..h4 by position), so the
// count is capped at 4 and each line kept short to preserve the layout.
export const MAX_MOTTO_COUNT = 4;
export const MAX_MOTTO_LENGTH = 40;

// An empty list is a deliberate "no mottoes" choice, distinct from the item
// never having been saved (which GET reports as mottoes: null).
export const homeDataSchema = z.object({
  mottoes: z.array(z.string().min(1).max(MAX_MOTTO_LENGTH)).max(MAX_MOTTO_COUNT),
});

export type HomeData = z.infer<typeof homeDataSchema>;
