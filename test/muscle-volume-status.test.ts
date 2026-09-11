import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  };
});

import { handler as getStatus, DEFAULT_PLAN_ID } from '../lambda/get-muscle-volume-status';
import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  isBonusWindow,
  muscleVolumeStatus,
  parseWindowDays,
  rollUpSets,
  scaleTarget,
  statusFor,
  windowBounds,
} from '../lambda/muscle-volume-status';
import { UPPER_LOWER_V1 } from '../lambda/workout-plan-upper-lower';
import { planVersionItem } from '../lambda/workout-plan-schema';
import { SUMMARY_PK } from '../lambda/workout-schema';

const SUMMARY_TABLE = 'portfolio-workout-summary-test';
const PLAN_TABLE = 'portfolio-workout-plan-test';

const event = (query: Record<string, string> = {}): APIGatewayProxyEvent =>
  ({ queryStringParameters: query, headers: {} }) as unknown as APIGatewayProxyEvent;

/** A stored day summary, as the ingest writes it. */
const day = (sk: string, muscles: Record<string, number>) => ({ pk: SUMMARY_PK.day, sk, muscles });

/**
 * The handler fires the plan read and the day read together, so the mock is
 * keyed on the command rather than on call order.
 */
const answerWith = (opts: { plan?: unknown[]; days?: unknown[] }) => {
  mockSend.mockImplementation((command: { input: Record<string, unknown> }) => {
    if (command.input.TableName === PLAN_TABLE) {
      return Promise.resolve({ Items: opts.plan ?? [planVersionItem({ ...UPPER_LOWER_V1, version: 7 })] });
    }
    return Promise.resolve({ Items: opts.days ?? [] });
  });
};

const call = async (query: Record<string, string> = {}) => {
  const result = await getStatus(event(query));
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
};

type StatusRow = {
  muscle: string;
  sets: number;
  countedSets: number;
  sharedWith: string[];
  weeklyTarget: { min: number; max: number };
  target: { min: number; max: number };
  status: string;
};

const rowFor = (body: { muscles: StatusRow[] }, muscle: string): StatusRow | undefined =>
  body.muscles.find((m) => m.muscle === muscle);

const inputsFor = (table: string) =>
  mockSend.mock.calls.map((c) => c[0].input).filter((i) => i.TableName === table);

beforeAll(() => {
  process.env.WORKOUT_SUMMARY_TABLE_NAME = SUMMARY_TABLE;
  process.env.WORKOUT_PLAN_TABLE_NAME = PLAN_TABLE;
});

beforeEach(() => {
  mockSend.mockReset();
});

describe('the rolling window', () => {
  it('should span N whole UTC days inclusive of the day it ends on', () => {
    const bounds = windowBounds(new Date('2026-09-11T20:37:00Z'), 7);
    expect(bounds).toEqual({ days: 7, from: '2026-09-05', to: '2026-09-11' });
  });

  it('should not move with the time of day, only the date', () => {
    const morning = windowBounds(new Date('2026-09-11T00:00:01Z'), 7);
    const night = windowBounds(new Date('2026-09-11T23:59:59Z'), 7);
    expect(morning).toEqual(night);
  });

  it('should roll rather than reset, so a Monday is not a cliff', () => {
    // The Monday and the Sunday before it cover different days — which an ISO
    // week does not: it would blank the count at midnight.
    const sunday = windowBounds(new Date('2026-09-13T12:00:00Z'), 7);
    const monday = windowBounds(new Date('2026-09-14T12:00:00Z'), 7);
    expect(sunday).toEqual({ days: 7, from: '2026-09-07', to: '2026-09-13' });
    expect(monday).toEqual({ days: 7, from: '2026-09-08', to: '2026-09-14' });
  });

  it('should cross a month and a year boundary', () => {
    expect(windowBounds(new Date('2027-01-02T06:00:00Z'), 7).from).toBe('2026-12-27');
  });

  it('should default to seven days and accept an explicit width', () => {
    expect(parseWindowDays(undefined)).toEqual({ days: DEFAULT_WINDOW_DAYS });
    expect(parseWindowDays('')).toEqual({ days: DEFAULT_WINDOW_DAYS });
    expect(parseWindowDays('14')).toEqual({ days: 14 });
  });

  it('should reject a nonsensical window rather than silently serving the default', () => {
    // Quietly falling back would hand the caller seven days it would then read
    // as whatever it asked for.
    for (const bad of ['0', '-3', '2.5', 'fortnight', String(MAX_WINDOW_DAYS + 1)]) {
      expect(parseWindowDays(bad)).toHaveProperty('error');
    }
  });
});

describe('judging a count against a range', () => {
  it('should treat both bounds as inclusive', () => {
    const target = { min: 8, max: 9 };
    expect(statusFor(7, target)).toBe('under');
    expect(statusFor(8, target)).toBe('in_range');
    expect(statusFor(9, target)).toBe('in_range');
    expect(statusFor(10, target)).toBe('over');
  });

  it('should restate a weekly range over the requested window', () => {
    expect(scaleTarget({ min: 8, max: 9 }, 7)).toEqual({ min: 8, max: 9 });
    expect(scaleTarget({ min: 8, max: 9 }, 14)).toEqual({ min: 16, max: 18 });
    expect(scaleTarget({ min: 7, max: 14 }, 3)).toEqual({ min: 3, max: 6 });
  });

  it('should count a window with more sessions than the rotation as a bonus week', () => {
    expect(isBonusWindow(3, 3, 7)).toBe(false);
    expect(isBonusWindow(4, 3, 7)).toBe(true);
    // Scaled: a fortnight of the same three-a-week rotation is six sessions.
    expect(isBonusWindow(6, 3, 14)).toBe(false);
    expect(isBonusWindow(7, 3, 14)).toBe(true);
  });
});

describe('rolling up logged sets', () => {
  it('should total each muscle across the days given', () => {
    const totals = rollUpSets([
      { date: '2026-09-08', muscles: { Chest: 3, Triceps: 2 } },
      { date: '2026-09-10', muscles: { Chest: 5, Lats: 3 } },
    ]);
    expect(totals.get('Chest')).toBe(8);
    expect(totals.get('Triceps')).toBe(2);
    expect(totals.get('Lats')).toBe(3);
  });

  it('should ignore a group outside the vocabulary rather than invent a row', () => {
    const totals = rollUpSets([{ date: '2026-09-08', muscles: { Chest: 2, Rotators: 4 } }]);
    expect(totals.get('Chest')).toBe(2);
    expect([...totals.keys()]).not.toContain('Rotators');
  });

  it('should tolerate a day summary with no muscle tally', () => {
    expect(rollUpSets([{ date: '2026-09-08', muscles: {} }]).size).toBe(0);
  });
});

describe('the status rollup', () => {
  const counts = (entries: Record<string, number>) =>
    new Map(Object.entries(entries)) as Map<never, number>;

  it('should judge a shared target on the shared total, not on each half', () => {
    // The plan states glutes and hamstrings together at 9-11. Six sets of each
    // is twelve — over — even though neither muscle alone reaches the minimum.
    const { muscles } = muscleVolumeStatus(UPPER_LOWER_V1, counts({ Glutes: 6, Hamstrings: 6 }), {
      days: 7,
      sessions: 3,
    });
    const glutes = muscles.find((m) => m.muscle === 'Glutes');
    expect(glutes?.sets).toBe(6);
    expect(glutes?.countedSets).toBe(12);
    expect(glutes?.sharedWith).toEqual(['Hamstrings']);
    expect(glutes?.status).toBe('over');
    expect(muscles.find((m) => m.muscle === 'Hamstrings')?.status).toBe('over');
  });

  it('should leave sharedWith empty for a target covering one muscle', () => {
    const { muscles } = muscleVolumeStatus(UPPER_LOWER_V1, counts({ Chest: 8 }), {
      days: 7,
      sessions: 3,
    });
    const chest = muscles.find((m) => m.muscle === 'Chest');
    expect(chest?.sharedWith).toEqual([]);
    expect(chest?.countedSets).toBe(chest?.sets);
  });

  it('should switch to the bonus-week range when the window holds an extra session', () => {
    // Calves are 11 a week, 15 on a bonus week. Fifteen sets is exactly on
    // target after the fourth visit; against the base range it would read "over".
    const base = muscleVolumeStatus(UPPER_LOWER_V1, counts({ Calves: 15 }), {
      days: 7,
      sessions: 3,
    });
    expect(base.bonusWindow).toBe(false);
    expect(base.muscles.find((m) => m.muscle === 'Calves')?.status).toBe('over');

    const bonus = muscleVolumeStatus(UPPER_LOWER_V1, counts({ Calves: 15 }), {
      days: 7,
      sessions: 4,
    });
    expect(bonus.bonusWindow).toBe(true);
    expect(bonus.muscles.find((m) => m.muscle === 'Calves')?.weeklyTarget).toEqual({ min: 15, max: 15 });
    expect(bonus.muscles.find((m) => m.muscle === 'Calves')?.status).toBe('in_range');
  });

  it('should report a trained muscle the plan sets no target for', () => {
    const { untargeted, muscles } = muscleVolumeStatus(UPPER_LOWER_V1, counts({ Other: 4 }), {
      days: 7,
      sessions: 3,
    });
    expect(untargeted).toEqual([{ muscle: 'Other', sets: 4 }]);
    expect(muscles.find((m) => m.muscle === 'Other')).toBeUndefined();
  });

  it('should not list an untargeted muscle that was not trained', () => {
    const { untargeted } = muscleVolumeStatus(UPPER_LOWER_V1, counts({}), { days: 7, sessions: 0 });
    expect(untargeted).toEqual([]);
  });

  it('should emit rows in the shared muscle-group order', () => {
    const { muscles } = muscleVolumeStatus(UPPER_LOWER_V1, counts({}), { days: 7, sessions: 0 });
    expect(muscles.map((m) => m.muscle).slice(0, 4)).toEqual([
      'Chest',
      'Lats',
      'Quads',
      'Hamstrings',
    ]);
  });

  it('should ignore a second entry claiming a muscle rather than guess between them', () => {
    const contradictory = {
      sessionsPerWeek: 3,
      weeklySetTargets: [
        { muscles: ['Chest' as const], sets: { min: 8, max: 9 }, bonusWeekSets: null },
        { muscles: ['Chest' as const], sets: { min: 20, max: 30 }, bonusWeekSets: null },
      ],
    };
    const { muscles } = muscleVolumeStatus(contradictory, counts({ Chest: 9 }), {
      days: 7,
      sessions: 3,
    });
    expect(muscles.filter((m) => m.muscle === 'Chest')).toHaveLength(1);
    expect(muscles[0].weeklyTarget).toEqual({ min: 8, max: 9 });
  });
});

describe('the endpoint', () => {
  it('should roll the window up against the current plan version', async () => {
    answerWith({
      days: [
        day('2026-09-07', { Chest: 3, Shoulders: 4 }),
        day('2026-09-09', { Chest: 5, Lats: 3 }),
      ],
    });

    const { statusCode, body } = await call();

    expect(statusCode).toBe(200);
    expect(body.plan.version).toBe(7);
    expect(body.plan.planId).toBe(DEFAULT_PLAN_ID);
    expect(body.window.days).toBe(7);
    expect(body.sessions).toBe(2);
    expect(rowFor(body, 'Chest')).toMatchObject({ sets: 8, status: 'in_range' });
  });

  it('should read the current plan version on every call, never a cached one', async () => {
    answerWith({ plan: [planVersionItem({ ...UPPER_LOWER_V1, version: 4 })] });
    expect((await call()).body.plan.version).toBe(4);

    // A revision published between the two calls must show up in the second.
    answerWith({ plan: [planVersionItem({ ...UPPER_LOWER_V1, version: 5 })] });
    expect((await call()).body.plan.version).toBe(5);

    // And it is the cheap descending Limit-1 read, not a partition scan.
    const planReads = inputsFor(PLAN_TABLE);
    expect(planReads).toHaveLength(2);
    for (const read of planReads) {
      expect(read.ScanIndexForward).toBe(false);
      expect(read.Limit).toBe(1);
    }
  });

  it('should stamp asOf and bound the window by it', async () => {
    answerWith({});
    const { body } = await call();

    const asOf = new Date(body.asOf);
    expect(Number.isNaN(asOf.getTime())).toBe(false);
    expect(body.window.to).toBe(body.asOf.slice(0, 10));
    expect(windowBounds(asOf, 7)).toEqual(body.window);
  });

  it('should query only the days inside the window', async () => {
    answerWith({});
    const { body } = await call({ window: '14' });

    const [read] = inputsFor(SUMMARY_TABLE);
    expect(read.ExpressionAttributeValues[':pk']).toBe(SUMMARY_PK.day);
    expect(read.ExpressionAttributeValues[':from']).toBe(body.window.from);
    expect(read.ExpressionAttributeValues[':to']).toBe(body.window.to);
  });

  it('should scale the weekly target to a wider window', async () => {
    answerWith({ days: [day('2026-09-09', { Chest: 17 })] });
    const { body } = await call({ window: '14' });

    // Chest is 8-9 a week, so a fortnight is 16-18: seventeen sets is on target
    // over fourteen days and would read "over" against the unscaled range.
    expect(rowFor(body, 'Chest')).toMatchObject({
      weeklyTarget: { min: 8, max: 9 },
      target: { min: 16, max: 18 },
      sets: 17,
      status: 'in_range',
    });
  });

  it('should reject a malformed window without reading anything', async () => {
    answerWith({});
    const { statusCode, body } = await call({ window: 'fortnight' });
    expect(statusCode).toBe(400);
    expect(body.message).toMatch(/window/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('should paginate a window whose days span a page', async () => {
    mockSend.mockImplementation((command: { input: Record<string, unknown> }) => {
      if (command.input.TableName === PLAN_TABLE) {
        return Promise.resolve({ Items: [planVersionItem({ ...UPPER_LOWER_V1, version: 1 })] });
      }
      if (!command.input.ExclusiveStartKey) {
        return Promise.resolve({
          Items: [day('2026-09-07', { Chest: 4 })],
          LastEvaluatedKey: { pk: SUMMARY_PK.day, sk: '2026-09-07' },
        });
      }
      return Promise.resolve({ Items: [day('2026-09-09', { Chest: 4 })] });
    });

    const { body } = await call();
    expect(rowFor(body, 'Chest')?.sets).toBe(8);
    expect(body.sessions).toBe(2);
  });

  it('should 404 when the plan has never been published', async () => {
    answerWith({ plan: [] });
    const { statusCode, body } = await call();
    expect(statusCode).toBe(404);
    expect(body.message).toMatch(/has been published/);
  });

  it('should 500 when either table is unconfigured', async () => {
    const saved = process.env.WORKOUT_PLAN_TABLE_NAME;
    delete process.env.WORKOUT_PLAN_TABLE_NAME;
    const { statusCode } = await call();
    expect(statusCode).toBe(500);
    process.env.WORKOUT_PLAN_TABLE_NAME = saved;
  });
});

/**
 * The discrepancies this endpoint was built to end. Each case is a set count
 * that the progress page's own table of ranges called "under" (or had no
 * opinion on at all) while the plan it was judging asked for something else.
 */
describe('the discrepancies that motivated the endpoint', () => {
  const atSets = async (muscles: Record<string, number>) => {
    answerWith({ days: [day('2026-09-09', muscles)] });
    return (await call()).body;
  };

  it('should call a programmed chest week in range rather than under', async () => {
    // The page judged chest against 10-22 and reported 8 and 9 sets as "under";
    // the program asks for 8-9.
    expect(rowFor(await atSets({ Chest: 8 }), 'Chest')).toMatchObject({
      target: { min: 8, max: 9 },
      status: 'in_range',
    });
    expect(rowFor(await atSets({ Chest: 9 }), 'Chest')?.status).toBe('in_range');
    expect(rowFor(await atSets({ Chest: 7 }), 'Chest')?.status).toBe('under');
  });

  it('should call a programmed lats week in range rather than under', async () => {
    // The page judged lats against 10-25 and reported 6 sets as "under"; the
    // program asks for exactly 6.
    expect(rowFor(await atSets({ Lats: 6 }), 'Lats')).toMatchObject({
      target: { min: 6, max: 6 },
      status: 'in_range',
    });
    expect(rowFor(await atSets({ Lats: 5 }), 'Lats')?.status).toBe('under');
    expect(rowFor(await atSets({ Lats: 7 }), 'Lats')?.status).toBe('over');
  });

  it('should carry a target for abs, traps and forearms', async () => {
    // These three had a range on the progress page and none in the plan, so the
    // page and the plan disagreed about whether they had a target at all.
    const body = await atSets({ Abs: 8, Traps: 8, Forearms: 6 });
    expect(rowFor(body, 'Traps')).toMatchObject({ target: { min: 6, max: 20 }, status: 'in_range' });
    expect(rowFor(body, 'Abs')).toMatchObject({ target: { min: 6, max: 16 }, status: 'in_range' });
    expect(rowFor(body, 'Forearms')).toMatchObject({ target: { min: 4, max: 12 }, status: 'in_range' });
    // And none of them is reported as a muscle the plan forgot.
    expect(body.untargeted.map((u: { muscle: string }) => u.muscle)).not.toEqual(
      expect.arrayContaining(['Abs', 'Traps', 'Forearms']),
    );
  });

  it('should give every muscle the progress page charts a target', async () => {
    // The page's own table covered these twelve; the plan must cover at least
    // the same ground, or pointing the page at this endpoint drops a bar.
    const body = await atSets({});
    const charted = [
      'Chest', 'Lats', 'Quads', 'Hamstrings', 'Glutes', 'Shoulders',
      'Biceps', 'Triceps', 'Traps', 'Calves', 'Abs', 'Forearms',
    ];
    expect(body.muscles.map((m: { muscle: string }) => m.muscle).sort()).toEqual(charted.sort());
  });
});
