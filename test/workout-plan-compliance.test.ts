import { checkMenuAgainstTargets, describeBreach } from '../lambda/workout-plan-compliance';
import type { WeeklySetTarget } from '../lambda/workout-plan-schema';

/**
 * The one-way dependency between a program's two halves: the sessions exist to
 * deliver the volume the targets ask for, so a menu must respect the targets and
 * never the reverse.
 */

/** A menu whose rotation prescribes exactly `sets` of `muscle` per week. */
const menuPrescribing = (
  slots: { muscle: string; min: number; max: number; session?: string }[],
  bonusSlots: { muscle: string; min: number; max: number }[] = [],
) => ({
  rotation: ['a'],
  bonusSessions: bonusSlots.length ? ['b'] : [],
  sessions: [
    {
      id: 'a',
      name: 'A',
      notes: '',
      exercises: slots.map((s, i) => ({
        order: i + 1,
        options: ['X'],
        muscle: s.muscle as never,
        sets: { min: s.min, max: s.max },
        reps: { min: 8, max: 10 },
        rpe: null,
        notes: '',
      })),
    },
    {
      id: 'b',
      name: 'B',
      notes: '',
      exercises: bonusSlots.map((s, i) => ({
        order: i + 1,
        options: ['X'],
        muscle: s.muscle as never,
        sets: { min: s.min, max: s.max },
        reps: { min: 8, max: 10 },
        rpe: null,
        notes: '',
      })),
    },
  ],
});

const target = (
  muscles: string[],
  min: number,
  max: number,
  bonus: { min: number; max: number } | null = null,
): WeeklySetTarget =>
  ({ muscles, sets: { min, max }, bonusWeekSets: bonus }) as unknown as WeeklySetTarget;

describe('checking a menu against its targets', () => {
  it('should pass a menu that fits inside its targets', () => {
    const result = checkMenuAgainstTargets(
      menuPrescribing([{ muscle: 'Chest', min: 6, max: 8 }]),
      [target(['Chest'], 6, 9)],
    );
    expect(result.breaches).toEqual([]);
    expect(result.bonusWarnings).toEqual([]);
  });

  it('should pass a menu that sits exactly on the ceiling', () => {
    const { breaches } = checkMenuAgainstTargets(
      menuPrescribing([{ muscle: 'Chest', min: 8, max: 9 }]),
      [target(['Chest'], 8, 9)],
    );
    expect(breaches).toEqual([]);
  });

  it('should flag a menu prescribing more than the target allows', () => {
    // The original bug: shoulders programmed to 14, declared at a ceiling of 11.
    const { breaches } = checkMenuAgainstTargets(
      menuPrescribing([
        { muscle: 'Shoulders', min: 4, max: 7 },
        { muscle: 'Shoulders', min: 4, max: 7 },
      ]),
      [target(['Shoulders'], 9, 11)],
    );
    expect(breaches).toEqual([{ muscles: ['Shoulders'], prescribed: 14, allowed: 11 }]);
    expect(describeBreach(breaches[0])).toBe(
      'Shoulders is prescribed 14 sets a week but its target allows at most 11',
    );
  });

  it('should allow a target above the prescription, which is why targets exist', () => {
    // Indirect volume the slot list cannot express — never a contradiction.
    const { breaches } = checkMenuAgainstTargets(
      menuPrescribing([{ muscle: 'Glutes', min: 3, max: 3 }]),
      [target(['Glutes', 'Hamstrings'], 9, 11)],
    );
    expect(breaches).toEqual([]);
  });

  it('should judge a shared target on the muscles combined', () => {
    // Six each is twelve, over the pair's ceiling, though neither alone exceeds it.
    const { breaches } = checkMenuAgainstTargets(
      menuPrescribing([
        { muscle: 'Glutes', min: 6, max: 6 },
        { muscle: 'Hamstrings', min: 6, max: 6 },
      ]),
      [target(['Glutes', 'Hamstrings'], 9, 11)],
    );
    expect(breaches).toEqual([
      { muscles: ['Glutes', 'Hamstrings'], prescribed: 12, allowed: 11 },
    ]);
  });

  it('should ignore a target no slot prescribes', () => {
    // Abs has a target and no direct work; that is a gap in the program, not a
    // contradiction, and it is the status endpoint's job to report it.
    const { breaches } = checkMenuAgainstTargets(
      menuPrescribing([{ muscle: 'Chest', min: 3, max: 3 }]),
      [target(['Abs'], 6, 16)],
    );
    expect(breaches).toEqual([]);
  });

  it('should report a bonus-week overshoot as a warning, not a breach', () => {
    const result = checkMenuAgainstTargets(
      menuPrescribing(
        [{ muscle: 'Quads', min: 5, max: 6 }],
        [{ muscle: 'Quads', min: 8, max: 9 }],
      ),
      [target(['Quads'], 8, 10)],
    );
    expect(result.breaches).toEqual([]);
    expect(result.bonusWarnings).toEqual([{ muscles: ['Quads'], prescribed: 15, allowed: 10 }]);
  });

  it('should judge a bonus week against the bonus range when one is declared', () => {
    const result = checkMenuAgainstTargets(
      menuPrescribing(
        [{ muscle: 'Calves', min: 11, max: 11 }],
        [{ muscle: 'Calves', min: 3, max: 3 }],
      ),
      [target(['Calves'], 11, 11, { min: 15, max: 15 })],
    );
    expect(result.breaches).toEqual([]);
    // 14 sets on a bonus week, against a bonus ceiling of 15.
    expect(result.bonusWarnings).toEqual([]);
  });

  it('should not report the same muscle as both a breach and a bonus warning', () => {
    // Already broken on the ordinary rotation; saying so twice helps nobody.
    const result = checkMenuAgainstTargets(
      menuPrescribing(
        [{ muscle: 'Shoulders', min: 14, max: 14 }],
        [{ muscle: 'Shoulders', min: 4, max: 4 }],
      ),
      [target(['Shoulders'], 9, 11)],
    );
    expect(result.breaches).toHaveLength(1);
    expect(result.bonusWarnings).toEqual([]);
  });
});
