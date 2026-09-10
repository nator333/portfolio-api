import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  };
});

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { handler, MAX_SETS } from '../lambda/get-exercise-history';
import { SETS_BY_EXERCISE_INDEX } from '../lambda/workout-schema';

const SETS_TABLE = 'portfolio-workout-sets-test';
const SUMMARY_TABLE = 'portfolio-workout-summary-test';

const call = async (query: Record<string, string>) => {
  const result = await handler({
    queryStringParameters: query,
    headers: {},
  } as unknown as APIGatewayProxyEvent);
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
};

/** One EXERCISE summary row, shaped as workout-ingest writes it. */
const catalogRow = (over: Record<string, unknown> = {}) => ({
  pk: 'EXERCISE',
  sk: 'Bench Press',
  muscle: 'Chest',
  sets: 412,
  sessions: 96,
  firstDate: '2016-04-02',
  lastDate: '2026-09-01',
  maxWeight: 225,
  maxWeightKg: 102.06,
  bestE1rm: 240,
  bestE1rmKg: 108.86,
  bestE1rmDate: '2026-08-11',
  ...over,
});

/** One stored set, shaped as workout-ingest writes it. */
const storedSet = (over: Record<string, unknown> = {}) => ({
  date: '2026-09-01',
  sk: 'Bench Press#1',
  exercise: 'Bench Press',
  setNo: 1,
  weight: 185,
  weightKg: 83.91,
  reps: 5,
  volume: 925,
  volumeKg: 419.57,
  muscle: 'Chest',
  notes: '',
  ...over,
});

/** Catalogue query answers first, then the index query. */
function respond(catalog: unknown[], sets: unknown[]) {
  mockSend
    .mockResolvedValueOnce({ Items: catalog })
    .mockResolvedValueOnce({ Items: sets });
}

beforeAll(() => {
  process.env.WORKOUT_SETS_TABLE_NAME = SETS_TABLE;
  process.env.WORKOUT_SUMMARY_TABLE_NAME = SUMMARY_TABLE;
});

beforeEach(() => {
  mockSend.mockReset();
});

test('reads one lift from the exercise index in a single query', async () => {
  respond(
    [catalogRow()],
    [
      storedSet({ date: '2026-08-25', sk: 'Bench Press#1', setNo: 1, weight: 175, reps: 5 }),
      storedSet({ date: '2026-09-01', sk: 'Bench Press#1', setNo: 1, weight: 185, reps: 5 }),
    ],
  );

  const { statusCode, body } = await call({ exercise: 'Bench Press' });

  expect(statusCode).toBe(200);
  expect(body.exercise).toBe('Bench Press');
  expect(body.setCount).toBe(2);
  expect(body.sessionCount).toBe(2);
  expect(body.days.map((d: { date: string }) => d.date)).toEqual(['2026-08-25', '2026-09-01']);

  // One catalogue query plus one index query — no per-day fan-out.
  expect(mockSend).toHaveBeenCalledTimes(2);
  const setsQuery = mockSend.mock.calls[1][0] as QueryCommand;
  expect(setsQuery.input.TableName).toBe(SETS_TABLE);
  expect(setsQuery.input.IndexName).toBe(SETS_BY_EXERCISE_INDEX);
  expect(setsQuery.input.KeyConditionExpression).toBe('#e = :ex');
  expect(setsQuery.input.ExpressionAttributeValues).toEqual({ ':ex': 'Bench Press' });
});

test('narrows the index query to the requested window', async () => {
  respond([catalogRow()], [storedSet()]);

  await call({ exercise: 'Bench Press', from: '2026-01-01', to: '2026-09-01' });

  const setsQuery = mockSend.mock.calls[1][0] as QueryCommand;
  expect(setsQuery.input.KeyConditionExpression).toBe('#e = :ex AND #d BETWEEN :from AND :to');
  expect(setsQuery.input.ExpressionAttributeValues).toEqual({
    ':ex': 'Bench Press',
    ':from': '2026-01-01',
    ':to': '2026-09-01',
  });
});

test('an open-ended window uses a one-sided key condition', async () => {
  respond([catalogRow()], [storedSet()]);

  await call({ exercise: 'Bench Press', from: '2026-01-01' });

  const setsQuery = mockSend.mock.calls[1][0] as QueryCommand;
  expect(setsQuery.input.KeyConditionExpression).toBe('#e = :ex AND #d >= :from');
});

test('resolves a partial name to the canonical one and says so', async () => {
  respond([catalogRow(), catalogRow({ sk: 'Squat', muscle: 'Quads', sets: 300 })], [storedSet()]);

  const { statusCode, body } = await call({ exercise: 'bench' });

  expect(statusCode).toBe(200);
  expect(body.exercise).toBe('Bench Press');
  expect(body.requested).toBe('bench');
});

test('resolves a Japanese spelling through the canonical mapping', async () => {
  respond([catalogRow()], [storedSet()]);

  const { statusCode, body } = await call({ exercise: 'ベンチプレス' });

  expect(statusCode).toBe(200);
  expect(body.exercise).toBe('Bench Press');
});

test('an unknown name returns candidates rather than an empty history', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [catalogRow(), catalogRow({ sk: 'Incline Dumbbell Bench Press', sets: 120 })],
  });

  const { statusCode, body } = await call({ exercise: 'overhead press' });

  expect(statusCode).toBe(404);
  expect(body.candidates).toContain('Bench Press');
  // The index is never queried for a name that resolved to nothing.
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('several equally plausible matches come back as a choice, best-trained first', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      catalogRow({ sk: 'Incline Bench Press', sets: 200 }),
      catalogRow({ sk: 'Decline Bench Press', sets: 40 }),
    ],
  });

  // Nothing is called plain "Bench Press" in this log, so two variations tie.
  const { statusCode, body } = await call({ exercise: 'bench' });

  expect(statusCode).toBe(404);
  expect(body.candidates).toEqual(['Incline Bench Press', 'Decline Bench Press']);
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('an exact name wins over the variations that also contain it', async () => {
  respond(
    [
      catalogRow({ sk: 'Incline Bench Press', sets: 200 }),
      catalogRow({ sk: 'Bench Press', sets: 412 }),
    ],
    [storedSet()],
  );

  const { statusCode, body } = await call({ exercise: 'Bench Press' });

  expect(statusCode).toBe(200);
  expect(body.exercise).toBe('Bench Press');
});

test('a valid lift with no sets in the window returns an empty history, not a 404', async () => {
  respond([catalogRow()], []);

  const { statusCode, body } = await call({ exercise: 'Bench Press', from: '2020-01-01', to: '2020-02-01' });

  expect(statusCode).toBe(200);
  expect(body.days).toEqual([]);
  expect(body.setCount).toBe(0);
  expect(body.best).toBeNull();
  // The all-time figures survive an empty window — they come from the rollup.
  expect(body.allTime.maxWeight).toBe(225);
});

test('reports the bests within the returned sets alongside the all-time ones', async () => {
  respond(
    [catalogRow()],
    [
      storedSet({ date: '2026-08-25', weight: 205, reps: 2 }),
      storedSet({ date: '2026-09-01', weight: 185, reps: 8 }),
    ],
  );

  const { body } = await call({ exercise: 'Bench Press', from: '2026-08-01' });

  // Heaviest is the double; the eight-rep set estimates to a higher 1RM.
  expect(body.best.heaviestSet).toMatchObject({ date: '2026-08-25', weight: 205, reps: 2 });
  expect(body.best.bestE1rm).toMatchObject({ date: '2026-09-01', weight: 185, reps: 8 });
  expect(body.allTime.bestE1rmDate).toBe('2026-08-11');
});

test('orders a day by set number rather than by sort key', async () => {
  respond(
    [catalogRow()],
    [
      storedSet({ sk: 'Bench Press#10', setNo: 10, weight: 135 }),
      storedSet({ sk: 'Bench Press#2', setNo: 2, weight: 185 }),
    ],
  );

  const { body } = await call({ exercise: 'Bench Press' });

  expect(body.days[0].sets.map((s: { setNo: number }) => s.setNo)).toEqual([2, 10]);
});

test('keeps the most recent sets and flags the truncation', async () => {
  const many = Array.from({ length: MAX_SETS + 5 }, (_, i) =>
    storedSet({ date: `2026-${String((i % 12) + 1).padStart(2, '0')}-01`, setNo: i, weight: i }),
  );
  respond([catalogRow()], many);

  const { body } = await call({ exercise: 'Bench Press' });

  expect(body.truncated).toBe(true);
  expect(body.setCount).toBe(MAX_SETS);
  // The five oldest were dropped, not the five newest.
  const returned = body.days.flatMap((d: { sets: { weight: number }[] }) => d.sets);
  expect(returned.some((s: { weight: number }) => s.weight === MAX_SETS + 4)).toBe(true);
  expect(returned.some((s: { weight: number }) => s.weight === 0)).toBe(false);
});

test('paginates the index query', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [catalogRow()] })
    .mockResolvedValueOnce({ Items: [storedSet({ date: '2026-08-01' })], LastEvaluatedKey: { k: 1 } })
    .mockResolvedValueOnce({ Items: [storedSet({ date: '2026-09-01' })] });

  const { body } = await call({ exercise: 'Bench Press' });

  expect(body.setCount).toBe(2);
  expect(mockSend).toHaveBeenCalledTimes(3);
});

test('rejects a missing exercise and a malformed or inverted range', async () => {
  expect((await call({})).statusCode).toBe(400);
  expect((await call({ exercise: 'Bench Press', from: '2026-1-1' })).statusCode).toBe(400);
  expect(
    (await call({ exercise: 'Bench Press', from: '2026-09-01', to: '2026-08-01' })).statusCode,
  ).toBe(400);
  expect(mockSend).not.toHaveBeenCalled();
});
