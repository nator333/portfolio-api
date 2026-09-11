import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();

/** Target-set items the handlers should see, answered by sort-key prefix. */
let mockTargetItems: unknown[] = [];

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: () => ({
        send: (command: { input?: Record<string, unknown> }) => {
          const values = command?.input?.ExpressionAttributeValues as
            | Record<string, string>
            | undefined;
          if (values?.[':prefix'] === 'T#') return Promise.resolve({ Items: mockTargetItems });
          return mockSend(command);
        },
      }),
    },
  };
});

import { handler as getTargets } from '../lambda/get-workout-targets';
import { handler as updateTargets } from '../lambda/update-workout-targets';
import { planVersionItem, targetSetItem } from '../lambda/workout-plan-schema';
import { UPPER_LOWER_TARGETS_V1, UPPER_LOWER_V1 } from '../lambda/workout-plan-upper-lower';

const TABLE = 'portfolio-workout-plan-test';

const menu = (version = 4) => planVersionItem({ ...UPPER_LOWER_V1, version });
const targets = (version: number, over: Record<string, unknown> = {}) =>
  targetSetItem({ ...UPPER_LOWER_TARGETS_V1, version, ...over });

const read = async (query: Record<string, string> = {}) => {
  const result = await getTargets({
    queryStringParameters: query,
    headers: {},
  } as unknown as APIGatewayProxyEvent);
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
};

const write = async (body: unknown) => {
  const result = await updateTargets({
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {},
  } as unknown as APIGatewayProxyEvent);
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
};

/** A valid save built from the committed targets, so only the tested bit varies. */
const save = (over: Record<string, unknown> = {}) => ({
  baseVersion: 2,
  changeNote: 'nudge chest up',
  weeklySetTargets: UPPER_LOWER_TARGETS_V1.weeklySetTargets,
  ...over,
});

const written = () =>
  mockSend.mock.calls.map((c) => c[0].input).find((i) => i.Item !== undefined);

beforeAll(() => {
  process.env.WORKOUT_PLAN_TABLE_NAME = TABLE;
});

beforeEach(() => {
  mockSend.mockReset();
  mockTargetItems = [];
});

describe('reading the targets for the editor', () => {
  it('should return the stored set with its version', async () => {
    mockSend.mockResolvedValueOnce({ Items: [menu()] });
    mockTargetItems = [targets(2)];

    const { statusCode, body } = await read();

    expect(statusCode).toBe(200);
    expect(body.version).toBe(2);
    expect(body.weeklySetTargets).toEqual(UPPER_LOWER_TARGETS_V1.weeklySetTargets);
  });

  it('should hand the editor what the rotation prescribes, so the rule is visible before it bites', async () => {
    mockSend.mockResolvedValueOnce({ Items: [menu()] });
    mockTargetItems = [targets(2)];

    const { body } = await read();

    // A target below these is what the write path refuses; the page can say so
    // while the user types rather than after they save.
    expect(body.menu.prescribed.Chest).toEqual({ min: 8, max: 9 });
    expect(body.menu.prescribed.Shoulders).toEqual({ min: 11, max: 14 });
    expect(body.menu.prescribedWithBonus.Quads).toEqual({ min: 13, max: 15 });
    expect(body.menu.version).toBe(4);
  });

  it('should ship the muscle vocabulary so the page never hard-codes it', async () => {
    mockSend.mockResolvedValueOnce({ Items: [menu()] });
    mockTargetItems = [targets(2)];

    const { body } = await read();

    expect(body.muscles).toContain('Chest');
    expect(body.muscles).toContain('Forearms');
  });

  it('should report version 0 and fall back to embedded targets before the split', async () => {
    // Version 0 is also the baseVersion the write path expects in this state,
    // so the editor round-trips without special-casing it.
    const embedded = [{ muscles: ['Chest'], sets: { min: 8, max: 9 }, bonusWeekSets: null }];
    mockSend.mockResolvedValueOnce({
      Items: [{ ...menu(), weeklySetTargets: embedded }],
    });
    mockTargetItems = [];

    const { body } = await read();

    expect(body.version).toBe(0);
    expect(body.weeklySetTargets).toEqual(embedded);
  });

  it('should 404 when no plan has been published', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    const { statusCode } = await read();
    expect(statusCode).toBe(404);
  });
});

describe('saving the targets from the editor', () => {
  it('should append the next version and report what it was based on', async () => {
    mockSend.mockResolvedValueOnce({ Items: [menu()] });
    mockTargetItems = [targets(2)];
    mockSend.mockResolvedValueOnce({});

    const { statusCode, body } = await write(save());

    expect(statusCode).toBe(201);
    expect(body.version).toBe(3);
    expect(body.basedOn).toBe(2);
    expect(written().Item.sk).toBe('T#0003');
    // Appended, never overwritten.
    expect(written().ConditionExpression).toBe('attribute_not_exists(sk)');
  });

  it('should stamp createdAt server-side rather than trusting the editor', async () => {
    mockSend.mockResolvedValueOnce({ Items: [menu()] });
    mockTargetItems = [targets(2)];
    mockSend.mockResolvedValueOnce({});

    await write(save({ createdAt: '1999-01-01T00:00:00.000Z' }));

    expect(written().Item.createdAt).not.toBe('1999-01-01T00:00:00.000Z');
  });

  it('should refuse a save written against a stale version', async () => {
    // A form is filled in over minutes; a blind write would discard whatever
    // was published while it sat open.
    mockSend.mockResolvedValueOnce({ Items: [menu()] });
    mockTargetItems = [targets(5)];

    const { statusCode, body } = await write(save({ baseVersion: 2 }));

    expect(statusCode).toBe(409);
    expect(body.latestVersion).toBe(5);
    expect(written()).toBeUndefined();
  });

  it('should require baseVersion rather than defaulting it', async () => {
    const { statusCode, body } = await write({
      changeNote: 'x',
      weeklySetTargets: UPPER_LOWER_TARGETS_V1.weeklySetTargets,
    });

    expect(statusCode).toBe(400);
    expect(body.issues.some((i: { path: string }) => i.path === 'baseVersion')).toBe(true);
  });

  it('should require a change note, since the history is the point', async () => {
    const { statusCode, body } = await write(save({ changeNote: '   ' }));

    expect(statusCode).toBe(400);
    expect(body.issues.some((i: { path: string }) => i.path === 'changeNote')).toBe(true);
  });

  it('should refuse targets the sessions already exceed, naming the muscles', async () => {
    mockSend.mockResolvedValueOnce({ Items: [menu()] });
    mockTargetItems = [targets(2)];

    const { statusCode, body } = await write(
      save({
        weeklySetTargets: UPPER_LOWER_TARGETS_V1.weeklySetTargets.map((t) =>
          t.muscles.includes('Chest') ? { ...t, sets: { min: 2, max: 3 } } : t,
        ),
      }),
    );

    expect(statusCode).toBe(409);
    expect(body.breaches).toEqual([
      'Chest is prescribed 9 sets a week but its target allows at most 3',
    ]);
    expect(written()).toBeUndefined();
  });

  it('should warn about a bonus-week overshoot without refusing the save', async () => {
    mockSend.mockResolvedValueOnce({ Items: [menu()] });
    mockTargetItems = [targets(2)];
    mockSend.mockResolvedValueOnce({});

    const { statusCode, body } = await write(
      save({
        weeklySetTargets: UPPER_LOWER_TARGETS_V1.weeklySetTargets.map((t) =>
          t.muscles.includes('Quads') ? { ...t, bonusWeekSets: null } : t,
        ),
      }),
    );

    expect(statusCode).toBe(201);
    expect(body.warnings[0]).toMatch(/On a bonus week, Quads/);
  });

  it('should reject a muscle claimed by two entries', async () => {
    mockSend.mockResolvedValueOnce({ Items: [menu()] });
    mockTargetItems = [targets(2)];

    const { statusCode, body } = await write(
      save({
        weeklySetTargets: [
          ...UPPER_LOWER_TARGETS_V1.weeklySetTargets,
          { muscles: ['Chest'], sets: { min: 20, max: 30 }, bonusWeekSets: null },
        ],
      }),
    );

    expect(statusCode).toBe(400);
    expect(JSON.stringify(body.issues)).toMatch(/only one weekly set target/);
    expect(written()).toBeUndefined();
  });

  it('should surface a version published mid-save as a conflict', async () => {
    mockSend.mockResolvedValueOnce({ Items: [menu()] });
    mockTargetItems = [targets(2)];
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }),
    );

    const { statusCode, body } = await write(save());

    expect(statusCode).toBe(409);
    expect(body.message).toMatch(/reload and retry/);
  });

  it('should reject a body that is not JSON', async () => {
    const { statusCode } = await write('not json');
    expect(statusCode).toBe(400);
  });
});
