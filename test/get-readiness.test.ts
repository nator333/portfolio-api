import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  return { ...actual, SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })) };
});

import { handler } from '../lambda/get-readiness';
import { resetGoogleHealthCache } from '../lambda/google-health';

const SECRET = 'google-health-oauth-test';
const event = (query: Record<string, string> = {}): APIGatewayProxyEvent =>
  ({ queryStringParameters: query, headers: {} }) as unknown as APIGatewayProxyEvent;

const gDate = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
};

/** What the three Health API reads answer with, per data type. */
interface Answers {
  sleep?: unknown[];
  hrv?: unknown[];
  rhr?: unknown[];
}

const sleepPoint = (endDate: string, minutesAsleep: number) => ({
  sleep: {
    interval: { endTime: `${endDate}T21:30:00Z`, civilEndTime: { date: gDate(endDate) } },
    metadata: { processed: true, mainSleep: true },
    summary: { minutesAsleep: String(minutesAsleep) },
  },
});
const hrvPoint = (date: string, ms: number) => ({
  dailyHeartRateVariability: { date: gDate(date), averageHeartRateVariabilityMilliseconds: ms },
});
const rhrPoint = (date: string, bpm: number) => ({
  dailyRestingHeartRate: { date: gDate(date), beatsPerMinute: String(bpm) },
});

/** Two weeks of baseline before 2026-09-26. */
const baselineDates = Array.from({ length: 14 }, (_, i) => {
  const d = new Date('2026-09-26T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (i + 1));
  return d.toISOString().slice(0, 10);
});

let fetchMock: jest.Mock;
const requestedUrls = () =>
  fetchMock.mock.calls.map(([url]) => String(url)).filter((u) => u.includes('health.googleapis.com'));

function answer(answers: Answers, token: { status?: number; body?: unknown } = {}) {
  fetchMock.mockImplementation(async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const status = token.status ?? 200;
      return new Response(JSON.stringify(token.body ?? { access_token: 'at-1', expires_in: 3600 }), { status });
    }
    const type = /dataTypes\/([^/]+)\/dataPoints/.exec(url)?.[1];
    const points =
      type === 'sleep' ? answers.sleep : type === 'daily-heart-rate-variability' ? answers.hrv : answers.rhr;
    return new Response(JSON.stringify({ dataPoints: points ?? [] }), { status: 200 });
  });
}

beforeEach(() => {
  process.env.GOOGLE_HEALTH_SECRET_NAME = SECRET;
  process.env.HEALTH_TIME_ZONE = 'Asia/Tokyo';
  resetGoogleHealthCache();
  mockSecretsSend.mockReset();
  mockSecretsSend.mockResolvedValue({
    SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'cs', refresh_token: 'rt' }),
  });
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  // 05:30 on the 26th in Tokyo; still the 25th in UTC.
  jest.useFakeTimers({ now: new Date('2026-09-25T20:30:00Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick'] });
});

afterEach(() => {
  jest.useRealTimers();
});

test('judges the owner\'s local today, reading each signal live', async () => {
  answer({
    sleep: [sleepPoint('2026-09-26', 460)],
    hrv: [...baselineDates.map((d, i) => hrvPoint(d, [55, 60, 65][i % 3])), hrvPoint('2026-09-26', 64)],
    rhr: [...baselineDates.map((d) => rhrPoint(d, 55)), rhrPoint('2026-09-26', 54)],
  });

  const result = await handler(event());
  expect(result.statusCode).toBe(200);
  const body = JSON.parse(result.body);
  expect(body).toMatchObject({ date: '2026-09-26', timeZone: 'Asia/Tokyo', status: 'ready', verdict: 'push' });
  expect(body.asOf).toBe('2026-09-25T20:30:00.000Z');

  // The filters are bounded by the local date, not the UTC one.
  const urls = requestedUrls().map((u) => decodeURIComponent(new URL(u).searchParams.get('filter') ?? ''));
  expect(urls).toEqual(
    expect.arrayContaining([
      'sleep.interval.civil_end_time >= "2026-09-23" AND sleep.interval.civil_end_time < "2026-09-27"',
      'daily_heart_rate_variability.date >= "2026-08-29" AND daily_heart_rate_variability.date < "2026-09-27"',
      'daily_resting_heart_rate.date >= "2026-08-29" AND daily_resting_heart_rate.date < "2026-09-27"',
    ]),
  );
  // The refresh token is exchanged, and the access token sent as a bearer.
  const healthCall = fetchMock.mock.calls.find(([u]) => String(u).includes('health.googleapis.com'));
  expect(healthCall?.[1]?.headers).toEqual({ Authorization: 'Bearer at-1' });
});

test('before the morning sync, says so instead of judging on yesterday', async () => {
  answer({
    sleep: [sleepPoint('2026-09-25', 480)],
    hrv: baselineDates.map((d) => hrvPoint(d, 60)),
    rhr: baselineDates.map((d) => rhrPoint(d, 55)),
  });

  const body = JSON.parse((await handler(event())).body);
  expect(body.status).toBe('not_synced');
  expect(body.verdict).toBeNull();
  expect(body.missing).toContainEqual({ signal: 'sleep', latestDate: '2026-09-25' });
});

test('an earlier date can be looked back on', async () => {
  answer({ sleep: [], hrv: [], rhr: [] });
  const body = JSON.parse((await handler(event({ date: '2026-09-20' }))).body);
  expect(body.date).toBe('2026-09-20');
  const sleepFilter = requestedUrls()
    .map((u) => new URL(u).searchParams.get('filter') ?? '')
    .find((f) => f.startsWith('sleep.'));
  expect(sleepFilter).toContain('< "2026-09-21"');
});

test('a future or malformed date is refused before any read', async () => {
  answer({});
  for (const date of ['2026-09-27', '2026-02-30', 'tomorrow']) {
    const result = await handler(event({ date }));
    expect(result.statusCode).toBe(400);
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a refused refresh token is reported as a reconnect, not a crash', async () => {
  answer({}, { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } });
  const result = await handler(event());
  expect(result.statusCode).toBe(503);
  const body = JSON.parse(result.body);
  expect(body.kind).toBe('auth');
  expect(body.message).toMatch(/google-health-auth/);
});

test('a missing secret says how to connect', async () => {
  mockSecretsSend.mockRejectedValue(Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' }));
  answer({});
  const result = await handler(event());
  expect(result.statusCode).toBe(503);
  expect(JSON.parse(result.body).message).toMatch(/does not exist/);
});

test('missing configuration is a 500, not a guess at the owner\'s time zone', async () => {
  delete process.env.HEALTH_TIME_ZONE;
  const result = await handler(event());
  expect(result.statusCode).toBe(500);
});
