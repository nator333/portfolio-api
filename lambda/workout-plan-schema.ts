import { z } from 'zod';
import { MUSCLE_GROUPS, type MuscleGroup } from './workout-muscles';

/**
 * The *planned* training program, as opposed to the sets actually performed that
 * workout-schema.ts models. One is intent, the other is history; keeping them in
 * separate tables means a plan can be rewritten without touching the log, and the
 * log can be re-imported from the CSV without touching the plan.
 *
 * A program is stored as an immutable, numbered sequence of versions. Training
 * blocks are revised every few months and the interesting question later is
 * "which program was I running when I logged this?" — a question an in-place
 * update destroys the answer to. So nothing is ever overwritten: a change is a
 * new version, and the previous one stays readable forever.
 *
 * Exercises are named with the same canonical English labels the ingest
 * canonicalizes logged names to (see workout-exercises.ts), and carry the same
 * MuscleGroup vocabulary the rollups use (workout-muscles.ts). That is what makes
 * planned-vs-actual comparable at all: `plannedWeeklySets` below produces figures
 * in the same unit — hard sets per muscle per week — as the stored WeekSummary.
 */

/**
 * Deterministic, stage-scoped table name, for the same reason the other workout
 * tables have one: the read side lives in us-west-1 and refers to this us-west-2
 * table by literal name and ARN, with no cross-region CloudFormation reference.
 */
export const workoutPlanTableName = (stage: string): string => `portfolio-workout-plan-${stage}`;

/**
 * Sort-key prefix for a version item. Versions are the only item type under a
 * plan today, but prefixing leaves room for others (a per-session note, a
 * scheduled deload) without a migration.
 */
export const PLAN_VERSION_PREFIX = 'V#';

/**
 * Version numbers are zero-padded to a fixed width so DynamoDB's lexicographic
 * range ordering matches numeric order — without the padding "V#10" would sort
 * before "V#9" and "latest" would silently return the wrong program. Four digits
 * is far more revisions than a training program will ever see.
 */
const VERSION_DIGITS = 4;

export const planVersionSk = (version: number): string =>
  `${PLAN_VERSION_PREFIX}${String(version).padStart(VERSION_DIGITS, '0')}`;

/** Inverse of `planVersionSk`; null for any sort key that is not a version. */
export const parsePlanVersionSk = (sk: string): number | null => {
  if (!sk.startsWith(PLAN_VERSION_PREFIX)) return null;
  const digits = sk.slice(PLAN_VERSION_PREFIX.length);
  if (!/^\d+$/.test(digits)) return null;
  return Number(digits);
};

/** An inclusive min-max, used for set, rep and RPE prescriptions alike. */
export interface Range {
  readonly min: number;
  readonly max: number;
}

/** A single prescribed movement within a session. */
export interface PlanExercise {
  /** Position in the session, 1-based; the order the movements are performed in. */
  readonly order: number;
  /**
   * Interchangeable movements for this slot — "bench press or incline dumbbell
   * press" is one slot with two options, not two slots. The first is the default;
   * every option must map to the same muscle group, since the slot's weekly set
   * count is the same whichever is picked.
   */
  readonly options: readonly string[];
  /**
   * The group this slot's sets are counted toward. Deliberately stored rather
   * than derived at read time: it is the author's targeting decision (upright
   * dips are programmed as triceps work, not chest), and a stored value keeps
   * old versions readable even after the classifier's rules change.
   */
  readonly muscle: MuscleGroup;
  readonly sets: Range;
  readonly reps: Range;
  /** Prescribed effort, RPE 1-10; null where the program leaves it open. */
  readonly rpe: Range | null;
  readonly notes: string;
}

/** One training session — the unit a gym visit executes. */
export interface PlanSession {
  /** Stable identifier referenced by `rotation` / `bonusSessions`, e.g. "upper-a". */
  readonly id: string;
  readonly name: string;
  readonly notes: string;
  readonly exercises: readonly PlanExercise[];
}

/**
 * A weekly set target as the author states it. Kept as declared guidance rather
 * than computed from the sessions: the two do not agree, and neither is wrong.
 * The targets fold in judgment the session list cannot express — bonus-week
 * volume, and indirect work (a row's contribution to biceps, a squat's to
 * glutes) — whereas `plannedWeeklySets` counts only sets whose slot is
 * *assigned* to the group. Compare them, don't conflate them.
 */
export interface WeeklySetTarget {
  /** One entry may span several groups, e.g. a combined glutes+hamstrings target. */
  readonly muscles: readonly MuscleGroup[];
  readonly sets: Range;
  /** Target on weeks the bonus session is added; null where it is unchanged. */
  readonly bonusWeekSets: Range | null;
}

/** One immutable revision of a program. */
export interface PlanVersion {
  /** Which program this revises; the partition key. */
  readonly planId: string;
  /** 1-based, monotonically increasing per plan. */
  readonly version: number;
  readonly name: string;
  /** Sessions per week the rotation assumes, excluding bonus sessions. */
  readonly sessionsPerWeek: number;
  /** Session ids in the order they are performed, cycling. */
  readonly rotation: readonly string[];
  /** Session ids added only on weeks that allow an extra visit. */
  readonly bonusSessions: readonly string[];
  readonly sessions: readonly PlanSession[];
  readonly weeklySetTargets: readonly WeeklySetTarget[];
  /** YYYY-MM-DD; null when the block's start was never recorded. */
  readonly effectiveFrom: string | null;
  /** YYYY-MM-DD; null while the block is open-ended. */
  readonly effectiveTo: string | null;
  readonly notes: string;
  /** Why this version differs from the one before it; empty for the first. */
  readonly changeNote: string;
  /** ISO-8601 instant the version was written. */
  readonly createdAt: string;
}

/** A version as stored: the version document plus its composite key. */
export type PlanVersionItem = PlanVersion & { readonly sk: string };

export const planVersionItem = (version: PlanVersion): PlanVersionItem => ({
  ...version,
  sk: planVersionSk(version.version),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const muscleGroupSchema = z.enum([...MUSCLE_GROUPS] as [MuscleGroup, ...MuscleGroup[]]);
const isoDateSchema = z.string().regex(DATE_RE, 'must be YYYY-MM-DD');

const rangeSchema = (max: number) =>
  z
    .object({ min: z.number().min(0).max(max), max: z.number().min(0).max(max) })
    .refine((r) => r.min <= r.max, { message: 'min must not exceed max' });

/** Ceiling on a single prescription, generous enough for any real program. */
const MAX_SETS = 20;
const MAX_REPS = 100;
const MAX_RPE = 10;

const planExerciseSchema = z.object({
  order: z.number().int().min(1),
  options: z.array(z.string().trim().min(1)).min(1),
  muscle: muscleGroupSchema,
  sets: rangeSchema(MAX_SETS),
  reps: rangeSchema(MAX_REPS),
  rpe: rangeSchema(MAX_RPE).nullable(),
  notes: z.string(),
});

const planSessionSchema = z.object({
  id: z.string().regex(SLUG_RE, 'must be a lower-kebab slug'),
  name: z.string().trim().min(1),
  notes: z.string(),
  exercises: z
    .array(planExerciseSchema)
    .min(1)
    // A duplicated position makes the session ambiguous to render and to diff
    // against the log, and is nearly always a copy-paste slip while editing.
    .refine((list) => new Set(list.map((e) => e.order)).size === list.length, {
      message: 'exercise `order` must be unique within a session',
    }),
});

const weeklySetTargetSchema = z.object({
  muscles: z.array(muscleGroupSchema).min(1),
  sets: rangeSchema(MAX_SETS * 10),
  bonusWeekSets: rangeSchema(MAX_SETS * 10).nullable(),
});

export const planVersionSchema = z
  .object({
    planId: z.string().regex(SLUG_RE, 'must be a lower-kebab slug'),
    version: z.number().int().min(1),
    name: z.string().trim().min(1),
    sessionsPerWeek: z.number().int().min(1).max(7),
    rotation: z.array(z.string()).min(1),
    bonusSessions: z.array(z.string()),
    sessions: z.array(planSessionSchema).min(1),
    weeklySetTargets: z.array(weeklySetTargetSchema),
    effectiveFrom: isoDateSchema.nullable(),
    effectiveTo: isoDateSchema.nullable(),
    notes: z.string(),
    changeNote: z.string(),
    createdAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, 'must be a UTC ISO-8601 instant'),
  })
  .refine((v) => new Set(v.sessions.map((s) => s.id)).size === v.sessions.length, {
    message: 'session ids must be unique',
  })
  // A rotation entry naming a session that does not exist would silently drop
  // that day's volume out of every weekly figure, so reject it at the boundary
  // rather than quietly under-counting.
  .refine(
    (v) => {
      const ids = new Set(v.sessions.map((s) => s.id));
      return [...v.rotation, ...v.bonusSessions].every((id) => ids.has(id));
    },
    { message: 'rotation and bonusSessions must reference defined session ids' },
  )
  .refine((v) => !v.effectiveFrom || !v.effectiveTo || v.effectiveFrom <= v.effectiveTo, {
    message: 'effectiveFrom must not be after effectiveTo',
  });

/** The highest-numbered version, or null when the plan has none. */
export function latestVersion<T extends { readonly version: number }>(
  versions: readonly T[],
): T | null {
  return versions.reduce<T | null>(
    (best, v) => (best === null || v.version > best.version ? v : best),
    null,
  );
}

/**
 * The version that was in force on `date` — what to compare a logged session
 * against. A null bound is open: no `effectiveFrom` means "as far back as the
 * record goes", no `effectiveTo` means "still current". Where windows overlap
 * the newest version wins, since a revision supersedes what it replaced.
 */
export function versionInEffect<
  T extends {
    readonly version: number;
    readonly effectiveFrom: string | null;
    readonly effectiveTo: string | null;
  },
>(versions: readonly T[], date: string): T | null {
  const covering = versions.filter(
    (v) =>
      (v.effectiveFrom === null || v.effectiveFrom <= date) &&
      (v.effectiveTo === null || date <= v.effectiveTo),
  );
  return latestVersion(covering);
}

/**
 * Prescribed hard sets per muscle group across one week of the rotation — the
 * planned counterpart to the stored WeekSummary's `muscles` tally, and the only
 * figure the two can be compared on directly.
 *
 * Counts a slot's sets once regardless of how many interchangeable options it
 * offers, and counts only the group the slot is assigned to; see WeeklySetTarget
 * for why this deliberately differs from the author's stated targets.
 */
export function plannedWeeklySets(
  version: Pick<PlanVersion, 'sessions' | 'rotation' | 'bonusSessions'>,
  options: { readonly includeBonus?: boolean } = {},
): Partial<Record<MuscleGroup, Range>> {
  const byId = new Map(version.sessions.map((s) => [s.id, s]));
  const sessionIds = options.includeBonus
    ? [...version.rotation, ...version.bonusSessions]
    : version.rotation;

  const totals = new Map<MuscleGroup, { min: number; max: number }>();
  for (const id of sessionIds) {
    const session = byId.get(id);
    if (!session) continue;
    for (const exercise of session.exercises) {
      const running = totals.get(exercise.muscle) ?? { min: 0, max: 0 };
      running.min += exercise.sets.min;
      running.max += exercise.sets.max;
      totals.set(exercise.muscle, running);
    }
  }

  // Emitted in MUSCLE_GROUPS order so the result reads the same way the rollups
  // do, rather than in whatever order the sessions happened to mention groups.
  const out: Partial<Record<MuscleGroup, Range>> = {};
  for (const group of MUSCLE_GROUPS) {
    const total = totals.get(group);
    if (total) out[group] = { min: total.min, max: total.max };
  }
  return out;
}
