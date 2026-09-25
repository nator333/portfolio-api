import { z } from 'zod';

/**
 * Reflection notes: short, after-the-fact write-ups of how something went —
 * a training session, or life more broadly — written by Claude from a
 * conversation with the owner and read back before the next one.
 *
 * Private by construction. Nothing here is part of the public site; the only
 * reader and writer is the admin-gated MCP server, and the table is granted to
 * no other function in the stack.
 *
 * ## Storage shape
 *
 * `type` HASH, `sk` RANGE, where `sk` is `<date>#<uuid>`. Every read is "the
 * notes of one kind over a date window", which that key answers with a single
 * Query — and sorting on the date the note is *about* (not the moment it was
 * saved) keeps a reflection written the morning after beside the session it
 * describes. The uuid suffix only keeps two notes on one day apart.
 *
 * The sort key doubles as the note's public `id`: it is what update_reflection
 * addresses, and it is opaque to clients.
 */

/**
 * The kinds of note, kept closed on purpose. A free-text type drifts into
 * `workout` / `workouts` / `training` / `gym`, and a split vocabulary is a
 * split history. Adding a kind is a one-line change here.
 */
export const REFLECTION_TYPES = ['workout', 'life'] as const;
export type ReflectionType = (typeof REFLECTION_TYPES)[number];

/** Upper bounds, generous for a reflection but well inside a DynamoDB item. */
export const REFLECTION_BODY_MAX = 8000;
export const REFLECTION_THEMES_MAX = 10;
export const REFLECTION_THEME_MAX_LENGTH = 40;

export const REFLECTION_LIST_DEFAULT_LIMIT = 20;
export const REFLECTION_LIST_MAX_LIMIT = 100;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date, not merely a date-shaped string (rejects 2026-02-30). */
const isoDate = z
  .string()
  .regex(DATE_RE, 'must be YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'must be a real calendar date');

/**
 * Themes are the tags a later "what keeps coming up?" read groups by, so they
 * are normalised on the way in — `Sleep`, ` sleep ` and `sleep` are one theme —
 * and de-duplicated.
 *
 * They are also English-only, while the body is in whatever language the
 * conversation was. A body loses its voice in translation; a tag loses its
 * whole purpose if one topic is spelt two ways, because `sleep` and `睡眠` are
 * two themes and a read filtered on one silently misses the other. Lowercasing
 * cannot fold those together, so the vocabulary is pinned instead: lowercase
 * ASCII words joined by single spaces or hyphens.
 */
const THEME_RE = /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/;
const THEME_MESSAGE =
  'themes must be short English tags: lowercase letters and digits, words joined by a space or hyphen (e.g. "sleep", "lower-back")';

const theme = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(REFLECTION_THEME_MAX_LENGTH)
  .regex(THEME_RE, THEME_MESSAGE);

const themes = z
  .array(theme)
  .max(REFLECTION_THEMES_MAX)
  .transform((list) => [...new Set(list)]);

const body = z.string().trim().min(1).max(REFLECTION_BODY_MAX);

export const addReflectionSchema = z
  .object({
    type: z.enum(REFLECTION_TYPES),
    /**
     * The day the note is about, in the owner's local calendar. Required rather
     * than defaulted: the server only knows UTC, and a workout reflection
     * stamped with the wrong day no longer lines up with that day's sets.
     */
    date: isoDate,
    body,
    themes: themes.optional(),
  })
  .strict();

export const updateReflectionSchema = z
  .object({
    type: z.enum(REFLECTION_TYPES),
    id: z.string().min(1),
    body: body.optional(),
    themes: themes.optional(),
  })
  .strict()
  .refine((value) => value.body !== undefined || value.themes !== undefined, {
    message: 'Provide body and/or themes to change',
  });

export const listReflectionsSchema = z
  .object({
    type: z.enum(REFLECTION_TYPES).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    theme: theme.optional(),
    limit: z.coerce.number().int().min(1).max(REFLECTION_LIST_MAX_LIMIT).optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: '`from` must not be after `to`',
  });

export type AddReflection = z.infer<typeof addReflectionSchema>;

/** A note as stored and as returned. */
export interface ReflectionItem {
  type: ReflectionType;
  /** `<date>#<uuid>`; also the note's id. */
  sk: string;
  date: string;
  body: string;
  themes: string[];
  createdAt: string;
  updatedAt?: string;
}

/** The note as a client sees it: `sk` surfaced as `id`. */
export function toReflection(item: ReflectionItem) {
  const { sk, ...rest } = item;
  return { id: sk, ...rest };
}

/** Is `id` a sort key this module could have minted? Guards update's key. */
export function isReflectionId(id: string): boolean {
  const [date, uuid] = id.split('#');
  return DATE_RE.test(date ?? '') && !!uuid && id.split('#').length === 2;
}
