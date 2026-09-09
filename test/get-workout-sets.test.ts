import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  };
});

import { handler, datesInRange, MAX_SPAN_DAYS } from '../lambda/get-workout-sets';

const TABLE = 'portfolio-workout-sets-test';

function event(query: Record<string, string>): APIGatewayProxyEvent {
  return { queryStringParameters: query, headers: {} } as unknown as APIGatewayProxyEvent;
}

const call = async (query: Record<string, string>) => {
  const result = await handler(event(query));
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
};

/** One stored set, shaped as workout-ingest writes it. */
const storedSet = (over: Record<string, unknown> = {}) => ({
  sk: 'Bench Press#1',
  exercise: 'Bench Press',
  setNo: 1,
  weight: 135,
  weightKg: 61.23,
  reps: 8,
  volume: 1080,
  volumeKg: 489.87,
  muscle: 'Chest',
  notes: '',
  ...over,
});

beforeAll(() => {
  process.env.WORKOUT_SETS_TABLE_NAME = TABLE;
});

beforeEach(() => {
  mockSend.mockReset();
});

test('datesInRange covers both endpoints inclusively and crosses a month boundary', () => {
  expect(datesInRange('2026-01-30', '2026-02-02')).toEqual([
    '2026-01-30',
    '2026-01-31',
    '2026-02-01',
    '2026-02-02',
  ]);
  expect(datesInRange('2026-03-01', '2026-03-01')).toEqual(['2026-03-01']);
});

test('a single day is one query and returns its sets with the per-set detail intact', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [storedSet({ notes: 'felt strong' }), storedSet({ sk: 'Bench Press#2', setNo: 2, reps: 6 })],
  });

  const { statusCode, body } = await call({ date: '2026-03-01' });

  expect(statusCode).toBe(200);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(body.dayCount).toBe(1);
  expect(body.setCount).toBe(2);
  expect(body.days[0].date).toBe('2026-03-01');
  // The note and the per-set reps are exactly what the public summaries discard.
  expect(body.days[0].sets[0].notes).toBe('felt strong');
  expect(body.days[0].sets[1].reps).toBe(6);
});

test('rest days are omitted rather than returned as empty shells', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [storedSet()] })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({ Items: [storedSet()] });

  const { body } = await call({ from: '2026-03-01', to: '2026-03-03' });

  expect(mockSend).toHaveBeenCalledTimes(3);
  expect(body.dayCount).toBe(2);
  expect(body.days.map((d: { date: string }) => d.date)).toEqual(['2026-03-01', '2026-03-03']);
});

test('sets are ordered by exercise then set number, not by range-key string order', async () => {
  // Range-key order would sort "#10" before "#2"; a reader expects 2 then 10.
  mockSend.mockResolvedValueOnce({
    Items: [
      storedSet({ sk: 'Squat#10', exercise: 'Squat', setNo: 10 }),
      storedSet({ sk: 'Squat#2', exercise: 'Squat', setNo: 2 }),
      storedSet({ sk: 'Bench Press#1', exercise: 'Bench Press', setNo: 1 }),
    ],
  });

  const { body } = await call({ date: '2026-03-01' });

  expect(body.days[0].sets.map((s: { exercise: string; setNo: number }) => `${s.exercise}#${s.setNo}`)).toEqual([
    'Bench Press#1',
    'Squat#2',
    'Squat#10',
  ]);
});

test('a long session paginates rather than silently truncating at the 1MB page', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [storedSet()], LastEvaluatedKey: { date: '2026-03-01', sk: 'Bench Press#1' } })
    .mockResolvedValueOnce({ Items: [storedSet({ sk: 'Squat#1', exercise: 'Squat' })] });

  const { body } = await call({ date: '2026-03-01' });

  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(body.setCount).toBe(2);
});

test('a malformed or missing date is rejected before any query runs', async () => {
  for (const query of [{}, { date: '01-03-2026' }, { from: '2026-03-01' , to: 'nonsense' }]) {
    const { statusCode } = await call(query as Record<string, string>);
    expect(statusCode).toBe(400);
  }
  expect(mockSend).not.toHaveBeenCalled();
});

test('an inverted range is rejected', async () => {
  const { statusCode, body } = await call({ from: '2026-03-05', to: '2026-03-01' });
  expect(statusCode).toBe(400);
  expect(body.message).toMatch(/must not be after/);
  expect(mockSend).not.toHaveBeenCalled();
});

test('a range wider than the cap is refused, since each day costs its own query', async () => {
  const { statusCode, body } = await call({ from: '2026-01-01', to: '2026-06-01' });

  expect(statusCode).toBe(400);
  expect(body.message).toMatch(new RegExp(`${MAX_SPAN_DAYS} is the maximum`));
  expect(mockSend).not.toHaveBeenCalled();
});

test('the widest allowed range is accepted', async () => {
  mockSend.mockResolvedValue({ Items: [] });

  const { statusCode } = await call({ from: '2026-03-01', to: '2026-03-31' });

  expect(statusCode).toBe(200);
  expect(mockSend).toHaveBeenCalledTimes(MAX_SPAN_DAYS);
});

test('a missing table name is a configuration error, not an empty result', async () => {
  delete process.env.WORKOUT_SETS_TABLE_NAME;
  const { statusCode } = await call({ date: '2026-03-01' });
  expect(statusCode).toBe(500);
  process.env.WORKOUT_SETS_TABLE_NAME = TABLE;
});
