import {
  daysSinceTrained,
  prescribeSlot,
  rankSessions,
  recommendTraining,
  type ReadinessSummary,
  type TrainingDay,
} from '../lambda/training-recommendation';
import type { VolumeStatus } from '../lambda/muscle-volume-status';
import type { MuscleGroup } from '../lambda/workout-muscles';
import type { PlanExercise, PlanSession } from '../lambda/workout-plan-schema';
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
  recommendTraining({ readiness, volume: volume(over), rotation, bonusSessions, sessions, today: '2026-09-26', trainingDays: [] });

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
    expect(result.volumeOnly.session?.id).toBe('lower-a');
    expect(result.volumeOnly.session?.behind.map((m) => m.muscle)).toEqual(['Quads', 'Hamstrings']);
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

  test('the recovery-aware score counts behind muscles, not how far behind or over others are', () => {
    const ranked = rankSessions(
      sessions,
      new Map(volume({ Quads: 'under', Hamstrings: 'maintenance', Calves: 'over' }).map((r) => [r.muscle, r.status])),
      rotation,
      bonusSessions,
    );
    expect(ranked.find((s) => s.id === 'lower-a')?.score).toBe(2);
  });

  test('over-target muscles count against a session', () => {
    const result = recommend(ready('normal'), { Chest: 'over', Shoulders: 'over' });
    expect(['upper-a', 'upper-b']).not.toContain(result.volumeOnly.session?.id);
    expect(result.volumeOnly.session).not.toHaveProperty('recovery');
  });

  test('with everything in range, the rotation order decides', () => {
    expect(recommend(ready('normal')).volumeOnly.session?.id).toBe('upper-a');
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
    expect(result.volumeOnly.session?.id).toBe('lower-a');
    expect(result.volumeOnly.prescription?.map((p) => p.order)).toEqual([1, 2, 3, 4, 5]);
    expect(result.volumeOnly.prescription?.every((p) => p.action === 'reduced')).toBe(true);
    expect(result.volumeOnly.restSuggested).toBe(false);
  });

  test('without a verdict, the session is still chosen but intensity is withheld', () => {
    const notSynced: ReadinessSummary = { status: 'not_synced', date: '2026-09-26', verdict: null, reasons: ['…'] };
    const result = recommend(notSynced, { Quads: 'under' });
    expect(result.volumeOnly.session?.id).toBe('lower-a');
    expect(result.volumeOnly.prescription).toBeNull();
    expect(result.notes.join(' ')).toMatch(/no verdict yet/);
  });

  test('an unreadable readiness is said so, not treated as a verdict', () => {
    const unavailable: ReadinessSummary = { status: 'unavailable', date: null, verdict: null, reasons: ['not connected'] };
    const result = recommend(unavailable);
    expect(result.volumeOnly.prescription).toBeNull();
    expect(result.notes.join(' ')).toMatch(/could not be read/);
  });

  test('an easy day with nothing behind suggests rest', () => {
    const result = recommend(ready('easy'));
    expect(result.volumeOnly.restSuggested).toBe(true);
    // The session is still there for anyone who trains anyway.
    expect(result.volumeOnly.session).not.toBeNull();
  });

  test('a push day with nothing behind is not a rest day', () => {
    expect(recommend(ready('push')).volumeOnly.restSuggested).toBe(false);
  });
});

/**
 * The v11 menu as published on 2026-10-21, reduced to what ranking reads:
 * each slot's muscle and set range.
 */
const slots = (...list: [MuscleGroup, number][]): PlanExercise[] =>
  list.map(([muscle, sets], i) => ({
    order: i + 1,
    options: [muscle],
    muscle,
    sets: { min: sets, max: sets },
    reps: { min: 8, max: 12 },
    rpe: null,
    notes: '',
  }));

const V11_SESSIONS: PlanSession[] = [
  {
    id: 'upper-a',
    name: 'Upper A',
    notes: '',
    exercises: slots(['Chest', 3], ['Shoulders', 4], ['Lats', 3], ['Lats', 3], ['Shoulders', 3], ['Chest', 3], ['Biceps', 4], ['Biceps', 3], ['Triceps', 3]),
  },
  {
    id: 'lower-a',
    name: 'Lower A',
    notes: '',
    exercises: slots(['Quads', 3], ['Glutes', 4], ['Hamstrings', 4], ['Quads', 3], ['Calves', 3], ['Traps', 3], ['Forearms', 3]),
  },
  {
    id: 'upper-b',
    name: 'Upper B',
    notes: '',
    exercises: slots(['Lats', 3], ['Shoulders', 3], ['Chest', 4], ['Lats', 3], ['Shoulders', 3], ['Triceps', 2], ['Biceps', 3], ['Triceps', 3], ['Calves', 4]),
  },
  {
    id: 'lower-b',
    name: 'Lower B',
    notes: '',
    exercises: slots(['Quads', 3], ['Quads', 3], ['Glutes', 2], ['Hamstrings', 4], ['Quads', 3], ['Calves', 3], ['Shoulders', 3], ['Forearms', 3]),
  },
];
const V11_ROTATION = ['upper-a', 'lower-a', 'upper-b', 'lower-b'];

/** The volume status as read on 2026-10-21: everything behind was at maintenance. */
const OCT21_VOLUME = (['Shoulders', 'Chest', 'Lats', 'Triceps', 'Biceps', 'Quads', 'Calves', 'Traps', 'Abs', 'Forearms', 'Hamstrings', 'Glutes'] as MuscleGroup[]).map(
  (muscle) => ({
    muscle,
    status: (['Lats', 'Quads', 'Traps', 'Abs'].includes(muscle) ? 'in_range' : 'maintenance') as VolumeStatus,
  }),
);

/** The muscles logged on each training day in the week before. */
const OCT_LOG: TrainingDay[] = [
  { date: '2026-10-16', muscles: ['Biceps', 'Chest', 'Shoulders', 'Lats', 'Triceps'] },
  { date: '2026-10-18', muscles: ['Quads', 'Glutes', 'Shoulders', 'Calves', 'Hamstrings', 'Forearms'] },
  { date: '2026-10-20', muscles: ['Biceps', 'Triceps', 'Chest', 'Shoulders', 'Other', 'Lats', 'Calves'] },
];

const recommendOct21 = (over: Partial<Parameters<typeof recommendTraining>[0]> = {}) =>
  recommendTraining({
    readiness: ready('easy'),
    volume: OCT21_VOLUME,
    rotation: V11_ROTATION,
    bonusSessions: [],
    sessions: V11_SESSIONS,
    today: '2026-10-21',
    trainingDays: OCT_LOG,
    ...over,
  });

describe('recovery', () => {
  test('days since trained is the most recent day within the lookback, in whole days', () => {
    const since = daysSinceTrained(
      [...OCT_LOG, { date: '2026-10-01', muscles: ['Abs'] }, { date: '2026-10-22', muscles: ['Quads'] }],
      '2026-10-21',
    );
    expect(since.get('Chest')).toBe(1);
    expect(since.get('Shoulders')).toBe(1);
    expect(since.get('Quads')).toBe(3);
    // Twenty days back is outside the lookback; tomorrow is not history.
    expect(since.has('Abs')).toBe(false);
  });

  test('2026-10-21: with recovery, the session done yesterday is not the pick', () => {
    const result = recommendOct21().recoveryAware;
    const all = [result.session!, ...result.alternatives];
    const byId = (id: string) => all.find((s) => s.id === id)!;

    expect(result.session?.id).toBe('lower-b');
    expect(all.map((s) => s.id)).toEqual(['lower-b', 'lower-a', 'upper-b', 'upper-a']);
    expect(Object.fromEntries(all.map((s) => [s.id, s.score]))).toEqual({
      'lower-b': 5,
      'lower-a': 4,
      'upper-b': 2,
      'upper-a': 1,
    });

    const upperB = byId('upper-b');
    expect(upperB.recovery.recoveryBlocked).toBe(true);
    // Lats 6 + Chest 4 + Triceps 5 + Biceps 3 of 28 planned sets.
    expect(upperB.recovery.unrecoveredSetShare).toBe(0.64);
    expect(upperB.recovery.daysSinceByMuscle).toEqual({
      Lats: 1,
      Shoulders: 1,
      Chest: 1,
      Triceps: 1,
      Biceps: 1,
      Calves: 1,
    });
    expect(byId('lower-b').recovery).toMatchObject({ recoveryBlocked: false, unrecoveredSetShare: 0 });
    expect(byId('lower-a').recovery.daysSinceByMuscle).toMatchObject({ Quads: 3, Traps: null });

    expect(result.restSuggested).toBe(false);
    expect(result.notes.some((n) => n.startsWith('Upper B moved down from 1st to 3rd for recovery (recovery-blocked'))).toBe(true);
    expect(result.notes.some((n) => n.startsWith('Upper A moved down'))).toBe(true);
    expect(result.notes.some((n) => n.startsWith('Lower B moved down'))).toBe(false);
  });

  test('2026-10-21: volumeOnly is the answer as it was, and the disagreement is noted', () => {
    const full = recommendOct21();
    const result = full.volumeOnly;
    // What the tool answered that morning, before recovery was considered.
    expect(result.session).toMatchObject({ id: 'upper-b', score: 5 });
    expect(result.session).not.toHaveProperty('recovery');
    expect(result.alternatives.map((s) => [s.id, s.score])).toEqual([
      ['lower-b', 5],
      ['upper-a', 4],
      ['lower-a', 4],
    ]);
    expect(result.prescription?.map((p) => p.muscle)).toEqual(
      V11_SESSIONS.find((s) => s.id === 'upper-b')!.exercises.map((e) => e.muscle),
    );
    expect(result.restSuggested).toBe(false);
    expect(result.notes).toEqual([]);
    expect(full.notes).toEqual(['The rankings disagree: volumeOnly picks Upper B, recoveryAware picks Lower B.']);
    expect(full.recoveryAware.prescription?.map((p) => p.muscle)).toEqual(
      V11_SESSIONS.find((s) => s.id === 'lower-b')!.exercises.map((e) => e.muscle),
    );
  });

  test('when both picks agree, there is no note saying otherwise', () => {
    const result = recommendOct21({ trainingDays: [] });
    expect(result.volumeOnly.session?.id).toBe(result.recoveryAware.session?.id);
    expect(result.notes.join(' ')).not.toMatch(/disagree/);
  });

  test('a blocked session ranks below an unblocked one whatever its score', () => {
    // With shoulders and calves behind, Upper B scores 2 on its recovered
    // shoulders and calves, Lower A 1 on calves alone — and Lower A still wins.
    const volume = OCT21_VOLUME.map((row) => ({
      ...row,
      status: (['Shoulders', 'Calves'].includes(row.muscle) ? 'under' : 'in_range') as VolumeStatus,
    }));
    const result = recommendOct21({ volume, sessions: V11_SESSIONS.filter((s) => s.id !== 'lower-b') }).recoveryAware;
    expect(result.session?.id).toBe('lower-a');
    expect(result.session?.score).toBe(1);
    expect(result.alternatives.find((s) => s.id === 'upper-b')).toMatchObject({ score: 2, recovery: { recoveryBlocked: true } });
  });

  test('every session blocked suggests rest, on any verdict', () => {
    const everything: TrainingDay = { date: '2026-10-20', muscles: OCT21_VOLUME.map((r) => r.muscle) };
    const full = recommendOct21({ readiness: ready('push'), trainingDays: [everything] });
    const result = full.recoveryAware;
    expect([result.session!, ...result.alternatives].every((s) => s.recovery.recoveryBlocked)).toBe(true);
    expect(result.restSuggested).toBe(true);
    expect(result.notes.join(' ')).toMatch(/rest today/);
    // The volume-only ranking does not know about recovery.
    expect(full.volumeOnly.restSuggested).toBe(false);
  });

  test('on a tied score the more rested session wins', () => {
    // Lower A and Lower B both score 1 (only Hamstrings behind). Lower A's
    // muscles were trained two days ago, Lower B's five: Lower B is fresher,
    // though Lower A comes first in the rotation.
    const volume = OCT21_VOLUME.map((row) => ({
      ...row,
      status: (row.muscle === 'Hamstrings' ? 'under' : 'in_range') as VolumeStatus,
    }));
    const trainingDays: TrainingDay[] = [
      { date: '2026-10-16', muscles: ['Quads', 'Glutes', 'Hamstrings', 'Calves', 'Shoulders', 'Forearms'] },
      { date: '2026-10-19', muscles: ['Traps'] },
    ];
    const ranked = rankSessions(V11_SESSIONS, new Map(volume.map((r) => [r.muscle, r.status])), V11_ROTATION, [], {
      daysSince: daysSinceTrained(trainingDays, '2026-10-21'),
      config: { defaultDays: 2, byMuscle: {} },
    });
    const lowerA = ranked.find((s) => s.id === 'lower-a')!;
    const lowerB = ranked.find((s) => s.id === 'lower-b')!;
    expect(lowerA.score).toBe(lowerB.score);
    expect(ranked.indexOf(lowerB)).toBeLessThan(ranked.indexOf(lowerA));
  });

  test('the recovery minimum is configurable per muscle', () => {
    // With shoulders and calves on the two-day default, Upper B's score drops
    // to zero on 2026-10-21.
    const result = recommendOct21({ recovery: { defaultDays: 2, byMuscle: {} } }).recoveryAware;
    const upperB = [result.session!, ...result.alternatives].find((s) => s.id === 'upper-b')!;
    expect(upperB.score).toBe(0);
    expect(upperB.recovery.unrecoveredSetShare).toBe(1);
  });
});
