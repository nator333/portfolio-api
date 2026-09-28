import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  return { ...actual, SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })) };
});
const mockHistory = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
jest.mock('../lambda/get-exercise-history', () => ({ handler: mockHistory }));

import { handler } from '../lambda/get-weight-trend';
import { resetGoogleHealthCache } from '../lambda/google-health';

const event = (query: Record<string, string> = {}) =>
  ({ queryStringParameters: query, headers: {} }) as unknown as APIGatewayProxyEvent;

/** A morning weigh-in `daysAgo` days before 2026-09-28, Montreal time. */
const weighIn = (daysAgo: number, grams: number) => {
  const d = new Date('2026-09-28T11:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return { weight: { sampleTime: { physicalTime: d.toISOString(), utcOffset: '-14400s' }, weightGrams: grams } };
};

let fetchMock: jest.Mock;
function answer(points: { weight?: unknown[]; bodyFat?: unknown[] }) {
  fetchMock.mockImplementation(async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
    }
    const list = url.includes('/dataTypes/weight/') ? points.weight : points.bodyFat;
    return new Response(JSON.stringify({ dataPoints: list ?? [] }), { status: 200 });
  });
}

beforeEach(() => {
  process.env.GOOGLE_HEALTH_SECRET_NAME = 'google-health-oauth-test';
  process.env.HEALTH_TIME_ZONE = 'America/Toronto';
  resetGoogleHealthCache();
  mockSecretsSend.mockReset();
  mockSecretsSend.mockResolvedValue({ SecretString: JSON.stringify({ client_id: 'c', client_secret: 's', refresh_token: 'r' }) });
  mockHistory.mockReset();
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  // 21:00 on the 28th in Montreal, already the 29th in UTC.
  jest.useFakeTimers({ now: new Date('2026-09-29T01:00:00Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick'] });
});
afterEach(() => jest.useRealTimers());

const thirtyDays = Array.from({ length: 30 }, (_, i) => weighIn(29 - i, 80000 + i * 30));

test('reads weight and body fat for the window, judged on the local day', async () => {
  answer({ weight: thirtyDays });
  const result = await handler(event());
  expect(result.statusCode).toBe(200);
  const body = JSON.parse(result.body);
  expect(body.window).toEqual({ days: 90, from: '2026-07-01', to: '2026-09-28' });
  expect(body.latest).toMatchObject({ date: '2026-09-28', stale: false });
  expect(body.rate.pace).toBe('gaining_slowly');
  expect(body.fetched).toEqual({ weight: { points: 30, usable: 30 }, bodyFat: { points: 0, usable: 0 } });

  const filters = fetchMock.mock.calls
    .map(([u]) => String(u))
    .filter((u) => u.includes('health.googleapis.com'))
    .map((u) => new URL(u).searchParams.get('filter'));
  expect(filters).toEqual(
    expect.arrayContaining([
      'weight.sample_time.physical_time >= "2026-06-30T00:00:00Z" AND weight.sample_time.physical_time < "2026-09-30T00:00:00Z"',
      'body_fat.sample_time.physical_time >= "2026-06-30T00:00:00Z" AND body_fat.sample_time.physical_time < "2026-09-30T00:00:00Z"',
    ]),
  );
  expect(mockHistory).not.toHaveBeenCalled();
});

test('with an exercise, sets its 1RM against bodyweight (log in lb, answer in kg)', async () => {
  answer({ weight: thirtyDays });
  mockHistory.mockResolvedValue({
    statusCode: 200,
    body: JSON.stringify({
      exercise: 'Bench Press',
      days: [
        { date: '2026-09-10', sets: [{ weight: 185, reps: 5 }, { weight: 195, reps: 3 }] },
        { date: '2026-09-26', sets: [{ weight: 200, reps: 3 }] },
      ],
    }),
  });

  const body = JSON.parse((await handler(event({ exercise: 'bench', days: '30' }))).body);
  expect(mockHistory.mock.calls[0][0].queryStringParameters).toEqual({
    exercise: 'bench',
    from: '2026-08-30',
    to: '2026-09-28',
  });
  expect(body.relativeStrength.exercise).toBe('Bench Press');
  expect(body.relativeStrength.sessions).toHaveLength(2);
  // Best set of the first day: 185 × 5 → Epley 215.83 lb → 97.9 kg.
  expect(body.relativeStrength.sessions[0].e1rmKg).toBeCloseTo(97.9, 1);
});

test('an unknown exercise does not fail the weight answer', async () => {
  answer({ weight: thirtyDays });
  mockHistory.mockResolvedValue({ statusCode: 404, body: JSON.stringify({ message: 'No exercise matches "curlz"' }) });
  const result = await handler(event({ exercise: 'curlz' }));
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).relativeStrength).toMatchObject({ requested: 'curlz', error: 'No exercise matches "curlz"' });
});

test('an out-of-range window is refused before any read', async () => {
  answer({});
  for (const days of ['7', '400', 'week']) {
    expect((await handler(event({ days }))).statusCode).toBe(400);
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a lost Google grant is reported as a reconnect', async () => {
  // A fresh Response per call: the two reads refresh the token concurrently,
  // and a body can only be consumed once.
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
  const result = await handler(event());
  expect(result.statusCode).toBe(503);
  expect(JSON.parse(result.body).kind).toBe('auth');
});
