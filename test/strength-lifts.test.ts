import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  };
});

import { handler as getWorkout } from '../lambda/get-workout';
import {
  EARLIER_LIFTS,
  matchLoggedName,
  selectStrengthLifts,
  type LiftMonth,
  type LoggedLift,
} from '../lambda/strength-lifts';
import type { PlanExercise, PlanSession, PlanVersion } from '../lambda/workout-plan-schema';
import { planVersionItem } from '../lambda/workout-plan-schema';
import { SUMMARY_PK } from '../lambda/workout-schema';
import { UPPER_LOWER_V1 } from '../lambda/workout-plan-upper-lower';

const TODAY = '2026-10-03';

const slot = (order: number, options: string[], repsMax: number): PlanExercise => ({
  order,
  options,
  muscle: 'Chest',
  sets: { min: 3, max: 3 },
  reps: { min: repsMax - 2, max: repsMax },
  rpe: null,
  notes: '',
});

const session = (id: string, exercises: PlanExercise[]): PlanSession => ({
  id,
  name: id,
  notes: '',
  exercises,
});

const plan = (sessions: PlanSession[], rotation = sessions.map((s) => s.id)) => ({ sessions, rotation });

const lift = (name: string, sets: number, lastDate = '2026-09-30', bestE1rmKg = 80): LoggedLift => ({
  name,
  sets,
  lastDate,
  bestE1rmKg,
});

const month = (exercise: string, m: string, sets: number): LiftMonth => ({ exercise, month: m, sets });

describe('matchLoggedName', () => {
  const logged = new Map([
    ['pull up', 'Pull ups'],
    ['belt squat', 'Belt squat'],
  ]);

  test('folds case and a plural "s", since the plan is written by hand', () => {
    expect(matchLoggedName('Pull Up', logged)).toBe('Pull ups');
    expect(matchLoggedName('Belt Squat', logged)).toBe('Belt squat');
  });

  test('returns null rather than guessing a near miss', () => {
    expect(matchLoggedName('Chest-Supported Row', logged)).toBeNull();
  });
});

describe('selectStrengthLifts', () => {
  test('follows the plan: the bench a block dropped gives way to the press it runs', () => {
    const selected = selectStrengthLifts(
      plan([session('upper-a', [slot(1, ['Bench Press', 'Incline Dumbbell Bench Press'], 8)])]),
      [lift('Bench Press', 1270, '2026-08-08'), lift('Incline Dumbbell Bench Press', 520)],
      [
        month('Bench Press', '2026-08', 3),
        month('Incline Dumbbell Bench Press', '2026-08', 6),
        month('Incline Dumbbell Bench Press', '2026-09', 12),
      ],
      TODAY,
      8,
    );
    expect(selected).toEqual([
      { name: 'Incline Dumbbell Bench Press', tracked: true },
      // Not logged for over six weeks, so it stays on the chart, muted.
      { name: 'Bench Press', tracked: false },
    ]);
  });

  test('skips volume slots, whose 1RM estimate is noise', () => {
    const selected = selectStrengthLifts(
      plan([session('upper-a', [slot(1, ['Cable Crossover'], 15), slot(2, ['Pull ups'], 10)])]),
      [lift('Cable Crossover', 968), lift('Pull ups', 696)],
      [],
      TODAY,
      8,
    );
    expect(selected.filter((s) => s.tracked).map((s) => s.name)).toEqual(['Pull ups']);
  });

  test('orders by rotation, then slot, and charts a lift shared by two slots once', () => {
    const selected = selectStrengthLifts(
      plan(
        [
          session('lower-a', [slot(1, ['Belt squat'], 10)]),
          session('upper-a', [slot(2, ['Lat Pulldown'], 10), slot(1, ['Dumbbell Bench Press'], 8)]),
          session('upper-b', [slot(1, ['Lat Pulldown'], 10)]),
        ],
        ['upper-a', 'lower-a', 'upper-b'],
      ),
      [lift('Belt squat', 8), lift('Lat Pulldown', 738), lift('Dumbbell Bench Press', 132)],
      [],
      TODAY,
      8,
    );
    expect(selected.map((s) => s.name)).toEqual(['Dumbbell Bench Press', 'Lat Pulldown', 'Belt squat']);
  });

  test('with no recent sets, picks the most recently logged option', () => {
    const selected = selectStrengthLifts(
      plan([session('upper-b', [slot(1, ['Dumbbell Bench Press', 'Machine Bench Press'], 10)])]),
      [lift('Dumbbell Bench Press', 132), lift('Machine Bench Press', 127)],
      [month('Dumbbell Bench Press', '2024-01', 3), month('Machine Bench Press', '2024-05', 3)],
      TODAY,
      8,
    );
    expect(selected[0]).toEqual({ name: 'Machine Bench Press', tracked: true });
  });

  test('earlier lifts are capped, most-trained first, and exclude anything still being logged', () => {
    const selected = selectStrengthLifts(
      plan([]),
      [
        lift('Cable Crossover', 968, '2026-10-01'),
        lift('Bench Press', 1270, '2026-08-08'),
        lift('Barbell Squat', 628, '2026-06-19'),
        lift('Hip Abductor (Outer)', 527, '2026-07-27'),
        lift('Preacher Curl', 526, '2026-06-26'),
      ],
      [],
      TODAY,
      8,
    );
    expect(selected).toHaveLength(EARLIER_LIFTS);
    expect(selected.map((s) => s.name)).toEqual(['Bench Press', 'Barbell Squat', 'Hip Abductor (Outer)']);
    expect(selected.every((s) => !s.tracked)).toBe(true);
  });

  test('ignores lifts without a 1RM estimate', () => {
    const selected = selectStrengthLifts(
      plan([session('upper-a', [slot(1, ['Chin-Up'], 8)])]),
      [lift('Chin-Up', 10, '2026-09-30', 0)],
      [],
      TODAY,
      8,
    );
    expect(selected).toEqual([]);
  });

  test('with no plan, falls back to the all-time ranking', () => {
    const selected = selectStrengthLifts(
      null,
      [lift('Pull ups', 696), lift('Bench Press', 1270), lift('Lat Pulldown', 738)],
      [],
      TODAY,
      2,
    );
    expect(selected).toEqual([
      { name: 'Bench Press', tracked: true },
      { name: 'Lat Pulldown', tracked: true },
    ]);
  });
});

describe('GET /workout strength lifts', () => {
  const SUMMARY_TABLE = 'portfolio-workout-summary-test';
  const PLAN_TABLE = 'portfolio-workout-plan-test';

  const event = (query: Record<string, string> = {}): APIGatewayProxyEvent =>
    ({ queryStringParameters: query, headers: {} }) as unknown as APIGatewayProxyEvent;

  const exercise = (sk: string, sets: number, lastDate: string) => ({
    pk: SUMMARY_PK.exercise,
    sk,
    muscle: 'Chest',
    sets,
    lastDate,
    bestE1rm: 200,
    bestE1rmKg: 90,
    bestE1rmDate: lastDate,
  });

  const exerciseMonth = (exercise: string, month: string, sets: number) => ({
    pk: SUMMARY_PK.exerciseMonth,
    sk: `${exercise}#${month}`,
    exercise,
    month,
    sets,
    bestE1rmKg: 80,
  });

  const v5: PlanVersion = {
    ...UPPER_LOWER_V1,
    version: 5,
    effectiveFrom: '2026-10-03',
    effectiveTo: null,
    rotation: ['upper-a'],
    bonusSessions: [],
    sessions: [session('upper-a', [slot(1, ['Bench Press', 'Incline Dumbbell Bench Press'], 8)])],
  };
  const v4: PlanVersion = { ...v5, version: 4, effectiveFrom: '2026-07-13', effectiveTo: '2026-10-02' };

  const answerWith = (planItems: unknown[] | Error) => {
    mockSend.mockImplementation((command: { input: Record<string, unknown> }) => {
      if (command.input.TableName === PLAN_TABLE) {
        return planItems instanceof Error ? Promise.reject(planItems) : Promise.resolve({ Items: planItems });
      }
      const pk = (command.input.ExpressionAttributeValues as Record<string, string> | undefined)?.[':pk'];
      if (pk === SUMMARY_PK.exercise) {
        return Promise.resolve({
          Items: [exercise('Bench Press', 1270, '2026-08-08'), exercise('Incline Dumbbell Bench Press', 520, '2026-10-01')],
        });
      }
      if (pk === SUMMARY_PK.exerciseMonth) {
        return Promise.resolve({
          Items: [
            exerciseMonth('Bench Press', '2026-08', 3),
            exerciseMonth('Incline Dumbbell Bench Press', '2026-09', 12),
          ],
        });
      }
      return Promise.resolve({ Items: [], Item: undefined });
    });
  };

  const call = async () => JSON.parse((await getWorkout(event({ to: TODAY }))).body);

  beforeAll(() => {
    process.env.WORKOUT_SUMMARY_TABLE_NAME = SUMMARY_TABLE;
    process.env.WORKOUT_PLAN_TABLE_NAME = PLAN_TABLE;
  });
  beforeEach(() => mockSend.mockReset());

  test('charts the plan in force and marks when each version began', async () => {
    answerWith([planVersionItem(v4), planVersionItem(v5)]);
    const body = await call();
    expect(body.strengthSeries.map((s: { name: string; tracked: boolean }) => [s.name, s.tracked])).toEqual([
      ['Incline Dumbbell Bench Press', true],
      ['Bench Press', false],
    ]);
    expect(body.lifts[0]).toMatchObject({ name: 'Incline Dumbbell Bench Press', bestE1rmKg: 90, tracked: true });
    expect(body.planChanges).toEqual([
      { version: 4, effectiveFrom: '2026-07-13' },
      { version: 5, effectiveFrom: '2026-10-03' },
    ]);
  });

  test('only version numbers and dates of the plan leave the endpoint', async () => {
    answerWith([planVersionItem(v5)]);
    const raw = (await getWorkout(event({ to: TODAY }))).body;
    expect(raw).not.toContain(v5.name);
    expect(raw).not.toContain('changeNote');
  });

  test('an unreadable plan degrades to the all-time ranking instead of failing', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    answerWith(new Error('AccessDenied'));
    const result = await getWorkout(event({ to: TODAY }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.lifts.map((l: { name: string }) => l.name)).toEqual(['Bench Press', 'Incline Dumbbell Bench Press']);
    expect(body.planChanges).toEqual([]);
    error.mockRestore();
  });
});
