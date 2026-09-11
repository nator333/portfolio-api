import type { PlanVersion } from './workout-plan-schema';

/**
 * The upper/lower program currently being run, as authored by the lifter.
 *
 * This is the seed content for the plan table (see scripts/publish-workout-plan.ts)
 * and the reference copy of version 1. It is kept in source rather than only in
 * DynamoDB so a version is reviewable in a diff — a training block changing is
 * exactly the kind of thing worth seeing in git history — and so the table can be
 * rebuilt from scratch after a non-prod teardown.
 *
 * Exercise names are the canonical English labels from workout-exercises.ts, so a
 * planned slot and the logged sets that fulfil it resolve to the same string, and
 * each slot's muscle matches what muscleFor() assigns that name. The program was
 * written in Japanese; the cues are translated here to keep every stored string in
 * one language, as the rest of the workout data already is.
 */

export const UPPER_LOWER_PLAN_ID = 'upper-lower';

const SESSION = {
  upperA: 'upper-a',
  lowerA: 'lower-a',
  upperB: 'upper-b',
  lowerB: 'lower-b',
} as const;

/** Shorthand for a fixed prescription, e.g. `3×6-8` → exact(3), between(6, 8). */
const exact = (n: number) => ({ min: n, max: n });
const between = (min: number, max: number) => ({ min, max });

export const UPPER_LOWER_V1: PlanVersion = {
  planId: UPPER_LOWER_PLAN_ID,
  version: 1,
  name: 'Upper/Lower summer block',
  sessionsPerWeek: 3,
  rotation: [SESSION.upperA, SESSION.lowerA, SESSION.upperB],
  bonusSessions: [SESSION.lowerB],
  // The block was described as running to the end of August; its start date was
  // never recorded, so it is left open rather than invented.
  effectiveFrom: null,
  effectiveTo: '2026-08-31',
  notes:
    'Three sessions a week on a rotating Upper A → Lower A → Upper B cycle. Weeks that allow a fourth visit add Lower B as a bonus.',
  changeNote: '',
  createdAt: '2026-09-09T00:00:00.000Z',
  sessions: [
    {
      id: SESSION.upperA,
      name: 'Upper A',
      notes: '',
      exercises: [
        {
          order: 1,
          options: ['Bench Press', 'Incline Dumbbell Bench Press'],
          muscle: 'Chest',
          sets: exact(3),
          reps: between(6, 8),
          rpe: between(7, 8),
          notes: '',
        },
        {
          order: 2,
          options: ['Machine Lateral Raise'],
          muscle: 'Shoulders',
          sets: exact(4),
          reps: between(12, 15),
          rpe: exact(9),
          notes: 'Lean the torso away from the machine to emphasise the stretch.',
        },
        {
          order: 3,
          options: ['Pull Up', 'Lat Pulldown'],
          muscle: 'Lats',
          sets: exact(3),
          reps: between(8, 10),
          rpe: null,
          notes: '',
        },
        {
          order: 4,
          options: ['Incline Dumbbell Lateral Raise'],
          muscle: 'Shoulders',
          sets: between(2, 3),
          reps: between(12, 15),
          rpe: null,
          notes: 'Bench set to 30-45 degrees.',
        },
        {
          order: 5,
          options: ['Cable Fly'],
          muscle: 'Chest',
          sets: between(2, 3),
          reps: between(12, 15),
          rpe: null,
          notes:
            'High-to-low for the lower chest when exercise 1 was the incline dumbbell press; low-to-high for the upper chest when it was the flat bench.',
        },
        {
          order: 6,
          options: ['Incline Dumbbell Curl'],
          muscle: 'Biceps',
          sets: between(2, 3),
          reps: between(10, 12),
          rpe: null,
          notes: '',
        },
        {
          order: 7,
          options: ['Preacher Curl'],
          muscle: 'Biceps',
          sets: exact(2),
          reps: between(10, 12),
          rpe: null,
          notes: '',
        },
        {
          order: 8,
          options: ['Overhead Cable Triceps Extension'],
          muscle: 'Triceps',
          sets: between(2, 3),
          reps: between(10, 12),
          rpe: null,
          notes: '',
        },
        {
          order: 9,
          options: ['Calf Raise'],
          muscle: 'Calves',
          sets: exact(4),
          reps: between(12, 15),
          rpe: between(7, 8),
          notes: 'Held back for recovery; the heavy calf work is in Lower A.',
        },
      ],
    },
    {
      id: SESSION.lowerA,
      name: 'Lower A',
      notes: 'Mass-focused, with movement choices that spare the lower back.',
      exercises: [
        {
          order: 1,
          options: ['Hack Squat'],
          muscle: 'Quads',
          sets: exact(3),
          reps: between(8, 10),
          rpe: null,
          notes: '',
        },
        {
          order: 2,
          options: ['Hip Thrust'],
          muscle: 'Glutes',
          sets: exact(3),
          reps: between(8, 10),
          rpe: null,
          notes: '',
        },
        {
          order: 3,
          options: ['Leg Curl'],
          muscle: 'Hamstrings',
          sets: exact(3),
          reps: between(10, 12),
          rpe: null,
          notes: '',
        },
        {
          order: 4,
          options: ['Leg Extension'],
          muscle: 'Quads',
          sets: between(2, 3),
          reps: between(12, 15),
          rpe: null,
          notes: '',
        },
        {
          order: 5,
          options: ['Calf Raise'],
          muscle: 'Calves',
          sets: exact(3),
          reps: between(12, 15),
          rpe: exact(9),
          notes: 'The main calf volume of the week.',
        },
      ],
    },
    {
      id: SESSION.upperB,
      name: 'Upper B',
      notes: '',
      exercises: [
        {
          order: 1,
          options: ['Barbell Row', 'Machine Row'],
          muscle: 'Lats',
          sets: exact(3),
          reps: between(8, 10),
          rpe: null,
          notes: '',
        },
        {
          order: 2,
          options: ['Cable Lateral Raise'],
          muscle: 'Shoulders',
          sets: between(3, 4),
          reps: between(12, 15),
          rpe: null,
          notes: 'A different angle from the machine raise in Upper A.',
        },
        {
          order: 3,
          options: ['Dumbbell Bench Press', 'Machine Bench Press'],
          muscle: 'Chest',
          sets: exact(3),
          reps: between(8, 10),
          rpe: null,
          notes: 'Flat, not inclined.',
        },
        {
          order: 4,
          options: ['Face Pull'],
          muscle: 'Shoulders',
          sets: between(2, 3),
          reps: between(12, 15),
          rpe: null,
          notes: '',
        },
        {
          order: 5,
          options: ['Hammer Curl'],
          muscle: 'Biceps',
          sets: exact(2),
          reps: between(10, 12),
          rpe: null,
          notes: '',
        },
        {
          order: 6,
          options: ['Triceps Pushdown'],
          muscle: 'Triceps',
          sets: between(2, 3),
          reps: between(10, 12),
          rpe: null,
          notes: '',
        },
        {
          order: 7,
          options: ['Dips - Triceps Version'],
          muscle: 'Triceps',
          sets: between(2, 3),
          reps: between(8, 12),
          rpe: null,
          notes: 'Torso upright and elbows tucked: programmed as triceps work, not chest.',
        },
        {
          order: 8,
          options: ['Calf Raise'],
          muscle: 'Calves',
          sets: exact(4),
          reps: between(12, 15),
          rpe: between(7, 8),
          notes: 'Held back for recovery, as in Upper A.',
        },
      ],
    },
    {
      id: SESSION.lowerB,
      name: 'Lower B',
      notes: 'Bonus session, added only on weeks that allow four or more visits.',
      exercises: [
        {
          order: 1,
          options: ['Leg Press'],
          muscle: 'Quads',
          sets: exact(3),
          reps: between(10, 12),
          rpe: null,
          notes: '',
        },
        {
          order: 2,
          options: ['Bulgarian Split Squat'],
          muscle: 'Quads',
          sets: exact(3),
          reps: between(8, 10),
          rpe: null,
          notes: 'Per leg.',
        },
        {
          order: 3,
          options: ['Leg Curl'],
          muscle: 'Hamstrings',
          sets: exact(3),
          reps: between(10, 12),
          rpe: null,
          notes: '',
        },
        {
          order: 4,
          options: ['Leg Extension'],
          muscle: 'Quads',
          sets: between(2, 3),
          reps: between(12, 15),
          rpe: null,
          notes: '',
        },
        {
          order: 5,
          options: ['Calf Raise'],
          muscle: 'Calves',
          sets: exact(3),
          reps: between(12, 15),
          rpe: null,
          notes: 'The opposite variation to Lower A — seated if that was standing.',
        },
      ],
    },
  ],
  // As stated by the author. These fold in bonus-week and indirect volume, so
  // they do not equal plannedWeeklySets(); see WeeklySetTarget for why both exist.
  weeklySetTargets: [
    // Shoulders, biceps and triceps are stated as MEV-MRV landmarks rather than
    // as anything derived from the sessions above. They previously read 9-11,
    // 5-6 and 6-8 — below what this very rotation prescribes (plannedWeeklySets
    // gives 11-14, 6-7 and 6-9) — so completing the program as written reported
    // all three as "over". Note the fix is deliberately *not* "set them to what
    // the rotation prescribes": a target computed from the session list is a
    // redundant copy of plannedWeeklySets and states no intent of its own. See
    // WeeklySetTarget on why the two are kept apart.
    { muscles: ['Shoulders'], sets: { min: 8, max: 22 }, bonusWeekSets: null },
    { muscles: ['Chest'], sets: { min: 8, max: 9 }, bonusWeekSets: null },
    { muscles: ['Lats'], sets: { min: 6, max: 6 }, bonusWeekSets: null },
    { muscles: ['Triceps'], sets: { min: 6, max: 18 }, bonusWeekSets: null },
    { muscles: ['Biceps'], sets: { min: 8, max: 18 }, bonusWeekSets: null },
    { muscles: ['Quads'], sets: { min: 8, max: 10 }, bonusWeekSets: null },
    { muscles: ['Glutes', 'Hamstrings'], sets: { min: 9, max: 11 }, bonusWeekSets: null },
    { muscles: ['Calves'], sets: { min: 11, max: 11 }, bonusWeekSets: { min: 15, max: 15 } },
    // Trunk, traps and grip. The rotation prescribes no direct slot for any of
    // the three, so unlike the entries above these are not a restatement of the
    // sessions — they are the standing minimum the author works to outside the
    // program, and they are stated here because a target that lives only in the
    // consumer is a target that drifts. These three did exactly that: they were
    // hard-coded in the progress page and absent from the plan, so the page and
    // the plan disagreed about whether the muscle had a target at all. The
    // ranges are the MEV-MRV landmarks the page carried, kept deliberately low
    // because the set counts are direct-only — a row counts as Lats, never as
    // Lats plus Biceps — so indirect trap and forearm volume is not in them.
    { muscles: ['Traps'], sets: { min: 6, max: 20 }, bonusWeekSets: null },
    { muscles: ['Abs'], sets: { min: 6, max: 16 }, bonusWeekSets: null },
    { muscles: ['Forearms'], sets: { min: 4, max: 12 }, bonusWeekSets: null },
  ],
};
