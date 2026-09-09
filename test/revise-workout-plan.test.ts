import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  };
});

import { handler } from '../lambda/revise-workout-plan';
import { planVersionItem } from '../lambda/workout-plan-schema';
import { UPPER_LOWER_V1 } from '../lambda/workout-plan-upper-lower';

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
