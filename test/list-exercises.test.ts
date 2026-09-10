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
import { handler } from '../lambda/list-exercises';

const SUMMARY_TABLE = 'portfolio-workout-summary-test';

const call = async (query: Record<string, string> = {}) => {
  const result = await handler({
    queryStringParameters: query,
    headers: {},
  } as unknown as APIGatewayProxyEvent);
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
};

const row = (sk: string, muscle: string, sets: number) => ({
  pk: 'EXERCISE',
  sk,
  muscle,
  sets,
  sessions: 10,
  firstDate: '2020-01-01',
  lastDate: '2026-09-01',
  maxWeight: 100,
  maxWeightKg: 45.36,
  bestE1rm: 110,
  bestE1rmKg: 49.9,
  bestE1rmDate: '2026-08-01',
});

beforeAll(() => {
  process.env.WORKOUT_SUMMARY_TABLE_NAME = SUMMARY_TABLE;
});

beforeEach(() => {
  mockSend.mockReset();
});

test('lists the catalogue from the EXERCISE partition, most-trained first', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [row('Squat', 'Quads', 300), row('Bench Press', 'Chest', 412)],
  });

  const { statusCode, body } = await call();

  expect(statusCode).toBe(200);
  expect(body.count).toBe(2);
  expect(body.exercises.map((e: { name: string }) => e.name)).toEqual(['Bench Press', 'Squat']);

  const query = mockSend.mock.calls[0][0] as QueryCommand;
  expect(query.input.TableName).toBe(SUMMARY_TABLE);
  expect(query.input.ExpressionAttributeValues).toEqual({ ':pk': 'EXERCISE' });
});

test('filters to one muscle group', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [row('Squat', 'Quads', 300), row('Bench Press', 'Chest', 412)],
  });

  const { body } = await call({ muscle: 'chest' });

  expect(body.exercises.map((e: { name: string }) => e.name)).toEqual(['Bench Press']);
  expect(body.muscle).toBe('chest');
});

test('paginates the catalogue query', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [row('Squat', 'Quads', 300)], LastEvaluatedKey: { k: 1 } })
    .mockResolvedValueOnce({ Items: [row('Bench Press', 'Chest', 412)] });

  const { body } = await call();

  expect(body.count).toBe(2);
  expect(mockSend).toHaveBeenCalledTimes(2);
});

test('is explicit when the summary table is unconfigured', async () => {
  delete process.env.WORKOUT_SUMMARY_TABLE_NAME;
  expect((await call()).statusCode).toBe(500);
  process.env.WORKOUT_SUMMARY_TABLE_NAME = SUMMARY_TABLE;
});
