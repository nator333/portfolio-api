import { z } from 'zod';
import { muscleFor, MUSCLE_GROUPS, type MuscleGroup } from './workout-muscles';

/**
 * Shared shapes and pure transforms for the workout pipeline: parsing a Fitness
 * Point CSV export into normalized sets and rolling those sets up into the
 * summaries the API serves. Kept free of AWS SDK imports so both the ingest and
 * query Lambdas — and the unit tests — can depend on it without pulling in I/O.
 */

/** Local-part of the address the CSV is emailed to; the domain is deploy config. */
export const WORKOUT_LOCAL_PART = 'workout';

/**
 * Address the SES receipt rule matches, e.g. workout@example.com for prod and
 * workout-dev@example.com for dev.
 *
 * Every stage appends its own rule to the one shared receipt-rule-set, and SES
 * runs the actions of *every* rule whose recipient matches — no StopAction is
 * set. Sharing a single address across stages would therefore ingest each email
 * into all of them and send one report per stage, so only prod takes the bare
 * local part and other stages get a suffixed address of their own.
 */
export const workoutRecipient = (domain: string, stage: string): string => {
  const localPart = stage === 'prod' ? WORKOUT_LOCAL_PART : `${WORKOUT_LOCAL_PART}-${stage}`;
  return `${localPart}@${domain}`;
};

/**
 * Region the workout tables and ingest pipeline live in — us-west-2, because the
 * site domain's SES email-receiving (and therefore the S3 drop the ingest Lambda
 * triggers off) is only active there. The main API in us-west-1 reads the summary
 * table cross-region.
 */
export const WORKOUT_REGION = 'us-west-2';

// Deterministic, stage-scoped table names. They are plain constants rather than
// CDK-generated names so the us-west-1 query Lambda can reference the us-west-2
// summary table by literal name + ARN, with no cross-region CloudFormation
// reference between the two stacks.
export const workoutSetsTableName = (stage: string): string => `portfolio-workout-sets-${stage}`;
export const workoutSummaryTableName = (stage: string): string => `portfolio-workout-summary-${stage}`;

/** Partition-key discriminators for the single summary table. */
export const SUMMARY_PK = {
  day: 'DAY',
  month: 'MONTH',
  exercise: 'EXERCISE',
  muscle: 'MUSCLE',
  /** Estimated-1RM progression: one item per exercise per month. */
  exerciseMonth: 'E1RM',
  /** Sets per muscle per ISO week. */
  week: 'WEEK',
  meta: 'META',
} as const;

/** Sort key of the single META item under SUMMARY_PK.meta. */
export const META_SK = 'import';

/**
 * A numeric column, coerced to a number but tolerant of a comma decimal
 * separator. Fitness Point exports numbers in the phone's locale, so a weight
 * or distance can arrive as "27,5" rather than "27.5"; z.coerce.number() turns
 * that into NaN, which fails validation and silently drops the whole row (this
 * once lost ~1,600 sets — an entire style of decimal entry — so a biceps day
 * simply vanished from the rollups). The values carry no thousands separators
 * (weights are small), so a lone comma is always the decimal point.
 */
const localizedNumber = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.replace(',', '.') : v), schema);

// Columns of the Fitness Point export. One row per set:
//   Date,Exercise Name,Set,Weight/Distance,Reps/Time,Notes
const csvRecordSchema = z.object({
  Date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  'Exercise Name': z.string().trim().min(1),
  Set: localizedNumber(z.coerce.number().int().min(1)),
  'Weight/Distance': localizedNumber(z.coerce.number().min(0)),
  'Reps/Time': localizedNumber(z.coerce.number().min(0)),
  Notes: z.string().optional().default(''),
});

/**
 * Unit of the export's Weight/Distance column.
 *
 * The values are pounds, not kilograms. Two independent signals: every 2016-2017
 * weight carries a messy decimal that resolves to an exact kilogram figure when
 * divided by the factor below (55.116 -> 25, 88.185 -> 40, 143.3 -> 65), i.e.
 * they were entered in kg and converted on export; and the later, cleanly-round
 * values only make sense as pounds — a bench working up to 204 would be near a
 * world record in kilograms but is ~92.5 kg, a plausible decade of progress.
 *
 * The exported figure is kept as the stored source of truth and a converted
 * kilogram figure is carried alongside it, so neither unit is lost and each
 * consumer picks.
 */
export const SOURCE_WEIGHT_UNIT = 'lb';
export const LB_PER_KG = 2.20462;

export interface WorkoutSet {
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly exercise: string;
  readonly setNo: number;
  /** As recorded in the export — pounds; see SOURCE_WEIGHT_UNIT. */
  readonly weight: number;
  /** `weight` converted to kilograms. */
  readonly weightKg: number;
  readonly reps: number;
  /** weight × reps, the standard training-volume proxy, in the export's unit. */
  readonly volume: number;
  /** `volume` converted to kilograms. */
  readonly volumeKg: number;
  readonly muscle: MuscleGroup;
  readonly notes: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Converts a figure in the export's unit (pounds) to kilograms. */
export const toKg = (value: number): number => round2(value / LB_PER_KG);

/**
 * Rep ceiling for a trustworthy one-rep-max estimate. The Epley formula is a
 * linear extrapolation and drifts badly on high-rep sets, so sets above this are
 * ignored for progression rather than inflating the estimate.
 */
export const E1RM_MAX_REPS = 12;

/**
 * Epley estimated one-rep max, in whatever unit `weight` is given.
 *
 * Returns 0 for bodyweight sets and for rep counts outside the trustworthy
 * range, so callers can simply take the max and ignore the zeroes. Note this is
 * only meaningful for free-weight lifts; on a machine it reduces to "heaviest
 * stack used", which is not comparable between gyms.
 */
export const estimate1rm = (weight: number, reps: number): number => {
  if (weight <= 0 || reps < 1 || reps > E1RM_MAX_REPS) return 0;
  return round2(weight * (1 + reps / 30));
};

/** ISO-8601 week label, e.g. "2026-W30" — the bucket for weekly training volume. */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  // Shift to the Thursday of this week; the ISO year is that Thursday's year.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Whole days between two YYYY-MM-DD dates. */
const daysBetween = (from: string, to: string): number =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000,
  );

/**
 * Normalizes CSV records (as produced by csv-parse with `columns: true`) into
 * WorkoutSets. Rows that fail validation are skipped rather than aborting the
 * whole import, and their count is returned so the summary email can report it.
 *
 * Cardio/conditioning rows (Walking, Running, Swimming, treadmill, …) are dropped
 * entirely: this is a strength log, so counting a daily walk as a workout day or
 * charting it against a muscle would distort every rollup. They are reported
 * separately from invalid rows (`excludedCardio`) since they are valid data we
 * chose to exclude, not malformed input.
 */
export function parseWorkoutRows(records: readonly unknown[]): {
  sets: WorkoutSet[];
  skipped: number;
  excludedCardio: number;
} {
  const sets: WorkoutSet[] = [];
  let skipped = 0;
  let excludedCardio = 0;

  for (const record of records) {
    const parsed = csvRecordSchema.safeParse(record);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const r = parsed.data;
    const exercise = r['Exercise Name'];
    const muscle = muscleFor(exercise);
    if (muscle === 'Cardio') {
      excludedCardio += 1;
      continue;
    }
    const weight = r['Weight/Distance'];
    const reps = r['Reps/Time'];
    const volume = round2(weight * reps);
    sets.push({
      date: r.Date,
      exercise,
      setNo: r.Set,
      weight,
      weightKg: toKg(weight),
      reps,
      volume,
      volumeKg: toKg(volume),
      muscle,
      notes: r.Notes ?? '',
    });
  }

  return { sets, skipped, excludedCardio };
}

/** A set plus the sort key it is stored under, within its date partition. */
export type KeyedWorkoutSet = WorkoutSet & { readonly sk: string };

/**
 * Assigns each set its sort key within the day.
 *
 * A set number is *not* unique per exercise per day: the history contains a day
 * that logs two different "Set 1" rows for the same exercise (130x10 and
 * 140x5). Keying on `<exercise>#<set>` alone therefore collides, which
 * DynamoDB rejects outright — BatchWriteItem refuses a request containing two
 * items with the same key — so repeats take an occurrence suffix instead of
 * silently overwriting each other.
 *
 * The first occurrence keeps the bare key, so the common case stays readable,
 * and the weight is deliberately not part of the key: correcting a logged weight
 * should overwrite that set rather than orphan the old value alongside it.
 */
export function assignSetKeys(sets: readonly WorkoutSet[]): KeyedWorkoutSet[] {
  const seen = new Map<string, number>();
  return sets.map((set) => {
    const base = `${set.exercise}#${set.setNo}`;
    // Scoped per date: the date is the partition key, so the same base key on a
    // different day is not a collision.
    const counterKey = `${set.date}|${base}`;
    const occurrence = (seen.get(counterKey) ?? 0) + 1;
    seen.set(counterKey, occurrence);
    return { ...set, sk: occurrence === 1 ? base : `${base}#${occurrence}` };
  });
}

export type MuscleTally = Partial<Record<MuscleGroup, number>>;

export interface DaySummary {
  /** YYYY-MM-DD. */
  readonly sk: string;
  readonly sets: number;
  readonly reps: number;
  /** In the export's unit (pounds); `volumeKg` carries the same figure in kg. */
  readonly volume: number;
  readonly volumeKg: number;
  readonly exerciseCount: number;
  /** Set counts per muscle group worked that day. */
  readonly muscles: MuscleTally;
}

export interface MonthSummary {
  /** YYYY-MM. */
  readonly sk: string;
  readonly sets: number;
  readonly reps: number;
  readonly volume: number;
  readonly volumeKg: number;
  readonly workoutDays: number;
  readonly muscles: MuscleTally;
}

export interface ExerciseSummary {
  /** Exercise name. */
  readonly sk: string;
  readonly sets: number;
  readonly reps: number;
  readonly volume: number;
  readonly volumeKg: number;
  readonly maxWeight: number;
  readonly maxWeightKg: number;
  /** Best Epley estimate across all qualifying sets; 0 if none qualified. */
  readonly bestE1rm: number;
  readonly bestE1rmKg: number;
  readonly bestE1rmDate: string;
  readonly firstDate: string;
  readonly lastDate: string;
  /** Distinct days the exercise was performed. */
  readonly sessions: number;
  readonly muscle: MuscleGroup;
}

export interface MuscleSummary {
  /** Muscle group. */
  readonly sk: MuscleGroup;
  readonly sets: number;
  readonly reps: number;
  readonly volume: number;
  readonly volumeKg: number;
  /** Distinct exercises mapped to this group. */
  readonly exercises: number;
}

/** One exercise in one month — the estimated-1RM progression series. */
export interface ExerciseMonthSummary {
  /** `<exercise>#<YYYY-MM>`. */
  readonly sk: string;
  readonly exercise: string;
  readonly month: string;
  readonly muscle: MuscleGroup;
  readonly sets: number;
  readonly bestE1rm: number;
  readonly bestE1rmKg: number;
  readonly bestWeight: number;
  readonly bestWeightKg: number;
}

/**
 * One ISO week of training. `muscles` counts sets per muscle group, which is the
 * metric training guidance is actually expressed in (commonly ~10-20 hard sets
 * per muscle per week) — unlike total mass lifted, it is directly actionable.
 */
export interface WeekSummary {
  /** ISO week, e.g. "2026-W30". */
  readonly sk: string;
  readonly sets: number;
  readonly sessions: number;
  readonly muscles: MuscleTally;
}

/**
 * Training frequency. Every window is measured back from `lastDate` rather than
 * wall-clock now, so the figures are reproducible from the file alone and do not
 * silently rot between imports.
 */
export interface FrequencySummary {
  readonly sessionsLast30: number;
  readonly sessionsLast90: number;
  /** Sessions per week across the 90-day window. */
  readonly sessionsPerWeek: number;
  /** Consecutive ISO weeks with at least one session, ending at lastDate. */
  readonly currentStreakWeeks: number;
  readonly longestGapDays: number;
}

export interface WorkoutMeta {
  readonly totalSets: number;
  readonly totalReps: number;
  readonly totalVolume: number;
  readonly totalVolumeKg: number;
  /** Unit of every non-Kg weight/volume figure above. */
  readonly unit: string;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly workoutDays: number;
  readonly exerciseCount: number;
  readonly frequency: FrequencySummary;
}

export interface WorkoutSummaries {
  readonly days: DaySummary[];
  readonly months: MonthSummary[];
  readonly exercises: ExerciseSummary[];
  readonly exerciseMonths: ExerciseMonthSummary[];
  readonly weeks: WeekSummary[];
  readonly muscles: MuscleSummary[];
  readonly meta: WorkoutMeta;
}

// Mutable accumulators used only while folding sets; frozen into the readonly
// summary shapes above on the way out.
interface DayAcc {
  sets: number;
  reps: number;
  volume: number;
  exercises: Set<string>;
  muscles: Map<MuscleGroup, number>;
}
interface MonthAcc {
  sets: number;
  reps: number;
  volume: number;
  days: Set<string>;
  muscles: Map<MuscleGroup, number>;
}
interface ExerciseAcc {
  sets: number;
  reps: number;
  volume: number;
  maxWeight: number;
  bestE1rm: number;
  bestE1rmDate: string;
  firstDate: string;
  lastDate: string;
  days: Set<string>;
  muscle: MuscleGroup;
}
interface ExerciseMonthAcc {
  exercise: string;
  month: string;
  muscle: MuscleGroup;
  sets: number;
  bestE1rm: number;
  bestWeight: number;
}
interface WeekAcc {
  sets: number;
  days: Set<string>;
  muscles: Map<MuscleGroup, number>;
}
interface MuscleAcc {
  sets: number;
  reps: number;
  volume: number;
  exercises: Set<string>;
}

const bump = (map: Map<MuscleGroup, number>, key: MuscleGroup, by: number): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

const tally = (map: Map<MuscleGroup, number>): MuscleTally => {
  const out: MuscleTally = {};
  for (const group of MUSCLE_GROUPS) {
    const count = map.get(group);
    if (count) out[group] = count;
  }
  return out;
};

/**
 * Recomputes every rollup from the full set list. The CSV is re-sent in full on
 * each import, so a from-scratch recompute is both correct and simpler than
 * merging deltas into stored aggregates.
 */
export function summarize(sets: readonly WorkoutSet[]): WorkoutSummaries {
  const dayAcc = new Map<string, DayAcc>();
  const monthAcc = new Map<string, MonthAcc>();
  const exerciseAcc = new Map<string, ExerciseAcc>();
  const exerciseMonthAcc = new Map<string, ExerciseMonthAcc>();
  const weekAcc = new Map<string, WeekAcc>();
  const muscleAcc = new Map<MuscleGroup, MuscleAcc>();

  let totalSets = 0;
  let totalReps = 0;
  let totalVolume = 0;
  const allDays = new Set<string>();
  const allExercises = new Set<string>();
  let firstDate = '';
  let lastDate = '';

  for (const s of sets) {
    totalSets += 1;
    totalReps += s.reps;
    totalVolume += s.volume;
    allDays.add(s.date);
    allExercises.add(s.exercise);
    if (!firstDate || s.date < firstDate) firstDate = s.date;
    if (!lastDate || s.date > lastDate) lastDate = s.date;

    const day = dayAcc.get(s.date) ?? {
      sets: 0,
      reps: 0,
      volume: 0,
      exercises: new Set<string>(),
      muscles: new Map<MuscleGroup, number>(),
    };
    day.sets += 1;
    day.reps += s.reps;
    day.volume += s.volume;
    day.exercises.add(s.exercise);
    bump(day.muscles, s.muscle, 1);
    dayAcc.set(s.date, day);

    const monthKey = s.date.slice(0, 7);
    const month = monthAcc.get(monthKey) ?? {
      sets: 0,
      reps: 0,
      volume: 0,
      days: new Set<string>(),
      muscles: new Map<MuscleGroup, number>(),
    };
    month.sets += 1;
    month.reps += s.reps;
    month.volume += s.volume;
    month.days.add(s.date);
    bump(month.muscles, s.muscle, 1);
    monthAcc.set(monthKey, month);

    const e1rm = estimate1rm(s.weight, s.reps);

    const ex: ExerciseAcc = exerciseAcc.get(s.exercise) ?? {
      sets: 0,
      reps: 0,
      volume: 0,
      maxWeight: 0,
      bestE1rm: 0,
      bestE1rmDate: '',
      firstDate: s.date,
      lastDate: s.date,
      days: new Set<string>(),
      muscle: s.muscle,
    };
    ex.sets += 1;
    ex.reps += s.reps;
    ex.volume += s.volume;
    ex.maxWeight = Math.max(ex.maxWeight, s.weight);
    if (e1rm > ex.bestE1rm) {
      ex.bestE1rm = e1rm;
      ex.bestE1rmDate = s.date;
    }
    if (s.date < ex.firstDate) ex.firstDate = s.date;
    if (s.date > ex.lastDate) ex.lastDate = s.date;
    ex.days.add(s.date);
    exerciseAcc.set(s.exercise, ex);

    const exMonthKey = `${s.exercise}#${monthKey}`;
    const exMonth = exerciseMonthAcc.get(exMonthKey) ?? {
      exercise: s.exercise,
      month: monthKey,
      muscle: s.muscle,
      sets: 0,
      bestE1rm: 0,
      bestWeight: 0,
    };
    exMonth.sets += 1;
    exMonth.bestE1rm = Math.max(exMonth.bestE1rm, e1rm);
    exMonth.bestWeight = Math.max(exMonth.bestWeight, s.weight);
    exerciseMonthAcc.set(exMonthKey, exMonth);

    const weekKey = isoWeek(s.date);
    const week = weekAcc.get(weekKey) ?? {
      sets: 0,
      days: new Set<string>(),
      muscles: new Map<MuscleGroup, number>(),
    };
    week.sets += 1;
    week.days.add(s.date);
    bump(week.muscles, s.muscle, 1);
    weekAcc.set(weekKey, week);

    const mus = muscleAcc.get(s.muscle) ?? {
      sets: 0,
      reps: 0,
      volume: 0,
      exercises: new Set<string>(),
    };
    mus.sets += 1;
    mus.reps += s.reps;
    mus.volume += s.volume;
    mus.exercises.add(s.exercise);
    muscleAcc.set(s.muscle, mus);
  }

  const days: DaySummary[] = [...dayAcc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sk, d]) => ({
      sk,
      sets: d.sets,
      reps: d.reps,
      volume: round2(d.volume),
      volumeKg: toKg(d.volume),
      exerciseCount: d.exercises.size,
      muscles: tally(d.muscles),
    }));

  const months: MonthSummary[] = [...monthAcc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sk, m]) => ({
      sk,
      sets: m.sets,
      reps: m.reps,
      volume: round2(m.volume),
      volumeKg: toKg(m.volume),
      workoutDays: m.days.size,
      muscles: tally(m.muscles),
    }));

  const exercises: ExerciseSummary[] = [...exerciseAcc.entries()]
    .sort(([, a], [, b]) => b.volume - a.volume)
    .map(([sk, e]) => ({
      sk,
      sets: e.sets,
      reps: e.reps,
      volume: round2(e.volume),
      volumeKg: toKg(e.volume),
      maxWeight: e.maxWeight,
      maxWeightKg: toKg(e.maxWeight),
      bestE1rm: e.bestE1rm,
      bestE1rmKg: toKg(e.bestE1rm),
      bestE1rmDate: e.bestE1rmDate,
      firstDate: e.firstDate,
      lastDate: e.lastDate,
      sessions: e.days.size,
      muscle: e.muscle,
    }));

  const exerciseMonths: ExerciseMonthSummary[] = [...exerciseMonthAcc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sk, m]) => ({
      sk,
      exercise: m.exercise,
      month: m.month,
      muscle: m.muscle,
      sets: m.sets,
      bestE1rm: m.bestE1rm,
      bestE1rmKg: toKg(m.bestE1rm),
      bestWeight: m.bestWeight,
      bestWeightKg: toKg(m.bestWeight),
    }));

  const weeks: WeekSummary[] = [...weekAcc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sk, w]) => ({
      sk,
      sets: w.sets,
      sessions: w.days.size,
      muscles: tally(w.muscles),
    }));

  const muscles: MuscleSummary[] = [...muscleAcc.entries()]
    .sort(([, a], [, b]) => b.volume - a.volume)
    .map(([sk, m]) => ({
      sk,
      sets: m.sets,
      reps: m.reps,
      volume: round2(m.volume),
      volumeKg: toKg(m.volume),
      exercises: m.exercises.size,
    }));

  return {
    days,
    months,
    exercises,
    exerciseMonths,
    weeks,
    muscles,
    meta: {
      totalSets,
      totalReps,
      totalVolume: round2(totalVolume),
      totalVolumeKg: toKg(totalVolume),
      unit: SOURCE_WEIGHT_UNIT,
      firstDate,
      lastDate,
      workoutDays: allDays.size,
      exerciseCount: allExercises.size,
      frequency: frequencyOf([...allDays].sort(), lastDate, weeks),
    },
  };
}

/**
 * Training frequency, measured back from the last recorded session rather than
 * from wall-clock now so the numbers stay reproducible from the file alone.
 */
function frequencyOf(
  sortedDays: readonly string[],
  lastDate: string,
  weeks: readonly WeekSummary[],
): FrequencySummary {
  if (sortedDays.length === 0) {
    return {
      sessionsLast30: 0,
      sessionsLast90: 0,
      sessionsPerWeek: 0,
      currentStreakWeeks: 0,
      longestGapDays: 0,
    };
  }

  const within = (days: number): number =>
    sortedDays.filter((d) => daysBetween(d, lastDate) <= days).length;

  let longestGapDays = 0;
  for (let i = 1; i < sortedDays.length; i += 1) {
    longestGapDays = Math.max(longestGapDays, daysBetween(sortedDays[i - 1], sortedDays[i]));
  }

  // Walk back through consecutive ISO weeks that actually contain a session.
  const trained = new Set(weeks.map((w) => w.sk));
  let currentStreakWeeks = 0;
  const cursor = new Date(`${lastDate}T00:00:00Z`);
  while (trained.has(isoWeek(cursor.toISOString().slice(0, 10)))) {
    currentStreakWeeks += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 7);
  }

  const sessionsLast90 = within(90);
  return {
    sessionsLast30: within(30),
    sessionsLast90,
    sessionsPerWeek: round2(sessionsLast90 / (90 / 7)),
    currentStreakWeeks,
    longestGapDays,
  };
}
