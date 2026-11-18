import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

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

import { handler as ingest } from '../lambda/health-log-ingest';
import { handler as updateHealthLog } from '../lambda/update-health-log';
import { handler as listHealthLog } from '../lambda/list-health-log';
import { LOG_DAYS, logDates, measureDay, updateHealthLogSchema } from '../lambda/health-log-schema';
import { resetGoogleHealthCache } from '../lambda/google-health';
import type { DailyValue, SleepSession } from '../lambda/readiness';

const TABLE = 'health-log-test';

const gDate = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
};
const daysBefore = (date: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (i + 1));
    return d.toISOString().slice(0, 10);
  });

const night = (endDate: string, minutesAsleep: number): SleepSession => ({
  endDate,
  endTime: `${endDate}T11:00:00Z`,
  minutesAsleep,
  mainSleep: true,
  nap: false,
  processed: true,
});
const daily = (dates: string[], value: number): DailyValue[] => dates.map((date) => ({ date, value }));

const bodyEvent = (body: unknown): APIGatewayProxyEvent =>
  ({ body: JSON.stringify(body), headers: {} }) as unknown as APIGatewayProxyEvent;
const queryEvent = (query: Record<string, string> = {}): APIGatewayProxyEvent =>
  ({ queryStringParameters: query, headers: {} }) as unknown as APIGatewayProxyEvent;
const parse = (r: { statusCode: number; body: string }) => ({ statusCode: r.statusCode, body: JSON.parse(r.body) });

const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });

beforeEach(() => {
  process.env.HEALTH_LOG_TABLE_NAME = TABLE;
  process.env.GOOGLE_HEALTH_SECRET_NAME = 'google-health-oauth-test';
  process.env.HEALTH_TIME_ZONE = 'America/Toronto';
  mockDdbSend.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('measuring a day', () => {
  const date = '2026-11-10';
  const baseline = daysBefore(date, 14);

  it('should settle a day once sleep, HRV and resting heart rate are all in and judged', () => {
    const measured = measureDay({
      date,
      sleeps: [night(date, 450)],
      hrv: daily([...baseline, date], 50),
      restingHeartRate: daily([...baseline, date], 55),
    });

    expect(measured.status).toBe('ready');
    expect(measured.verdict).toBe('push');
    expect(measured.sleep).toEqual({ minutesAsleep: 450, endTime: `${date}T11:00:00Z`, processed: true });
    expect(measured.hrv).toMatchObject({ milliseconds: 50, baselineMean: 50, z: 0, flag: 'normal' });
    expect(measured.restingHeartRate).toMatchObject({ beatsPerMinute: 55, deltaBpm: 0, flag: 'normal' });
    expect(measured.reasons.length).toBeGreaterThan(0);
    expect(measured.settled).toBe(true);
  });

  it('should leave a ready day unsettled while its resting heart rate is still missing', () => {
    const measured = measureDay({
      date,
      sleeps: [night(date, 450)],
      hrv: daily([...baseline, date], 50),
      restingHeartRate: daily(baseline, 55),
    });

    expect(measured.status).toBe('ready');
    expect(measured.missing).toEqual(['restingHeartRate']);
    expect(measured.settled).toBe(false);
  });

  it('should still describe a day with no watch data, without the "ask again" prompts', () => {
    const measured = measureDay({ date, sleeps: [], hrv: daily(baseline, 50), restingHeartRate: [] });

    expect(measured).toMatchObject({
      status: 'not_synced',
      verdict: null,
      reasons: [],
      missing: ['sleep', 'hrv', 'restingHeartRate'],
      sleep: null,
      hrv: null,
      restingHeartRate: null,
      settled: false,
    });
  });

  it('should cover the last LOG_DAYS days, ending today', () => {
    const dates = logDates('2026-11-18');
    expect(dates).toHaveLength(LOG_DAYS);
    expect(dates[0]).toBe('2026-10-22');
    expect(dates[dates.length - 1]).toBe('2026-11-18');
  });
});

describe('the nightly ingest', () => {
  let fetchMock: jest.Mock;
  const today = '2026-11-18';

  beforeEach(() => {
    resetGoogleHealthCache();
    mockSecretsSend.mockReset();
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'cs', refresh_token: 'rt' }),
    });
    const baseline = daysBefore(today, 40);
    fetchMock = jest.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
      }
      const type = /dataTypes\/([^/]+)\/dataPoints/.exec(url)?.[1];
      const dataPoints =
        type === 'sleep'
          ? [
              {
                sleep: {
                  interval: { endTime: `${today}T11:00:00Z`, civilEndTime: { date: gDate(today) } },
                  metadata: { processed: true, mainSleep: true },
                  summary: { minutesAsleep: '450' },
                },
              },
            ]
          : type === 'daily-heart-rate-variability'
            ? [...baseline, today].map((d) => ({
                dailyHeartRateVariability: { date: gDate(d), averageHeartRateVariabilityMilliseconds: 50 },
              }))
            : [...baseline, today].map((d) => ({ dailyRestingHeartRate: { date: gDate(d), beatsPerMinute: '55' } }));
      return new Response(JSON.stringify({ dataPoints }), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    // 22:00 in Montreal on the 18th; already the 19th in UTC.
    jest.useFakeTimers({ now: new Date('2026-11-19T03:00:00Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick'] });
  });

  it('should write every day in the window, judged on the owner\'s calendar', async () => {
    mockDdbSend.mockResolvedValue({});

    const summary = await ingest();

    expect(summary).toEqual({ from: '2026-10-22', to: today, written: LOG_DAYS, settledSkipped: 0 });
    const commands = mockDdbSend.mock.calls.map(([c]) => c.input);
    expect(commands.map((c) => c.Key)).toEqual(logDates(today).map((date) => ({ pk: 'DAY', date })));

    const todayWrite = commands[commands.length - 1];
    expect(todayWrite.ExpressionAttributeValues[':measured']).toMatchObject({ status: 'ready', settled: true });
    expect(commands[0].ExpressionAttributeValues[':measured']).toMatchObject({ status: 'not_synced', settled: false });
  });

  it('should touch only the measured half, and never a settled day', async () => {
    mockDdbSend.mockResolvedValue({});
    await ingest();

    for (const [{ input }] of mockDdbSend.mock.calls) {
      expect(input.TableName).toBe(TABLE);
      expect(input.UpdateExpression).toBe(
        'SET #measured = :measured, #measuredAt = :measuredAt, #createdAt = if_not_exists(#createdAt, :measuredAt)',
      );
      expect(input.ConditionExpression).toBe('attribute_not_exists(#measured) OR #measured.#settled = :false');
    }
  });

  it('should count a settled day as skipped and carry on', async () => {
    mockDdbSend.mockRejectedValueOnce(conditionFailed()).mockResolvedValue({});

    const summary = await ingest();

    expect(summary.written).toBe(LOG_DAYS - 1);
    expect(summary.settledSkipped).toBe(1);
  });

  it('should read sleep over the window and HRV and RHR over the window plus a baseline', async () => {
    mockDdbSend.mockResolvedValue({});
    await ingest();

    const filters = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((u) => u.includes('health.googleapis.com'))
      .map((u) => new URL(u).searchParams.get('filter'));
    expect(filters).toEqual(
      expect.arrayContaining([
        'sleep.interval.civil_end_time >= "2026-10-22" AND sleep.interval.civil_end_time < "2026-11-19"',
        'daily_heart_rate_variability.date >= "2026-09-24" AND daily_heart_rate_variability.date < "2026-11-19"',
        'daily_resting_heart_rate.date >= "2026-09-24" AND daily_resting_heart_rate.date < "2026-11-19"',
      ]),
    );
  });

  it('should write nothing when Google cannot be read', async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":"boom"}', { status: 500 }));

    await expect(ingest()).rejects.toThrow();
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});

describe('annotating a day', () => {
  it('should set only the note fields, remove the nulled ones, and require the day to exist', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Attributes: { pk: 'DAY', date: '2026-11-17', measured: { status: 'ready' }, notes: 'Sore legs' },
    });

    const { statusCode, body } = parse(
      await updateHealthLog(bodyEvent({ date: '2026-11-17', notes: 'Sore legs', tags: ['Legs'], energy: 2, mood: null })),
    );

    expect(statusCode).toBe(200);
    expect(body).toEqual({ date: '2026-11-17', measured: { status: 'ready' }, notes: 'Sore legs' });
    const { input } = mockDdbSend.mock.calls[0][0];
    expect(input.Key).toEqual({ pk: 'DAY', date: '2026-11-17' });
    expect(input.ConditionExpression).toBe('attribute_exists(#measured)');
    expect(input.UpdateExpression).toBe(
      'SET #notesUpdatedAt = :notesUpdatedAt, #notes = :notes, #tags = :tags, #energy = :energy REMOVE #mood',
    );
    expect(input.ExpressionAttributeValues[':tags']).toEqual(['legs']);
  });

  it('should refuse a day the nightly job has not created', async () => {
    mockDdbSend.mockRejectedValueOnce(conditionFailed());

    const { statusCode, body } = parse(await updateHealthLog(bodyEvent({ date: '2026-11-18', notes: 'Tired' })));

    expect(statusCode).toBe(404);
    expect(body.message).toContain('No health log entry for 2026-11-18');
  });

  it.each([
    ['a measured value', { date: '2026-11-17', measured: { verdict: 'push' } }],
    ['the creation stamp', { date: '2026-11-17', createdAt: '2020-01-01' }],
    ['no change at all', { date: '2026-11-17' }],
    ['a rating out of range', { date: '2026-11-17', energy: 6 }],
    ['a non-English tag', { date: '2026-11-17', tags: ['睡眠'] }],
    ['no date', { notes: 'Tired' }],
  ])('should reject %s without writing', async (_label, payload) => {
    const { statusCode } = parse(await updateHealthLog(bodyEvent(payload)));

    expect(statusCode).toBe(400);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  it('should accept every note field the schema advertises', () => {
    expect(
      updateHealthLogSchema.safeParse({
        date: '2026-11-17',
        notes: 'x',
        tags: ['cold'],
        energy: 1,
        mood: 5,
        stress: 3,
        soreness: null,
      }).success,
    ).toBe(true);
  });
});

describe('reading the log', () => {
  it('should default to the last 14 days ending today in the owner\'s zone, newest first', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-19T03:00:00Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick'] });
    mockDdbSend.mockResolvedValueOnce({
      Items: [{ pk: 'DAY', date: '2026-11-18', measured: { status: 'ready' }, measuredAt: 'x', createdAt: 'x' }],
    });

    const { statusCode, body } = parse(await listHealthLog(queryEvent()));

    expect(statusCode).toBe(200);
    expect(body).toMatchObject({ from: '2026-11-05', to: '2026-11-18', count: 1 });
    expect(body.days[0]).not.toHaveProperty('pk');
    const { input } = mockDdbSend.mock.calls[0][0];
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'DAY', ':from': '2026-11-05', ':to': '2026-11-18' });
    expect(input.ScanIndexForward).toBe(false);
  });

  it('should refuse a reversed or over-long window', async () => {
    expect((await listHealthLog(queryEvent({ from: '2026-11-10', to: '2026-11-01' }))).statusCode).toBe(400);
    expect((await listHealthLog(queryEvent({ from: '2026-01-01', to: '2026-11-01' }))).statusCode).toBe(400);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});
