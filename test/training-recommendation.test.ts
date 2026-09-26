import {
  prescribeSlot,
  rankSessions,
  recommendTraining,
  type ReadinessSummary,
} from '../lambda/training-recommendation';
import type { VolumeStatus } from '../lambda/muscle-volume-status';
import type { MuscleGroup } from '../lambda/workout-muscles';
import type { PlanExercise } from '../lambda/workout-plan-schema';
import { UPPER_LOWER_V1 } from '../lambda/workout-plan-upper-lower';

const { rotation, bonusSessions, sessions } = UPPER_LOWER_V1;

/** Every targeted muscle in range, with the given overrides. */
const volume = (over: Partial<Record<MuscleGroup, VolumeStatus>> = {}) =>
  (['Chest', 'Shoulders', 'Lats', 'Biceps', 'Triceps', 'Quads', 'Glutes', 'Hamstrings', 'Calves'] as MuscleGroup[]).map(
    (muscle) => ({ muscle, status: over[muscle] ?? ('in_range' as VolumeStatus) }),
  );

const ready = (verdict: 'push' | 'normal' | 'easy'): ReadinessSummary => ({
  status: 'ready',
  date: '2026-09-26',
  verdict,
  reasons: [],
});

const recommend = (readiness: ReadinessSummary, over: Partial<Record<MuscleGroup, VolumeStatus>> = {}) =>
  recommendTraining({ readiness, volume: volume(over), rotation, bonusSessions, sessions });

const slot = (over: Partial<PlanExercise> = {}): PlanExercise => ({
  order: 1,
  options: ['Bench Press'],
  muscle: 'Chest',
  sets: { min: 3, max: 4 },
  reps: { min: 6, max: 8 },
  rpe: { min: 7, max: 8 },
  notes: '',
  ...over,
});

describe('choosing the session', () => {
  test('the session training what is behind wins', () => {
    const result = recommend(ready('normal'), { Quads: 'under', Hamstrings: 'under' });
    expect(result.session?.id).toBe('lower-a');
    expect(result.session?.behind.map((m) => m.muscle)).toEqual(['Quads', 'Hamstrings']);
  });

  test('a muscle counts once per session, however many slots hit it', () => {
    // Lower B has three quad slots, Lower A two; with quads the only muscle
    // behind, neither is "more" the quad day for it.
    const ranked = rankSessions(
      sessions,
      new Map(volume({ Quads: 'under' }).map((r) => [r.muscle, r.status])),
      rotation,
      bonusSessions,
    );
    const score = (id: string) => ranked.find((s) => s.id === id)?.score;
    expect(score('lower-a')).toBe(score('lower-b'));
    // …and the tie goes to the rotation session over the bonus one.
    expect(ranked[0].id).toBe('lower-a');
  });

  test('over-target muscles count against a session', () => {
    const result = recommend(ready('normal'), { Chest: 'over', Shoulders: 'over' });
    expect(['upper-a', 'upper-b']).not.toContain(result.session?.id);
  });

  test('with everything in range, the rotation order decides', () => {
    expect(recommend(ready('normal')).session?.id).toBe('upper-a');
  });
});

describe('prescribing a slot', () => {
  test('push runs the top of the set range, never beyond it', () => {
    expect(prescribeSlot(slot(), 'push', 'under')).toMatchObject({ action: 'top', sets: { min: 4, max: 4 }, rpe: { min: 7, max: 8 } });
    // An exact prescription has no top to move to.
    expect(prescribeSlot(slot({ sets: { min: 3, max: 3 } }), 'push', 'under').action).toBe('as_planned');
  });

  test('normal keeps the prescription', () => {
    expect(prescribeSlot(slot(), 'normal', 'in_range')).toMatchObject({
      action: 'as_planned',
      sets: { min: 3, max: 4 },
      rpe: { min: 7, max: 8 },
    });
  });

  test('easy cuts to about two-thirds of the minimum sets and one RPE point', () => {
    expect(prescribeSlot(slot(), 'easy', 'under')).toMatchObject({
      action: 'reduced',
      sets: { min: 2, max: 2 },
      rpe: { min: 6, max: 7 },
    });
    // Never to zero: an easy day still trains what it trains.
    expect(prescribeSlot(slot({ sets: { min: 1, max: 1 }, rpe: null }), 'easy', 'under')).toMatchObject({
      sets: { min: 1, max: 1 },
      rpe: null,
    });
  });

  test('an over-target muscle is held to its minimum, or dropped on an easy day', () => {
    expect(prescribeSlot(slot(), 'push', 'over')).toMatchObject({ action: 'reduced', sets: { min: 3, max: 3 } });
    expect(prescribeSlot(slot(), 'easy', 'over')).toMatchObject({ action: 'skip', sets: null });
  });

  test('the planned prescription is always carried for comparison', () => {
    expect(prescribeSlot(slot(), 'easy', 'under').planned).toEqual({ sets: { min: 3, max: 4 }, rpe: { min: 7, max: 8 } });
  });
});

describe('the recommendation', () => {
  test('a ready verdict prescribes every slot of the chosen session, in order', () => {
    const result = recommend(ready('easy'), { Quads: 'under' });
    expect(result.session?.id).toBe('lower-a');
    expect(result.prescription?.map((p) => p.order)).toEqual([1, 2, 3, 4, 5]);
    expect(result.prescription?.every((p) => p.action === 'reduced')).toBe(true);
    expect(result.restSuggested).toBe(false);
  });

  test('without a verdict, the session is still chosen but intensity is withheld', () => {
    const notSynced: ReadinessSummary = { status: 'not_synced', date: '2026-09-26', verdict: null, reasons: ['…'] };
    const result = recommend(notSynced, { Quads: 'under' });
    expect(result.session?.id).toBe('lower-a');
    expect(result.prescription).toBeNull();
    expect(result.notes.join(' ')).toMatch(/no verdict yet/);
  });

  test('an unreadable readiness is said so, not treated as a verdict', () => {
    const unavailable: ReadinessSummary = { status: 'unavailable', date: null, verdict: null, reasons: ['not connected'] };
    const result = recommend(unavailable);
    expect(result.prescription).toBeNull();
    expect(result.notes.join(' ')).toMatch(/could not be read/);
  });

  test('an easy day with nothing behind suggests rest', () => {
    const result = recommend(ready('easy'));
    expect(result.restSuggested).toBe(true);
    // The session is still there for anyone who trains anyway.
    expect(result.session).not.toBeNull();
  });

  test('a push day with nothing behind is not a rest day', () => {
    expect(recommend(ready('push')).restSuggested).toBe(false);
  });
});
