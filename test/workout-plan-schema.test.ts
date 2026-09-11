import { muscleFor } from '../lambda/workout-muscles';
import {
  latestVersion,
  parsePlanVersionSk,
  planVersionItem,
  planVersionSchema,
  planVersionSk,
  plannedWeeklySets,
  versionInEffect,
  workoutPlanTableName,
} from '../lambda/workout-plan-schema';
import { UPPER_LOWER_PLAN_ID, UPPER_LOWER_V1 } from '../lambda/workout-plan-upper-lower';

/** A mutable deep copy of the seed program, for building invalid variants. */
const variant = (): any => JSON.parse(JSON.stringify(UPPER_LOWER_V1));

describe('table name', () => {
  it('should be stage-scoped and deterministic', () => {
    expect(workoutPlanTableName('prod')).toBe('portfolio-workout-plan-prod');
  });
});

describe('version sort keys', () => {
  it('should zero-pad so lexicographic order matches numeric order', () => {
    expect(planVersionSk(1)).toBe('V#0001');
    expect([planVersionSk(10), planVersionSk(9)].sort()).toEqual(['V#0009', 'V#0010']);
  });

  it('should round-trip through parsePlanVersionSk', () => {
    expect(parsePlanVersionSk(planVersionSk(42))).toBe(42);
  });

  it('should return null for a sort key that is not a version', () => {
    expect(parsePlanVersionSk('META')).toBeNull();
    expect(parsePlanVersionSk('V#nope')).toBeNull();
  });

  it('should key a stored item by its version number', () => {
    expect(planVersionItem(UPPER_LOWER_V1).sk).toBe('V#0001');
  });
});

describe('the seeded upper/lower program', () => {
  it('should satisfy the stored-item schema', () => {
    const result = planVersionSchema.safeParse(UPPER_LOWER_V1);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('should belong to the upper-lower plan and rotate three sessions plus a bonus', () => {
    expect(UPPER_LOWER_V1.planId).toBe(UPPER_LOWER_PLAN_ID);
    expect(UPPER_LOWER_V1.rotation).toEqual(['upper-a', 'lower-a', 'upper-b']);
    expect(UPPER_LOWER_V1.bonusSessions).toEqual(['lower-b']);
  });

  // The point of naming planned movements with the log's canonical labels: a
  // planned slot and the sets that fulfil it must land in the same muscle group,
  // or planned-vs-actual compares two different things.
  it('should assign every option the muscle group the log classifier gives it', () => {
    for (const session of UPPER_LOWER_V1.sessions) {
      for (const exercise of session.exercises) {
        for (const option of exercise.options) {
          expect([session.id, option, muscleFor(option)]).toEqual([
            session.id,
            option,
            exercise.muscle,
          ]);
        }
      }
    }
  });
});

describe('plannedWeeklySets', () => {
  it('should count the rotation only, excluding the bonus session by default', () => {
    const weekly = plannedWeeklySets(UPPER_LOWER_V1);

    expect(weekly.Chest).toEqual({ min: 8, max: 9 });
    expect(weekly.Lats).toEqual({ min: 6, max: 6 });
    expect(weekly.Calves).toEqual({ min: 11, max: 11 });
    expect(weekly.Quads).toEqual({ min: 5, max: 6 });
  });

  it('should add the bonus session when asked', () => {
    const bonus = plannedWeeklySets(UPPER_LOWER_V1, { includeBonus: true });

    expect(bonus.Quads).toEqual({ min: 13, max: 15 });
    expect(bonus.Hamstrings).toEqual({ min: 6, max: 6 });
    expect(bonus.Calves).toEqual({ min: 14, max: 14 });
  });

  it('should omit groups the week never trains', () => {
    expect(plannedWeeklySets(UPPER_LOWER_V1).Abs).toBeUndefined();
  });

  /**
   * The targets and the sessions are deliberately independent — see
   * WeeklySetTarget — but independent is not the same as free to contradict.
   * Running the rotation exactly as written must never be reported as *too much*
   * volume, because the program is the thing asking for it.
   *
   * This is a real regression: Shoulders, Biceps and Triceps were once declared
   * at 9-11, 5-6 and 6-8 against a rotation prescribing 11-14, 6-7 and 6-9, so a
   * perfectly-executed week came back "over" on /muscle-volume-status.
   */
  it('should never declare a target below what the rotation prescribes', () => {
    const prescribed = plannedWeeklySets(UPPER_LOWER_V1);

    for (const target of UPPER_LOWER_V1.weeklySetTargets) {
      // A target may span several muscles, so compare against their combined
      // prescription — the same total the status endpoint judges it on.
      const combinedMax = target.muscles.reduce(
        (total, muscle) => total + (prescribed[muscle]?.max ?? 0),
        0,
      );
      if (combinedMax === 0) continue; // No slot prescribes it; nothing to contradict.

      expect([target.muscles.join('+'), combinedMax <= target.sets.max]).toEqual([
        target.muscles.join('+'),
        true,
      ]);
    }
  });

  /**
   * The reverse direction is deliberately NOT asserted. A target above the
   * prescription is the whole point of stating one: the glutes/hamstrings target
   * of 9-11 sits above the 6 the rotation directly assigns because it folds in
   * indirect work the session list cannot express.
   */
  it('should allow a target above the prescription, which is the point of stating one', () => {
    const prescribed = plannedWeeklySets(UPPER_LOWER_V1);
    const legs = UPPER_LOWER_V1.weeklySetTargets.find((t) => t.muscles.includes('Glutes'));

    const directlyPrescribed =
      (prescribed.Glutes?.max ?? 0) + (prescribed.Hamstrings?.max ?? 0);
    expect(directlyPrescribed).toBe(6);
    expect(legs?.sets.min).toBeGreaterThan(directlyPrescribed);
  });
});

describe('selecting a version', () => {
  const version = (v: number, effectiveFrom: string | null, effectiveTo: string | null) => ({
    version: v,
    effectiveFrom,
    effectiveTo,
  });

  it('should return the highest-numbered version as the latest', () => {
    expect(latestVersion([version(1, null, null), version(3, null, null), version(2, null, null)]))
      .toEqual(version(3, null, null));
  });

  it('should return null when there are no versions', () => {
    expect(latestVersion([])).toBeNull();
  });

  it('should pick the version whose window covers the date', () => {
    const versions = [
      version(1, '2026-01-01', '2026-05-31'),
      version(2, '2026-06-01', '2026-08-31'),
      version(3, '2026-09-01', null),
    ];

    expect(versionInEffect(versions, '2026-07-04')?.version).toBe(2);
    expect(versionInEffect(versions, '2026-08-31')?.version).toBe(2);
    expect(versionInEffect(versions, '2026-12-25')?.version).toBe(3);
  });

  it('should treat a null effectiveFrom as reaching back indefinitely', () => {
    expect(versionInEffect([version(1, null, '2026-08-31')], '2020-01-01')?.version).toBe(1);
  });

  it('should prefer the newer version where windows overlap', () => {
    const versions = [version(1, '2026-01-01', null), version(2, '2026-06-01', null)];
    expect(versionInEffect(versions, '2026-07-01')?.version).toBe(2);
  });

  it('should return null when no version covers the date', () => {
    expect(versionInEffect([version(1, '2026-01-01', '2026-05-31')], '2026-07-01')).toBeNull();
  });
});

describe('planVersionSchema rejections', () => {
  it('should reject a rotation naming a session that does not exist', () => {
    const plan = variant();
    plan.rotation.push('upper-c');
    expect(planVersionSchema.safeParse(plan).success).toBe(false);
  });

  it('should reject a set range whose min exceeds its max', () => {
    const plan = variant();
    plan.sessions[0].exercises[0].sets = { min: 5, max: 3 };
    expect(planVersionSchema.safeParse(plan).success).toBe(false);
  });

  it('should reject two exercises sharing a position in the same session', () => {
    const plan = variant();
    plan.sessions[0].exercises[1].order = plan.sessions[0].exercises[0].order;
    expect(planVersionSchema.safeParse(plan).success).toBe(false);
  });

  it('should reject duplicate session ids', () => {
    const plan = variant();
    plan.sessions[1].id = plan.sessions[0].id;
    expect(planVersionSchema.safeParse(plan).success).toBe(false);
  });

  it('should reject a block that ends before it starts', () => {
    const plan = variant();
    plan.effectiveFrom = '2026-09-01';
    plan.effectiveTo = '2026-08-31';
    expect(planVersionSchema.safeParse(plan).success).toBe(false);
  });

  it('should reject an unknown muscle group', () => {
    const plan = variant();
    plan.sessions[0].exercises[0].muscle = 'Delts';
    expect(planVersionSchema.safeParse(plan).success).toBe(false);
  });

  it('should reject a slot with no exercise options', () => {
    const plan = variant();
    plan.sessions[0].exercises[0].options = [];
    expect(planVersionSchema.safeParse(plan).success).toBe(false);
  });
});
