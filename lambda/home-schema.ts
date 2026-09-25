import { z } from 'zod';

// Stored in the same single-document table as the CV, under a distinct id.
export const HOME_TABLE_ITEM_ID = 'home';

// The home hero renders one heading per motto (h1..h4 by position), so the
// count is capped at 4 and each line kept short to preserve the layout.
export const MAX_MOTTO_COUNT = 4;
export const MAX_MOTTO_LENGTH = 40;

// Hero background photos: one is picked at random per visit. The cap keeps the
// document small; the caption (typically where the photo was taken) is shown
// in a corner of the hero, and may be left empty to show nothing.
export const MAX_BACKGROUND_COUNT = 12;
export const MAX_BACKGROUND_CAPTION_LENGTH = 80;
export const MAX_BACKGROUND_ALT_LENGTH = 200;

export const backgroundPhotoSchema = z.object({
  // Served straight into an <img src>, so only https URLs are accepted.
  url: z.string().url().max(2048).startsWith('https://'),
  caption: z.string().max(MAX_BACKGROUND_CAPTION_LENGTH),
  alt: z.string().max(MAX_BACKGROUND_ALT_LENGTH).optional(),
});

export type BackgroundPhoto = z.infer<typeof backgroundPhotoSchema>;

// An empty list is a deliberate "no mottoes" choice, distinct from the item
// never having been saved (which GET reports as mottoes: null).
export const homeDataSchema = z.object({
  mottoes: z.array(z.string().min(1).max(MAX_MOTTO_LENGTH)).max(MAX_MOTTO_COUNT),
  // When true the hero renders no motto lines even though the saved mottoes are
  // preserved, so they can be hidden and restored without retyping. Omitted
  // rather than false to keep documents clean and stay back-compatible.
  mottoesHidden: z.boolean().optional(),
  // Omitted (or empty) keeps the plain black hero.
  backgrounds: z.array(backgroundPhotoSchema).max(MAX_BACKGROUND_COUNT).optional(),
});

export type HomeData = z.infer<typeof homeDataSchema>;
