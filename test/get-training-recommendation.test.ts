import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// The three joined handlers are stubbed: their own suites cover how each
// answers. What is tested here is the join and, above all, the asymmetric
// failure handling.
const mockReadiness = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
const mockVolume = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
const mockPlan = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
jest.mock('../lambda/get-readiness', () => ({ handler: mockReadiness }));
jest.mock('../lambda/get-muscle-volume-status', () => ({ handler: mockVolume }));
jest.mock('../lambda/get-workout-plan', () => ({ handler: mockPlan }));

import { handler } from '../lambda/get-training-recommendation';
import { UPPER_LOWER_V1 } from '../lambda/workout-plan-upper-lower';

const event = (query: Record<string, string> = {}) =>
  ({ queryStringParameters: query, headers: {} }) as unknown as APIGatewayProxyEvent;
const reply = (statusCode: number, body: unknown): APIGatewayProxyResult => ({ statusCode, body: JSON.stringify(body) });

const volumeBody = {
  window: { days: 7, from: '2026-09-20', to: '2026-09-26' },
  muscles: [
    { muscle: 'Quads', status: 'under' },
    { muscle: 'Chest', status: 'in_range' },
  ],
};

beforeEach(() => {
  mockReadiness.mockReset();
  mockVolume.mockReset();
  mockPlan.mockReset();
  mockPlan.mockResolvedValue(reply(200, { ...UPPER_LOWER_V1, targetsVersion: 2 }));
  mockVolume.mockResolvedValue(reply(200, volumeBody));
});

test('joins readiness, volume and plan into one prescription', async () => {
  mockReadiness.mockResolvedValue(reply(200, { status: 'ready', date: '2026-09-26', verdict: 'push', reasons: ['r'] }));

  const result = await handler(event());
  expect(result.statusCode).toBe(200);
  const body = JSON.parse(result.body);
  expect(body.plan).toEqual({ planId: 'upper-lower', version: 1 });
  expect(body.volumeWindow).toEqual(volumeBody.window);
  expect(body.readiness).toEqual({ status: 'ready', date: '2026-09-26', verdict: 'push', reasons: ['r'] });
  expect(body.session.id).toBe('lower-a');
  expect(body.prescription).toHaveLength(5);
});

test('planId reaches the plan and volume reads alike', async () => {
  mockReadiness.mockResolvedValue(reply(200, { status: 'not_synced', verdict: null, reasons: [] }));
  await handler(event({ planId: 'upper-lower' }));
  expect(mockPlan.mock.calls[0][0].queryStringParameters).toEqual({ planId: 'upper-lower' });
  expect(mockVolume.mock.calls[0][0].queryStringParameters).toEqual({ planId: 'upper-lower' });
});

test('a readiness error still yields the session, with intensity withheld', async () => {
  mockReadiness.mockResolvedValue(reply(503, { message: 'Secret "google-health-oauth" does not exist.', kind: 'auth' }));

  const body = JSON.parse((await handler(event())).body);
  expect(body.readiness).toEqual({
    status: 'unavailable',
    date: null,
    verdict: null,
    reasons: ['Secret "google-health-oauth" does not exist.'],
  });
  expect(body.session.id).toBe('lower-a');
  expect(body.prescription).toBeNull();
});

test('a readiness handler that throws is contained the same way', async () => {
  mockReadiness.mockRejectedValue(new Error('boom'));
  const result = await handler(event());
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).readiness.status).toBe('unavailable');
});

test('a failed plan or volume read fails the whole answer', async () => {
  mockReadiness.mockResolvedValue(reply(200, { status: 'ready', verdict: 'normal', reasons: [] }));
  mockPlan.mockResolvedValue(reply(404, { message: 'No plan "x" has been published' }));

  const result = await handler(event());
  expect(result.statusCode).toBe(404);
  expect(JSON.parse(result.body).message).toBe('Could not read the plan: No plan "x" has been published');
});
