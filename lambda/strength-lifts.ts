import { exerciseName } from './workout-exercises';
import type { PlanVersion } from './workout-plan-schema';

/**
 * Which lifts the strength-progression chart follows.
 *
 * Ranking by all-time sets kept charting whatever had the longest history —
 * barbell bench press long after a plan revision dropped it — and could not
 * surface a lift the current block added until it had years of sets behind it.
 * The plan in force already says what is being trained, so the chart follows it:
 *
 *   - Only strength-range slots (`reps.max` ≤ MAX_TRACKED_REPS). An estimated
 *     1RM from 12-15-rep isolation work is mostly noise, and those slots are
 *     programmed for volume, not load.
 *   - One lift per slot: the option logged most in the recent window. Options
 *     are never spliced into one line — a barbell and an incline-dumbbell 1RM
 *     are different numbers, and joining them would invent a jump.
 *   - Plan names are matched to logged names loosely (case, whitespace, plural
 *     "s"), because the plan is written by hand and "Pull Up" is logged as
 *     "Pull ups". A slot none of whose options matches is skipped, not guessed.
 *
 * The long-history lifts that are no longer being logged are still returned,
 * marked untracked, so the page can draw them muted rather than lose the story.
 */

/** Slots prescribing more reps than this are volume work, not strength work. */
export const MAX_TRACKED_REPS = 10;
/** Months of history that decide which of a slot's options is the live one. */
export const RECENT_MONTHS = 6;
/** Earlier lifts returned beside the tracked ones. */
export const EARLIER_LIFTS = 3;
/** A lift not logged for this long counts as earlier, not current. */
export const EARLIER_AFTER_DAYS = 42;

/** A logged exercise, as the EXERCISE partition of the summary table holds it. */
export interface LoggedLift {
  readonly name: string;
  readonly sets: number;
  readonly lastDate: string;
  readonly bestE1rmKg: number;
}

/** Sets logged for one exercise in one month. */
export interface LiftMonth {
  readonly exercise: string;
  readonly month: string;
  readonly sets: number;
}

export interface SelectedLift {
  readonly name: string;
  /** True when the plan in force prescribes it; false for an earlier lift. */
  readonly tracked: boolean;
}

/** Case, whitespace, punctuation and a trailing plural "s" per word. */
const looseKey = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .join(' ');

/** The logged name a plan option refers to, or null when nothing matches. */
export function matchLoggedName(option: string, logged: ReadonlyMap<string, string>): string | null {
  return logged.get(looseKey(exerciseName(option))) ?? null;
}

/** First month (YYYY-MM) inside the recent window ending on `today`. */
const windowStart = (today: string): string => {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - (RECENT_MONTHS - 1));
  return d.toISOString().slice(0, 7);
};

const daysBetween = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

/**
 * The lifts to chart, tracked ones first in plan order (rotation, then slot
 * order), then up to EARLIER_LIFTS long-history lifts no longer being logged.
 *
 * With no plan the old ranking stands — most-trained first, all tracked — so a
 * missing or unreadable plan degrades the chart rather than emptying it.
 */
export function selectStrengthLifts(
  plan: Pick<PlanVersion, 'sessions' | 'rotation'> | null,
  lifts: readonly LoggedLift[],
  months: readonly LiftMonth[],
  today: string,
  fallbackCount: number,
): SelectedLift[] {
  const charted = lifts.filter((l) => l.bestE1rmKg > 0);
  const byAllTime = charted.slice().sort((a, b) => b.sets - a.sets);
  if (!plan) {
    return byAllTime.slice(0, fallbackCount).map((l) => ({ name: l.name, tracked: true }));
  }

  // Most-trained first, so when two logged spellings fold to one key the
  // established one wins.
  const logged = new Map<string, string>();
  for (const l of byAllTime) {
    const key = looseKey(l.name);
    if (!logged.has(key)) logged.set(key, l.name);
  }
  const from = windowStart(today);
  const recentSets = new Map<string, number>();
  const lastMonth = new Map<string, string>();
  for (const m of months) {
    if (m.month > (lastMonth.get(m.exercise) ?? '')) lastMonth.set(m.exercise, m.month);
    if (m.month >= from && m.month <= today.slice(0, 7)) {
      recentSets.set(m.exercise, (recentSets.get(m.exercise) ?? 0) + m.sets);
    }
  }

  // Rotation order first, so the chart reads like the week does; sessions the
  // rotation does not name (bonus sessions) follow in stored order.
  const order = new Map(plan.rotation.map((id, i) => [id, i]));
  const sessions = plan.sessions
    .slice()
    .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));

  const tracked: string[] = [];
  for (const session of sessions) {
    const slots = session.exercises.slice().sort((a, b) => a.order - b.order);
    for (const slot of slots) {
      if (slot.reps.max > MAX_TRACKED_REPS) continue;
      const candidates = slot.options
        .map((o) => matchLoggedName(o, logged))
        .filter((n): n is string => n !== null);
      if (!candidates.length) continue;
      // Most recent sets wins; with none recent, the most recently logged
      // month; failing both, the plan's own default (first option).
      const pick = candidates.reduce((best, name) => {
        const diff = (recentSets.get(name) ?? 0) - (recentSets.get(best) ?? 0);
        if (diff !== 0) return diff > 0 ? name : best;
        return (lastMonth.get(name) ?? '') > (lastMonth.get(best) ?? '') ? name : best;
      });
      if (!tracked.includes(pick)) tracked.push(pick);
    }
  }

  const earlier = byAllTime
    .filter((l) => !tracked.includes(l.name))
    .filter((l) => !l.lastDate || daysBetween(l.lastDate, today) > EARLIER_AFTER_DAYS)
    .slice(0, EARLIER_LIFTS)
    .map((l) => ({ name: l.name, tracked: false }));

  return [...tracked.map((name) => ({ name, tracked: true })), ...earlier];
}
