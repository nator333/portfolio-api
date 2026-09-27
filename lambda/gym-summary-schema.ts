/**
 * Shapes and pure transforms for the gym-day summaries: one short public line
 * per training day, distilled from that day's private workout reflections.
 *
 * This is the one place reflection text crosses into the public site, so the
 * boundary is kept narrow on both sides: add_reflection tells the writer that
 * workout notes feed a public line and must hold no private matters, and the
 * prompt below tells the model to write only about the training itself. What
 * leaves is at most MAX_SUMMARY_CHARS characters, never the note.
 *
 * Kept free of AWS SDK imports so both Lambdas and the unit tests can use it.
 */

import type { ActivityEntry } from './activity-schema';
import { MAX_SUMMARY_CHARS, TARGET_SUMMARY_CHARS, normalizeSummary } from './github-summary-schema';

/** Partition the gym summaries live under, beside GITHUB_DAY in the same table. */
export const GYM_SUMMARY_PK = 'GYM_DAY';

/** Reflection type whose notes feed the gym summaries; "life" notes never do. */
export const GYM_REFLECTION_TYPE = 'workout';

/** Reply meaning "nothing shareable in these notes": the day gets no summary. */
export const NO_SUMMARY = '-';

/** Reflection text handed to the model per day; bounds the prompt and its cost. */
const MAX_PROMPT_BODY_CHARS = 12000;

export interface GymDaySummary {
  /** The session day in the owner's local calendar, as on the gym entry. */
  readonly date: string;
  readonly summary: string;
}

export const GYM_SUMMARY_SYSTEM_PROMPT = [
  "You write the one-line training log shown under a gym session on a software engineer's public portfolio site.",
  "Given the owner's private reflection notes about one training session, write what the session was about.",
  `Write one short English phrase in the past tense without a subject ("Hit a squat PR…", "Focused on…"). Aim for about ${TARGET_SUMMARY_CHARS} characters including spaces; never exceed ${MAX_SUMMARY_CHARS}. No trailing period.`,
  'Name the one main point of the session (the split or focus, a PR, a deload) rather than listing exercises.',
  'Write ONLY about the training itself: exercises, weights, reps, technique, progress and how the session felt as training.',
  'Never mention private life, work, relationships, family, mood or mental health, sleep, diet, medical conditions, injuries, pain or anything else personal — even if the notes do. Leave such details out entirely rather than paraphrasing them.',
  `If nothing about the training itself remains once personal details are left out, reply with exactly ${NO_SUMMARY}`,
  'The notes may be in Japanese or English; always reply in English. Use only what the notes say.',
  'Output the phrase only — no quotes, no markdown, no preamble.',
].join('\n');

/** The day's notes as the user turn, oldest first, trimmed to the prompt budget. */
export function buildGymPrompt(date: string, bodies: readonly string[]): string {
  const lines = [`Session date: ${date}`, ''];
  let budget = MAX_PROMPT_BODY_CHARS;
  bodies.forEach((body, i) => {
    if (budget <= 0) return;
    const text = body.trim().slice(0, budget);
    budget -= text.length;
    lines.push(`Note ${i + 1}:`, text, '');
  });
  return lines.join('\n').trim();
}

/**
 * The phrase to publish, normalised but not yet capped (so an overrun can be sent
 * back to be shortened), or null when the model found nothing shareable.
 */
export function parseGymSummary(text: string): string | null {
  const trimmed = text.trim().replace(/^["']|["']$/g, '');
  if (!trimmed || trimmed === NO_SUMMARY) return null;
  return normalizeSummary(trimmed) || null;
}

/** The follow-up turn when the phrase ran over the cap. */
export const SHORTEN_GYM_REQUEST = `That phrase ran over ${MAX_SUMMARY_CHARS} characters. Rewrite it in at most ${TARGET_SUMMARY_CHARS} characters, naming only the main point; reply with the phrase only.`;

/** The session date a reflection sort key (`<date>#<uuid>`) belongs to. */
export function dateFromReflectionKey(sk: unknown): string | null {
  if (typeof sk !== 'string') return null;
  const [date] = sk.split('#');
  return /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date! : null;
}

/** Reads stored items back, skipping malformed ones. */
export function itemsToGymSummaries(items: readonly Record<string, unknown>[]): GymDaySummary[] {
  return items.flatMap((item) =>
    typeof item.date === 'string' && typeof item.summary === 'string' && item.summary
      ? [{ date: item.date, summary: item.summary }]
      : [],
  );
}

/**
 * Puts each summary on that day's gym entry. Unlike GitHub, a summary with no
 * entry is dropped rather than made into one: the workout table holds the whole
 * training history, so a missing gym entry means no logged session that day,
 * and a reflection alone is not one.
 */
export function attachGymSummaries(
  entries: readonly ActivityEntry[],
  summaries: readonly GymDaySummary[],
): ActivityEntry[] {
  const byDate = new Map(summaries.map((s) => [s.date, s.summary]));
  return entries.map((entry) => {
    const summary = byDate.get(entry.date);
    return summary ? { ...entry, summary } : entry;
  });
}
