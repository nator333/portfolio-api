import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();

/**
 * Target-set items the handler should see. The menu and the targets share a
 * partition and are told apart by sort-key prefix, so that query is answered
 * here rather than through mockSend — the tests below queue answers in call
 * order, and a second parallel read would silently consume them.
 */
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
          if (values?.[':prefix'] === 'T#') {
            return Promise.resolve({ Items: mockTargetItems });
          }
          return mockSend(command);
        },
      }),
    },
  };
});

import { handler } from '../lambda/revise-workout-plan';
import { planVersionItem, targetSetItem } from '../lambda/workout-plan-schema';
import { UPPER_LOWER_TARGETS_V1, UPPER_LOWER_V1 } from '../lambda/workout-plan-upper-lower';

const TABLE = 'portfolio-workout-plan-test';

const stored = (version: number) => planVersionItem({ ...UPPER_LOWER_V1, version });

const call = async (body: unknown) => {
  const event = { body: JSON.stringify(body), headers: {} } as unknown as APIGatewayProxyEvent;
  const result = await handler(event);
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
};

/** The item the handler tried to write, if it got that far. */
const written = () =>
  mockSend.mock.calls.map((c) => c[0].input).find((i) => i.Item !== undefined);

/** Every item written, whether by a single Put or inside a transaction. */
const allWritten = (): Record<string, unknown>[] =>
  mockSend.mock.calls.flatMap((c) => {
    const input = c[0].input as Record<string, unknown>;
    if (input.Item) return [input.Item as Record<string, unknown>];
    const transact = input.TransactItems as { Put?: { Item: Record<string, unknown> } }[] | undefined;
    return (transact ?? []).map((t) => t.Put!.Item);
  });

/** True when the handler used a transaction rather than a single Put. */
const usedTransaction = () =>
  mockSend.mock.calls.some((c) => (c[0].input as Record<string, unknown>).TransactItems !== undefined);

const storedTargets = (version: number) =>
  targetSetItem({ ...UPPER_LOWER_TARGETS_V1, version });

const SET_CHEST = {
  changeNote: 'chest up to 10-12',
  edits: [{ op: 'set-target', target: { muscles: ['Chest'], sets: { min: 10, max: 12 } } }],
};

const PATCH = {
  changeNote: 'drop preacher curls, more machine lateral raises',
  edits: [
    { op: 'patch', session: 'upper-a', order: 2, changes: { sets: { min: 5, max: 5 } } },
    { op: 'remove', session: 'upper-a', order: 7 },
  ],
};

beforeAll(() => {
  process.env.WORKOUT_PLAN_TABLE_NAME = TABLE;
});

beforeEach(() => {
  mockSend.mockReset();
  // No target set published, unless a test says otherwise.
  mockTargetItems = [];
});

it('should publish the edited plan as the next version', async () => {
  mockSend.mockResolvedValueOnce({ Items: [stored(3)] }).mockResolvedValueOnce({});

  const { statusCode, body } = await call(PATCH);

  expect(statusCode).toBe(201);
  expect(body).toMatchObject({ version: 4, basedOn: 3, editsApplied: 2 });

  const item = written().Item;
  expect(item.sk).toBe('V#0004');
  const upperA = item.sessions.find((s: { id: string }) => s.id === 'upper-a');
  expect(upperA.exercises).toHaveLength(8);
  expect(upperA.exercises[1].sets).toEqual({ min: 5, max: 5 });
});

it('should write conditionally so a concurrent publish cannot be clobbered', async () => {
  mockSend.mockResolvedValueOnce({ Items: [stored(1)] }).mockResolvedValueOnce({});
  await call(PATCH);
  const put = mockSend.mock.calls[1][0].input;
  expect(put.ConditionExpression).toBe('attribute_not_exists(sk)');
});

it('should stamp createdAt rather than inheriting the base version’s', async () => {
  mockSend.mockResolvedValueOnce({ Items: [stored(1)] }).mockResolvedValueOnce({});
  const { body } = await call(PATCH);
  expect(body.createdAt).not.toBe(UPPER_LOWER_V1.createdAt);
});

it('should refuse when the plan moved under the edits', async () => {
  mockSend.mockResolvedValueOnce({ Items: [stored(5)] });

  const { statusCode, body } = await call({ ...PATCH, baseVersion: 3 });

  expect(statusCode).toBe(409);
  expect(body.latestVersion).toBe(5);
  expect(written()).toBeUndefined();
});

it('should proceed when baseVersion matches', async () => {
  mockSend.mockResolvedValueOnce({ Items: [stored(5)] }).mockResolvedValueOnce({});
  const { statusCode } = await call({ ...PATCH, baseVersion: 5 });
  expect(statusCode).toBe(201);
});

it('should 404 when the plan has never been published', async () => {
  mockSend.mockResolvedValueOnce({ Items: [] });

  const { statusCode, body } = await call(PATCH);

  expect(statusCode).toBe(404);
  expect(body.message).toContain('update_workout_plan');
});

it('should require a change note', async () => {
  const { statusCode } = await call({ edits: PATCH.edits });
  expect(statusCode).toBe(400);
  expect(mockSend).not.toHaveBeenCalled();
});

it('should reject a blank change note', async () => {
  const { statusCode } = await call({ ...PATCH, changeNote: '   ' });
  expect(statusCode).toBe(400);
  expect(mockSend).not.toHaveBeenCalled();
});

it('should reject an empty edit list without reading', async () => {
  const { statusCode } = await call({ changeNote: 'nothing', edits: [] });
  expect(statusCode).toBe(400);
  expect(mockSend).not.toHaveBeenCalled();
});

it('should report an edit that does not resolve, and write nothing', async () => {
  mockSend.mockResolvedValueOnce({ Items: [stored(1)] });

  const { statusCode, body } = await call({
    changeNote: 'typo in the session name',
    edits: [{ op: 'remove', session: 'upper-c', order: 1 }],
  });

  expect(statusCode).toBe(400);
  expect(body.message).toContain('upper-c');
  expect(written()).toBeUndefined();
});

// A patch can break an invariant that spans slots, which is why the whole
// document is re-validated rather than just the edited parts.
it('should reject a patch that duplicates a slot position', async () => {
  mockSend.mockResolvedValueOnce({ Items: [stored(1)] });

  const { statusCode, body } = await call({
    changeNote: 'collide two slots',
    edits: [{ op: 'patch', session: 'upper-a', order: 2, changes: { order: 1 } }],
  });

  expect(statusCode).toBe(400);
  expect(JSON.stringify(body.issues)).toContain('unique');
  expect(written()).toBeUndefined();
});

it('should reject a patch whose set range is inverted', async () => {
  mockSend.mockResolvedValueOnce({ Items: [stored(1)] });

  const { statusCode } = await call({
    changeNote: 'bad range',
    edits: [{ op: 'patch', session: 'upper-a', order: 2, changes: { sets: { min: 6, max: 2 } } }],
  });

  expect(statusCode).toBe(400);
  expect(written()).toBeUndefined();
});

it('should surface a version published mid-flight as a conflict', async () => {
  const conflict = Object.assign(new Error('exists'), {
    name: 'ConditionalCheckFailedException',
  });
  mockSend.mockResolvedValueOnce({ Items: [stored(1)] }).mockRejectedValueOnce(conflict);

  const { statusCode, body } = await call(PATCH);

  expect(statusCode).toBe(409);
  expect(body.message).toContain('re-read and retry');
});

describe('routing edits to the half they belong to', () => {
  it('should write only a target set when the revision touches only targets', async () => {
    mockSend.mockResolvedValueOnce({ Items: [stored(3)] });
    mockTargetItems = [storedTargets(2)];
    mockSend.mockResolvedValueOnce({});

    const { statusCode, body } = await call(SET_CHEST);

    expect(statusCode).toBe(201);
    expect(body.targetsVersion).toBe(3);
    expect(body.targetsBasedOn).toBe(2);
    // The menu did not move, so it is not republished.
    expect(body.version).toBeUndefined();
    expect(allWritten().map((i) => i.sk)).toEqual(['T#0003']);
  });

  it('should write only a menu version when the revision touches only slots', async () => {
    mockSend.mockResolvedValueOnce({ Items: [stored(3)] });
    mockTargetItems = [storedTargets(2)];
    mockSend.mockResolvedValueOnce({});

    const { statusCode, body } = await call(PATCH);

    expect(statusCode).toBe(201);
    expect(body.version).toBe(4);
    expect(body.targetsVersion).toBeUndefined();
    expect(allWritten().map((i) => i.sk)).toEqual(['V#0004']);
  });

  it('should write both halves in one transaction when a revision spans them', async () => {
    mockSend.mockResolvedValueOnce({ Items: [stored(3)] });
    mockTargetItems = [storedTargets(2)];
    mockSend.mockResolvedValueOnce({});

    const { statusCode, body } = await call({
      changeNote: 'more lateral raises, and raise the shoulder ceiling to match',
      edits: [...PATCH.edits, ...SET_CHEST.edits],
    });

    expect(statusCode).toBe(201);
    expect(body.version).toBe(4);
    expect(body.targetsVersion).toBe(3);
    // A half-applied revision is the state the split exists to prevent.
    expect(usedTransaction()).toBe(true);
    expect(allWritten().map((i) => i.sk).sort()).toEqual(['T#0003', 'V#0004']);
  });

  it('should start the target sequence at 1 when no target set exists yet', async () => {
    mockSend.mockResolvedValueOnce({ Items: [stored(3)] });
    mockTargetItems = [];
    mockSend.mockResolvedValueOnce({});

    const { statusCode, body } = await call(SET_CHEST);

    expect(statusCode).toBe(201);
    expect(body.targetsVersion).toBe(1);
    expect(body.targetsBasedOn).toBe(0);
  });

  it('should refuse when the targets moved under the edits', async () => {
    mockSend.mockResolvedValueOnce({ Items: [stored(3)] });
    mockTargetItems = [storedTargets(5)];

    const { statusCode, body } = await call({ ...SET_CHEST, baseTargetsVersion: 2 });

    expect(statusCode).toBe(409);
    expect(body.latestTargetsVersion).toBe(5);
    expect(written()).toBeUndefined();
  });
});

describe('keeping the menu inside its targets', () => {
  it('should refuse a slot edit that would prescribe more than the targets allow', async () => {
    mockSend.mockResolvedValueOnce({ Items: [stored(3)] });
    mockTargetItems = [storedTargets(1)];

    // Chest is targeted 8-9; taking the bench slot to 12 puts the week at 18
    // (12 + 3 cable fly in Upper A, + 3 dumbbell bench in Upper B).
    const { statusCode, body } = await call({
      changeNote: 'much more benching',
      edits: [
        { op: 'patch', session: 'upper-a', order: 1, changes: { sets: { min: 12, max: 12 } } },
      ],
    });

    expect(statusCode).toBe(409);
    expect(body.breaches).toEqual([
      'Chest is prescribed 18 sets a week but its target allows at most 9',
    ]);
    expect(written()).toBeUndefined();
  });

  it('should accept the same slot edit when the revision raises the target with it', async () => {
    mockSend.mockResolvedValueOnce({ Items: [stored(3)] });
    mockTargetItems = [storedTargets(1)];
    mockSend.mockResolvedValueOnce({});

    // Judged on the result of both halves, so one coherent change passes.
    const { statusCode, body } = await call({
      changeNote: 'more benching, and the ceiling to match',
      edits: [
        { op: 'patch', session: 'upper-a', order: 1, changes: { sets: { min: 12, max: 12 } } },
        { op: 'set-target', target: { muscles: ['Chest'], sets: { min: 12, max: 20 } } },
      ],
    });

    expect(statusCode).toBe(201);
    expect(usedTransaction()).toBe(true);
    expect(body.version).toBe(4);
    expect(body.targetsVersion).toBe(2);
  });

  it('should refuse a target cut that the existing menu already exceeds', async () => {
    mockSend.mockResolvedValueOnce({ Items: [stored(3)] });
    mockTargetItems = [storedTargets(1)];

    const { statusCode, body } = await call({
      changeNote: 'chest down to 4-5',
      edits: [{ op: 'set-target', target: { muscles: ['Chest'], sets: { min: 4, max: 5 } } }],
    });

    expect(statusCode).toBe(409);
    expect(body.breaches[0]).toMatch(/Chest is prescribed 9 sets/);
    expect(written()).toBeUndefined();
  });

  it('should warn about a bonus-week overshoot without refusing it', async () => {
    mockSend.mockResolvedValueOnce({ Items: [stored(3)] });
    mockTargetItems = [storedTargets(1)];
    mockSend.mockResolvedValueOnce({});

    const { statusCode, body } = await call(PATCH);

    expect(statusCode).toBe(201);
    // Quads: 13-15 with the bonus session against a target of 8-10.
    expect(body.warnings).toEqual([
      'On a bonus week, Quads is prescribed 15 sets a week but its target allows at most 10.',
    ]);
  });
});
