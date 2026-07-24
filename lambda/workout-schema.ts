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

/** Address the SES receipt rule matches, e.g. workout@example.com. */
export const workoutRecipient = (domain: string): string => `${WORKOUT_LOCAL_PART}@${domain}`;

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
  meta: 'META',
} as const;

/** Sort key of the single META item under SUMMARY_PK.meta. */
export const META_SK = 'import';

// Columns of the Fitness Point export. One row per set:
//   Date,Exercise Name,Set,Weight/Distance,Reps/Time,Notes
const csvRecordSchema = z.object({
  Date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  'Exercise Name': z.string().trim().min(1),
  Set: z.coerce.number().int().min(1),
  'Weight/Distance': z.coerce.number().min(0),
  'Reps/Time': z.coerce.number().min(0),
  Notes: z.string().optional().default(''),
});

export interface WorkoutSet {
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly exercise: string;
  readonly setNo: number;
  /** As recorded in the export (kilograms). */
  readonly weight: number;
  readonly reps: number;
  /** weight × reps, the standard training-volume proxy. */
  readonly volume: number;
  readonly muscle: MuscleGroup;
  readonly notes: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Normalizes CSV records (as produced by csv-parse with `columns: true`) into
 * WorkoutSets. Rows that fail validation are skipped rather than aborting the
 * whole import, and their count is returned so the summary email can report it.
 */
export function parseWorkoutRows(records: readonly unknown[]): {
  sets: WorkoutSet[];
  skipped: number;
} {
  const sets: WorkoutSet[] = [];
  let skipped = 0;

  for (const record of records) {
    const parsed = csvRecordSchema.safeParse(record);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const r = parsed.data;
    const exercise = r['Exercise Name'];
    const weight = r['Weight/Distance'];
    const reps = r['Reps/Time'];
    sets.push({
      date: r.Date,
      exercise,
      setNo: r.Set,
      weight,
      reps,
      volume: round2(weight * reps),
      muscle: muscleFor(exercise),
      notes: r.Notes ?? '',
    });
  }

  return { sets, skipped };
}

export type MuscleTally = Partial<Record<MuscleGroup, number>>;

export interface DaySummary {
  /** YYYY-MM-DD. */
  readonly sk: string;
  readonly sets: number;
  readonly reps: number;
  readonly volume: number;
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
  readonly workoutDays: number;
  readonly muscles: MuscleTally;
}

export interface ExerciseSummary {
  /** Exercise name. */
  readonly sk: string;
  readonly sets: number;
  readonly reps: number;
  readonly volume: number;
  readonly maxWeight: number;
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
  /** Distinct exercises mapped to this group. */
  readonly exercises: number;
}

export interface WorkoutMeta {
  readonly totalSets: number;
  readonly totalReps: number;
  readonly totalVolume: number;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly workoutDays: number;
  readonly exerciseCount: number;
}

export interface WorkoutSummaries {
  readonly days: DaySummary[];
  readonly months: MonthSummary[];
  readonly exercises: ExerciseSummary[];
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
  firstDate: string;
  lastDate: string;
  days: Set<string>;
  muscle: MuscleGroup;
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

    const ex = exerciseAcc.get(s.exercise) ?? {
      sets: 0,
      reps: 0,
      volume: 0,
      maxWeight: 0,
      firstDate: s.date,
      lastDate: s.date,
      days: new Set<string>(),
      muscle: s.muscle,
    };
    ex.sets += 1;
    ex.reps += s.reps;
    ex.volume += s.volume;
    ex.maxWeight = Math.max(ex.maxWeight, s.weight);
    if (s.date < ex.firstDate) ex.firstDate = s.date;
    if (s.date > ex.lastDate) ex.lastDate = s.date;
    ex.days.add(s.date);
    exerciseAcc.set(s.exercise, ex);

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
      maxWeight: e.maxWeight,
      firstDate: e.firstDate,
      lastDate: e.lastDate,
      sessions: e.days.size,
      muscle: e.muscle,
    }));

  const muscles: MuscleSummary[] = [...muscleAcc.entries()]
    .sort(([, a], [, b]) => b.volume - a.volume)
    .map(([sk, m]) => ({
      sk,
      sets: m.sets,
      reps: m.reps,
      volume: round2(m.volume),
      exercises: m.exercises.size,
    }));

  return {
    days,
    months,
    exercises,
    muscles,
    meta: {
      totalSets,
      totalReps,
      totalVolume: round2(totalVolume),
      firstDate,
      lastDate,
      workoutDays: allDays.size,
      exerciseCount: allExercises.size,
    },
  };
}
