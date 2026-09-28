import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send: mockDdbSend }) } };
});
const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  return { ...actual, SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })) };
});

import {
  BODYWEIGHT_ITEM_ID,
  MIN_DAYS_PER_MONTH,
  mergeMonths,
  monthlyAverages,
  windowStart,
  type MonthlyBodyweight,
} from '../lambda/bodyweight-schema';
import { handler as ingest } from '../lambda/bodyweight-ingest';
import { handler as getBodyweight } from '../lambda/get-bodyweight';
import { resetGoogleHealthCache } from '../lambda/google-health';
import type { Reading } from '../lambda/weight-trend';

const reading = (date: string, kg: number, hourUtc = 11): Reading => ({
  date,
  time: `${date}T${String(hourUtc).padStart(2, '0')}:00:00Z`,
  value: kg,
});

/** `n` consecutive days of `kg` starting on `first`. */
const days = (first: string, n: number, kg: number): Reading[] =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${first}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return reading(d.toISOString().slice(0, 10), kg);
  });

describe('monthly averages', () => {
  test('one average per month, in kg and lb, oldest first', () => {
    const months = monthlyAverages([...days('2026-08-01', 10, 80), ...days('2026-07-01', 10, 79)], '2026-09-28');
    expect(months).toEqual([
      { month: '2026-07', kg: 79, lb: 174.2, complete: true },
      { month: '2026-08', kg: 80, lb: 176.4, complete: true },
    ]);
  });

  test(`a month with fewer than ${MIN_DAYS_PER_MONTH} weigh-in days is not published`, () => {
    const months = monthlyAverages(
      [...days('2026-08-01', MIN_DAYS_PER_MONTH - 1, 80), ...days('2026-07-01', MIN_DAYS_PER_MONTH, 79)],
      '2026-09-28',
    );
    expect(months.map((m) => m.month)).toEqual(['2026-07']);
  });

  test('each day counts once, by its morning weigh-in', () => {
    // A heavier evening reading every day must not pull the average up.
    const readings = [...days('2026-08-01', 10, 80), ...days('2026-08-01', 10, 82).map((r) => ({ ...r, time: r.time.replace('T11', 'T23') }))];
    expect(monthlyAverages(readings, '2026-09-28')[0].kg).toBe(80);
  });

  test('the current month is published once it clears the bar, marked incomplete', () => {
    const months = monthlyAverages(days('2026-09-01', 10, 81), '2026-09-28');
    expect(months).toEqual([{ month: '2026-09', kg: 81, lb: 178.6, complete: false }]);
  });

  test('re-runs replace the re-read months and keep older ones', () => {
    const stored: MonthlyBodyweight[] = [
      { month: '2024-01', kg: 75, lb: 165.3, complete: true },
      { month: '2025-10', kg: 78, lb: 172, complete: true },
      { month: '2026-09', kg: 80, lb: 176.4, complete: false },
    ];
    const fresh: MonthlyBodyweight[] = [{ month: '2026-09', kg: 80.5, lb: 177.5, complete: false }];
    // 2025-10 is inside the re-read window but absent from `fresh` (its
    // weigh-ins were deleted): it is dropped. 2024-01 predates the window: kept.
    expect(mergeMonths(stored, fresh, '2024-10').map((m) => [m.month, m.kg])).toEqual([
      ['2024-01', 75],
      ['2026-09', 80.5],
    ]);
  });

  test('the ingest window starts on the first of the month, 24 months back', () => {
    expect(windowStart('2026-09-28', 24)).toBe('2024-10-01');
    expect(windowStart('2026-01-15', 1)).toBe('2026-01-01');
  });
});

describe('the daily ingest', () => {
  let fetchMock: jest.Mock;
  const weighIn = (date: string, grams: number) => ({
    weight: { sampleTime: { physicalTime: `${date}T11:00:00Z`, utcOffset: '-14400s' }, weightGrams: grams },
  });

  beforeEach(() => {
    process.env.CV_TABLE_NAME = 'cv-test';
    process.env.GOOGLE_HEALTH_SECRET_NAME = 'google-health-oauth-test';
    process.env.HEALTH_TIME_ZONE = 'America/Toronto';
    resetGoogleHealthCache();
    mockDdbSend.mockReset();
    mockSecretsSend.mockReset();
    mockSecretsSend.mockResolvedValue({ SecretString: JSON.stringify({ client_id: 'c', client_secret: 's', refresh_token: 'r' }) });
    fetchMock = jest.fn(async (input: string | URL) =>
      String(input).startsWith('https://oauth2.googleapis.com/token')
        ? new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
        : new Response(
            JSON.stringify({ dataPoints: Array.from({ length: 9 }, (_, i) => weighIn(`2026-09-0${i + 1}`, 80000 + i * 100)) }),
            { status: 200 },
          ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.useFakeTimers({ now: new Date('2026-09-28T16:00:00Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick'] });
  });
  afterEach(() => jest.useRealTimers());

  test('stores only monthly averages, merged over what was stored', async () => {
    mockDdbSend.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) =>
      command.constructor.name === 'GetCommand'
        ? { Item: { id: BODYWEIGHT_ITEM_ID, months: [{ month: '2023-05', kg: 74, lb: 163.1, complete: true }] } }
        : {},
    );

    await ingest();

    const filter = new URL(String(fetchMock.mock.calls.find(([u]) => String(u).includes('health.googleapis.com'))![0]))
      .searchParams.get('filter');
    expect(filter).toBe(
      'weight.sample_time.physical_time >= "2024-09-30T00:00:00Z" AND weight.sample_time.physical_time < "2026-09-30T00:00:00Z"',
    );

    const put = mockDdbSend.mock.calls.map(([c]) => c).find((c) => c.constructor.name === 'PutCommand');
    expect(put.input.Item.id).toBe(BODYWEIGHT_ITEM_ID);
    expect(put.input.Item.months).toEqual([
      { month: '2023-05', kg: 74, lb: 163.1, complete: true },
      // lb is converted from the unrounded kg mean (80.4 exactly → 177.25).
      { month: '2026-09', kg: 80.4, lb: 177.3, complete: false },
    ]);
    // Nothing finer than a month is written.
    expect(Object.keys(put.input.Item).sort()).toEqual(['id', 'months', 'updatedAt']);
  });

  test('refuses to run half-configured', async () => {
    delete process.env.GOOGLE_HEALTH_SECRET_NAME;
    await expect(ingest()).rejects.toThrow(/Missing required env/);
  });
});

describe('GET /bodyweight', () => {
  const event = { headers: {} } as unknown as APIGatewayProxyEvent;

  beforeEach(() => {
    process.env.CV_TABLE_NAME = 'cv-test';
    mockDdbSend.mockReset();
  });

  test('serves the stored snapshot as-is', async () => {
    const months = [{ month: '2026-09', kg: 80.4, lb: 177.2, complete: false }];
    mockDdbSend.mockResolvedValue({ Item: { id: BODYWEIGHT_ITEM_ID, months, updatedAt: '2026-09-28T16:00:00.000Z' } });
    const result = await getBodyweight(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ months, updatedAt: '2026-09-28T16:00:00.000Z' });
  });

  test('before the first ingest, an empty list is a normal answer', async () => {
    mockDdbSend.mockResolvedValue({});
    expect(JSON.parse((await getBodyweight(event)).body)).toEqual({ months: [], updatedAt: null });
  });
});
