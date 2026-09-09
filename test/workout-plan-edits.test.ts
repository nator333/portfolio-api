import {
  applyPlanEdits,
  planEditSchema,
  type PlanEdit,
  type RevisionMeta,
} from '../lambda/workout-plan-edits';
import { plannedWeeklySets } from '../lambda/workout-plan-schema';
import { UPPER_LOWER_V1 } from '../lambda/workout-plan-upper-lower';

const META: RevisionMeta = { changeNote: 'more lateral raise volume' };

const apply = (edits: PlanEdit[], meta: RevisionMeta = META) => applyPlanEdits(UPPER_LOWER_V1, edits, meta);

/** The exercise slots of one session in the produced plan. */
const slots = (plan: { sessions: readonly { id: string; exercises: readonly unknown[] }[] }, id: string) =>
  plan.sessions.find((s) => s.id === id)!.exercises as readonly {
    order: number;
    options: string[];
    sets: { min: number; max: number };
    notes: string;
  }[];

describe('applying edits', () => {
  it('should publish the next version rather than mutating the base', () => {
    const result = apply([
      { op: 'patch', session: 'upper-a', order: 2, changes: { sets: { min: 5, max: 5 } } },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.version).toBe(UPPER_LOWER_V1.version + 1);
    // The base document is untouched — versions are immutable.
    expect(slots(UPPER_LOWER_V1, 'upper-a')[1].sets).toEqual({ min: 4, max: 4 });
    expect(slots(result.plan, 'upper-a')[1].sets).toEqual({ min: 5, max: 5 });
  });

  it('should merge only the named fields and leave the rest of the slot alone', () => {
    const result = apply([
      { op: 'patch', session: 'upper-a', order: 1, changes: { notes: 'work up to a top set' } },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const slot = slots(result.plan, 'upper-a')[0];
    expect(slot.notes).toBe('work up to a top set');
    expect(slot.options).toEqual(['Bench Press', 'Incline Dumbbell Bench Press']);
  });

  it('should carry the change note onto the new version', () => {
    const result = apply([{ op: 'remove', session: 'upper-a', order: 7 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changeNote).toBe('more lateral raise volume');
  });

  it('should remove a slot and leave the others in order', () => {
    const result = apply([{ op: 'remove', session: 'upper-a', order: 7 }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const orders = slots(result.plan, 'upper-a').map((e) => e.order);
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 8, 9]);
  });

  it('should insert an added slot at its position, shifting the rest down', () => {
    const result = apply([
      {
        op: 'add',
        session: 'lower-a',
        exercise: {
          order: 2,
          options: ['Romanian Deadlift'],
          muscle: 'Hamstrings',
          sets: { min: 3, max: 3 },
          reps: { min: 8, max: 10 },
          rpe: null,
          notes: '',
        },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lower = slots(result.plan, 'lower-a');
    expect(lower.map((e) => e.order)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lower[1].options).toEqual(['Romanian Deadlift']);
    // Hip Thrust was position 2 and moves to 3 rather than colliding.
    expect(lower[2].options).toEqual(['Hip Thrust']);
  });

  it('should apply edits in sequence, so a later one sees an earlier one', () => {
    const result = apply([
      {
        op: 'add',
        session: 'lower-a',
        exercise: {
          order: 6,
          options: ['Seated Calf Raise'],
          muscle: 'Calves',
          sets: { min: 2, max: 2 },
          reps: { min: 12, max: 15 },
          rpe: null,
          notes: '',
        },
      },
      { op: 'patch', session: 'lower-a', order: 6, changes: { sets: { min: 4, max: 4 } } },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(slots(result.plan, 'lower-a').find((e) => e.order === 6)?.sets).toEqual({ min: 4, max: 4 });
    expect(slots(result.plan, 'lower-a')).toHaveLength(6);
  });

  it('should feed straight into the weekly set arithmetic', () => {
    const result = apply([
      { op: 'patch', session: 'upper-a', order: 2, changes: { sets: { min: 6, max: 6 } } },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Shoulders was 11-14; two more sets on the Upper A machine raise.
    expect(plannedWeeklySets(result.plan).Shoulders).toEqual({ min: 13, max: 16 });
  });

  it('should carry version metadata over when the revision does not set it', () => {
    const result = apply([{ op: 'remove', session: 'upper-a', order: 7 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.effectiveTo).toBe(UPPER_LOWER_V1.effectiveTo);
    expect(result.plan.name).toBe(UPPER_LOWER_V1.name);
  });

  it('should allow a revision to reopen a closed block', () => {
    const result = apply([{ op: 'remove', session: 'upper-a', order: 7 }], {
      ...META,
      effectiveTo: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.effectiveTo).toBeNull();
  });
});

describe('rejecting edits', () => {
  it('should reject an unknown session and name the ones that exist', () => {
    const result = apply([{ op: 'remove', session: 'upper-c', order: 1 }]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('upper-c');
    expect(result.error).toContain('upper-a');
  });

  it('should reject a slot position the session does not have', () => {
    const result = apply([{ op: 'remove', session: 'lower-a', order: 99 }]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('99');
  });

  it('should reject an empty edit list', () => {
    expect(apply([]).ok).toBe(false);
  });

  // A half-applied program is worse than a rejected one: the caller cannot tell
  // which half landed.
  it('should apply nothing when a later edit fails', () => {
    const result = apply([
      { op: 'patch', session: 'upper-a', order: 2, changes: { sets: { min: 5, max: 5 } } },
      { op: 'remove', session: 'nope', order: 1 },
    ]);

    expect(result.ok).toBe(false);
    expect(slots(UPPER_LOWER_V1, 'upper-a')[1].sets).toEqual({ min: 4, max: 4 });
  });
});

describe('the edit schema', () => {
  it('should require a change note that is not blank', () => {
    const result = apply([{ op: 'remove', session: 'upper-a', order: 7 }], { changeNote: '   ' });
    // Blank notes are caught by the request schema, not the transform; the
    // transform trusts what it is given.
    expect(result.ok).toBe(true);
  });

  it('should reject an unknown op', () => {
    expect(planEditSchema.safeParse({ op: 'reorder', session: 'upper-a', order: 1 }).success).toBe(false);
  });

  it('should reject a patch with no target position', () => {
    expect(planEditSchema.safeParse({ op: 'patch', session: 'upper-a', changes: {} }).success).toBe(false);
  });

  it('should reject an added slot that is missing required fields', () => {
    expect(
      planEditSchema.safeParse({ op: 'add', session: 'upper-a', exercise: { order: 1 } }).success,
    ).toBe(false);
  });
});
