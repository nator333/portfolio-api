import { MUSCLE_GROUPS, type MuscleGroup } from './workout-muscles';
import type { Range, WeeklySetTarget } from './workout-plan-schema';

/**
 * The one place "am I under, in range, or over on this muscle?" is decided.
 *
 * That question used to be answered twice — once by the progress page's own
 * hard-coded table of target ranges, once ad hoc by whoever was reading the
 * training log through the MCP server — over two different windows and, for
 * Chest and Lats, against two different numbers. The page called a chest week
 * "under" at 9 sets while the program it was judging asked for 8-9. Duplicated
 * judgment drifts; this module exists so there is nothing to drift from.
 *
 * Kept free of AWS SDK imports so the handler, the MCP server and the tests all
 * share the same arithmetic rather than each approximating it.
 */

export type VolumeStatus = 'under' | 'in_range' | 'over';

/**
 * Rolling window in days, ending at the moment of the request rather than at a
 * calendar-week boundary.
 *
 * Seven is the default because the plan states its targets per week, but the
 * distinction from an ISO week is the point: a Monday-reset week reports a
 * muscle "under" every Monday morning and "in range" every Sunday night, on a
 * training history that never changed. A trailing window asks the only question
 * a lifter can act on — how much have I actually done lately.
 */
export const DEFAULT_WINDOW_DAYS = 7;

/**
 * Widest window a caller may ask for. The rollup is one Query over day
 * summaries, so this is a guard against a silly `window=100000`, not a cost
 * ceiling; a year is past the point where a "recent volume" reading means
 * anything anyway.
 */
export const MAX_WINDOW_DAYS = 365;

/** Days the plan's weekly targets are stated over. */
const DAYS_PER_WEEK = 7;

/** Per-muscle verdict. One row per muscle the plan sets a target for. */
export interface MuscleVolumeRow {
  readonly muscle: MuscleGroup;
  /** The target exactly as the plan states it: sets per week. */
  readonly weeklyTarget: Range;
  /**
   * `weeklyTarget` scaled to the requested window — identical to it at the
   * default 7 days. This, not `weeklyTarget`, is what `status` is judged
   * against: 14 days of sets measured against a one-week target would call
   * every muscle "over" for no reason but the width of the question.
   */
  readonly target: Range;
  /** Sets logged for this muscle alone within the window. */
  readonly sets: number;
  /**
   * The figure `status` is actually judged on. Usually equal to `sets`, but a
   * plan may state one target across several muscles (this one prescribes
   * glutes and hamstrings together), and a shared target is only meaningful
   * against the shared total — judging each half against the whole range would
   * report both as "under" whatever the lifter did.
   */
  readonly countedSets: number;
  /** The other muscles sharing this row's target; empty when it stands alone. */
  readonly sharedWith: readonly MuscleGroup[];
  readonly status: VolumeStatus;
}

/** A muscle that was trained in the window but that the plan sets no target for. */
export interface UntargetedMuscle {
  readonly muscle: MuscleGroup;
  readonly sets: number;
}

/** Per-day set tallies, the shape the stored day summaries already carry. */
export interface DayTally {
  readonly date: string;
  readonly muscles: Readonly<Partial<Record<string, number>>>;
}

export interface WindowBounds {
  readonly days: number;
  /** YYYY-MM-DD, inclusive. */
  readonly from: string;
  /** YYYY-MM-DD, inclusive — the UTC date of the request. */
  readonly to: string;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * The `days`-long window ending on the UTC date of `asOf`, inclusive at both
 * ends — so seven days means today and the six before it, not today minus
 * seven.
 *
 * Whole UTC days rather than an exact instant-to-instant span because the log
 * records dates, not times: a set logged this morning belongs to today however
 * many hours ago it was. `asOf` is carried through to the response so a caller
 * comparing two readings can see which trailing window each one covered.
 */
export function windowBounds(asOf: Date, days: number): WindowBounds {
  const to = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { days, from: isoDate(from), to: isoDate(to) };
}

/**
 * Parses the `window` query parameter. Returns the default when absent, and an
 * error rather than a silent fallback when present and nonsensical — a caller
 * that asked for `window=fortnight` wants to be told, not quietly served seven
 * days it will then misread as fourteen.
 */
export function parseWindowDays(raw: string | undefined): { days: number } | { error: string } {
  if (raw === undefined || raw.trim() === '') return { days: DEFAULT_WINDOW_DAYS };
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
    return { error: `\`window\` must be a whole number of days from 1 to ${MAX_WINDOW_DAYS}` };
  }
  return { days };
}

/** Total sets per muscle across the given days. */
export function rollUpSets(days: readonly DayTally[]): Map<MuscleGroup, number> {
  const totals = new Map<MuscleGroup, number>();
  for (const day of days) {
    for (const [muscle, count] of Object.entries(day.muscles ?? {})) {
      if (!count) continue;
      // Guard the cast: a group renamed out of the vocabulary must not become a
      // phantom row. Anything unrecognised is simply not counted.
      if (!(MUSCLE_GROUPS as readonly string[]).includes(muscle)) continue;
      const group = muscle as MuscleGroup;
      totals.set(group, (totals.get(group) ?? 0) + count);
    }
  }
  return totals;
}

/** Where a set count falls against a range; both bounds are inclusive. */
export function statusFor(sets: number, target: Range): VolumeStatus {
  if (sets < target.min) return 'under';
  if (sets > target.max) return 'over';
  return 'in_range';
}

/** A weekly range restated over a window of `days`. */
export function scaleTarget(weekly: Range, days: number): Range {
  if (days === DAYS_PER_WEEK) return weekly;
  const factor = days / DAYS_PER_WEEK;
  return { min: round1(weekly.min * factor), max: round1(weekly.max * factor) };
}

/**
 * Whether the window covers more training than the rotation alone prescribes,
 * which is what `bonusWeekSets` is stated for.
 *
 * The plan expresses the bonus as "weeks that allow a fourth visit", so the test
 * is the session count, not the calendar: more sessions in the window than the
 * rotation asks for over that many days means the bonus session was one of them.
 * Without this, a week that took the extra Lower B would report calves "over" at
 * exactly the 15 sets the plan asks for on such a week.
 */
export function isBonusWindow(sessions: number, sessionsPerWeek: number, days: number): boolean {
  return sessions > Math.round((sessionsPerWeek * days) / DAYS_PER_WEEK);
}

/** The weekly range in force for one target entry, given whether this is a bonus window. */
const weeklyRangeFor = (target: WeeklySetTarget, bonusWindow: boolean): Range =>
  bonusWindow && target.bonusWeekSets ? target.bonusWeekSets : target.sets;

export interface StatusOptions {
  readonly days: number;
  /** Distinct days trained within the window. */
  readonly sessions: number;
  /**
   * From the *menu* version, not the target set — the only thing the rollup
   * still needs from the sessions half, and only to tell a bonus week from an
   * ordinary one.
   */
  readonly sessionsPerWeek: number;
}

export interface MuscleVolumeStatus {
  readonly bonusWindow: boolean;
  readonly muscles: readonly MuscleVolumeRow[];
  readonly untargeted: readonly UntargetedMuscle[];
}

/**
 * Judges every targeted muscle, and reports the trained-but-untargeted ones
 * beside them rather than dropping them — a muscle no target mentions is a gap
 * in the intent, and silently omitting it is how Abs, Traps and Forearms came to
 * exist on the progress page but nowhere in the plan.
 *
 * Takes the target list itself rather than a plan version: targets are their own
 * versioned document now (see PLAN_TARGET_PREFIX), and this is the half of the
 * program the verdict actually depends on.
 */
export function muscleVolumeStatus(
  targets: readonly WeeklySetTarget[],
  counts: ReadonlyMap<MuscleGroup, number>,
  options: StatusOptions,
): MuscleVolumeStatus {
  const bonusWindow = isBonusWindow(options.sessions, options.sessionsPerWeek, options.days);

  // First entry naming a muscle wins. A muscle listed twice is a contradiction
  // in the plan, not a merge to attempt: two ranges over one count have no
  // single answer, so the later entry is ignored rather than guessed at.
  const entryFor = new Map<MuscleGroup, WeeklySetTarget>();
  for (const target of targets) {
    for (const muscle of target.muscles) {
      if (!entryFor.has(muscle)) entryFor.set(muscle, target);
    }
  }

  const muscles: MuscleVolumeRow[] = [];
  for (const muscle of MUSCLE_GROUPS) {
    const entry = entryFor.get(muscle);
    if (!entry) continue;

    const shared = entry.muscles.filter((m) => m !== muscle && entryFor.get(m) === entry);
    const sets = counts.get(muscle) ?? 0;
    const countedSets = entry.muscles
      .filter((m) => entryFor.get(m) === entry)
      .reduce((total, m) => total + (counts.get(m) ?? 0), 0);

    const weeklyTarget = weeklyRangeFor(entry, bonusWindow);
    const target = scaleTarget(weeklyTarget, options.days);

    muscles.push({
      muscle,
      weeklyTarget,
      target,
      sets,
      countedSets,
      sharedWith: shared,
      status: statusFor(countedSets, target),
    });
  }

  const untargeted: UntargetedMuscle[] = MUSCLE_GROUPS.filter(
    (muscle) => !entryFor.has(muscle) && (counts.get(muscle) ?? 0) > 0,
  ).map((muscle) => ({ muscle, sets: counts.get(muscle) as number }));

  return { bonusWindow, muscles, untargeted };
}
