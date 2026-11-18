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
import { handler as addHealthNote } from '../lambda/add-health-note';
import { handler as listHealthLog } from '../lambda/list-health-log';
import { LOG_DAYS, awaitingDay, logDates, measureDay, updateHealthLogSchema } from '../lambda/health-log-schema';
import { GoogleHealthError, resetGoogleHealthCache } from '../lambda/google-health';
import { UnreadableHealthDataError, classifyFetchError, toFetchError } from '../lambda/health-log-measure';
import { expectMatchesOutputSchema } from './output-schema';
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
    }, { dayIsOver: false });

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
    }, { dayIsOver: false });

    expect(measured.status).toBe('ready');
    expect(measured.missing).toEqual([{ signal: 'restingHeartRate', latestDate: '2026-11-09' }]);
    expect(measured.settled).toBe(false);
  });

  it('should call an empty night not_synced while the day is still going', () => {
    const measured = measureDay({ date, sleeps: [], hrv: daily(baseline, 50), restingHeartRate: [] }, { dayIsOver: false });
    expect(measured.status).toBe('not_synced');
  });

  it('should call an empty night no_data once the day is over, and say since when', () => {
    // The watch was last worn on the 6th: three nights, HRV and RHR stop there.
    const worn = baseline.filter((d) => d <= '2026-11-06');
    const measured = measureDay(
      {
        date,
        sleeps: worn.map((d) => night(d, 420)),
        hrv: daily(worn, 50),
        restingHeartRate: daily(worn, 55),
      },
      { dayIsOver: true },
    );

    expect(measured).toMatchObject({
      status: 'no_data',
      verdict: null,
      reasons: [],
      missing: [
        { signal: 'sleep', latestDate: '2026-11-06' },
        { signal: 'hrv', latestDate: '2026-11-06' },
        { signal: 'restingHeartRate', latestDate: '2026-11-06' },
      ],
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

  it('should not report a later night as the latest when judging an earlier day', () => {
    // Read at 22:00 on the 18th: the window holds the 18th's night too.
    const measured = measureDay(
      { date, sleeps: [night('2026-11-08', 420), night('2026-11-18', 420)], hrv: [], restingHeartRate: [] },
      { dayIsOver: true },
    );
    expect(measured.missing[0]).toEqual({ signal: 'sleep', latestDate: '2026-11-08' });
  });
});

describe('telling a failed read from an empty one', () => {
  it.each([
    ['a refused grant', new GoogleHealthError('refused', 'auth', 401), 'upstream_auth', 'owner_action', undefined],
    ['a Google error status', new GoogleHealthError('boom', 'api', 503), 'upstream_unavailable', 'now', 'api'],
    ['a timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'upstream_unavailable', 'now', 'network'],
    ['a dropped connection', new TypeError('fetch failed'), 'upstream_unavailable', 'now', 'network'],
    // Unreadable data is a bug here: never retried, never an empty night.
    ['data that could not be read', new UnreadableHealthDataError('sleep', 3), 'internal', 'never', 'parse'],
    ['anything else', new Error('???'), 'internal', 'never', undefined],
  ])('should classify %s', (_label, error, code, retry, cause) => {
    const classified = classifyFetchError(error);
    expect(classified).toMatchObject({ code, retry });
    expect(classified.details?.cause).toBe(cause);
  });
});

/**
 * Stub Google Health: a full night ending on `day` (unless `sleep` is false),
 * and daily HRV 50 ms / RHR 55 bpm on `day` and the 40 days before it.
 */
function stubGoogle(day: string, opts: { sleep?: boolean } = {}): jest.Mock {
  resetGoogleHealthCache();
  mockSecretsSend.mockReset();
  mockSecretsSend.mockResolvedValue({
    SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'cs', refresh_token: 'rt' }),
  });
  const baseline = daysBefore(day, 40);
  const fetchMock = jest.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
    }
    const type = /dataTypes\/([^/]+)\/dataPoints/.exec(url)?.[1];
    const dataPoints =
      type === 'sleep'
        ? opts.sleep === false
          ? []
          : [
            {
              sleep: {
                interval: { endTime: `${day}T11:00:00Z`, civilEndTime: { date: gDate(day) } },
                metadata: { processed: true, mainSleep: true },
                summary: { minutesAsleep: '450' },
              },
            },
          ]
        : type === 'daily-heart-rate-variability'
          ? [...baseline, day].map((d) => ({
              dailyHeartRateVariability: { date: gDate(d), averageHeartRateVariabilityMilliseconds: 50 },
            }))
          : [...baseline, day].map((d) => ({ dailyRestingHeartRate: { date: gDate(d), beatsPerMinute: '55' } }));
    return new Response(JSON.stringify({ dataPoints }), { status: 200 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('the nightly ingest', () => {
  let fetchMock: jest.Mock;
  const today = '2026-11-18';

  beforeEach(() => {
    fetchMock = stubGoogle(today);
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
    expect(commands[0].ExpressionAttributeValues[':measured']).toMatchObject({ status: 'no_data', settled: false });
  });

  it('should touch only the measured half, and never a settled day', async () => {
    mockDdbSend.mockResolvedValue({});
    await ingest();

    for (const [{ input }] of mockDdbSend.mock.calls) {
      expect(input.TableName).toBe(TABLE);
      expect(input.UpdateExpression).toBe(
        'SET #measured = :measured, #measuredAt = :measuredAt, #createdAt = if_not_exists(#createdAt, :measuredAt) ' +
          'REMOVE #fetchError',
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

  it('should record the failure on every unsettled day, measure nothing, and throw for a retry', async () => {
    fetchMock.mockImplementation(async (input: string | URL) =>
      String(input).startsWith('https://oauth2.googleapis.com/token')
        ? new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
        : new Response('{"error":"boom"}', { status: 503 }),
    );
    // One day is settled and refuses the write; that must not stop the rest.
    mockDdbSend.mockRejectedValueOnce(conditionFailed()).mockResolvedValue({});

    await expect(ingest()).rejects.toThrow('503');

    const writes = mockDdbSend.mock.calls.map(([c]) => c.input);
    expect(writes).toHaveLength(LOG_DAYS);
    for (const w of writes) {
      expect(w.UpdateExpression).toBe('SET #fetchError = :fetchError');
      expect(w.ConditionExpression).toBe('attribute_exists(#measured) AND #measured.#settled = :false');
      expect(w.ExpressionAttributeValues[':fetchError']).toMatchObject({ by: 'nightly', error: { code: 'upstream_unavailable', retry: 'now' } });
      expect(w.ExpressionAttributeValues).not.toHaveProperty(':measured');
    }
  });

  it('should treat data it cannot read as a failure, never as an empty night', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
      }
      // Sleep in a shape the parser does not know; the others empty.
      const dataPoints = url.includes('/sleep/') ? [{ sleep: { somethingNew: true } }, { sleep: {} }] : [];
      return new Response(JSON.stringify({ dataPoints }), { status: 200 });
    });
    mockDdbSend.mockResolvedValue({});

    await expect(ingest()).rejects.toThrow(UnreadableHealthDataError);

    const writes = mockDdbSend.mock.calls.map(([c]) => c.input);
    expect(writes.every((w) => w.ExpressionAttributeValues[':fetchError']?.error.details.cause === 'parse')).toBe(true);
    expect(writes.some((w) => ':measured' in w.ExpressionAttributeValues)).toBe(false);
  });
});

describe('opening today at 00:05', () => {
  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    // 00:05 in Montreal on the 18th (05:05 UTC).
    jest.useFakeTimers({ now: new Date('2026-11-18T05:05:00Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick'] });
  });

  it('should create today as an awaiting placeholder without reading Google', async () => {
    delete process.env.GOOGLE_HEALTH_SECRET_NAME;
    mockDdbSend.mockResolvedValueOnce({});

    const summary = await ingest({ mode: 'open' });

    expect(summary).toEqual({ mode: 'open', date: '2026-11-18', created: true });
    expect(global.fetch).not.toHaveBeenCalled();
    const { input } = mockDdbSend.mock.calls[0][0];
    expect(input.Key).toEqual({ pk: 'DAY', date: '2026-11-18' });
    expect(input.UpdateExpression).toBe('SET #measured = :measured, #createdAt = :createdAt');
    expect(input.ConditionExpression).toBe('attribute_not_exists(#measured)');
    expect(input.ExpressionAttributeValues[':measured']).toMatchObject({ status: 'awaiting', verdict: null, settled: false });
  });

  it('should leave a day that already exists exactly as it is', async () => {
    mockDdbSend.mockRejectedValueOnce(conditionFailed());

    expect(await ingest({ mode: 'open' })).toEqual({ mode: 'open', date: '2026-11-18', created: false });
  });

  it('should let the 22:00 run overwrite the placeholder, since it is never settled', async () => {
    expect(awaitingDay().settled).toBe(false);
  });
});

describe('the 10:00 morning run', () => {
  const today = '2026-11-18';
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = stubGoogle(today);
    // 10:00 in Montreal on the 18th.
    jest.useFakeTimers({ now: new Date('2026-11-18T15:00:00Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick'] });
  });

  const googleCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('health.googleapis.com'));

  it('should do nothing, not even call Google, when today already has readiness', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: { pk: 'DAY', date: today, measured: { status: 'ready', settled: false } } });

    expect(await ingest({ mode: 'morning' })).toEqual({ mode: 'morning', date: today, outcome: 'already_ready' });
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    expect(mockDdbSend.mock.calls[0][0].input.Key).toEqual({ pk: 'DAY', date: today });
    expect(googleCalls()).toHaveLength(0);
  });

  it('should record today over the awaiting placeholder, only while it is not ready', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { pk: 'DAY', date: today, measured: { status: 'awaiting', settled: false } } })
      .mockImplementationOnce(async (cmd) => ({ Attributes: { pk: 'DAY', date: today, measured: cmd.input.ExpressionAttributeValues[':measured'] } }));

    expect(await ingest({ mode: 'morning' })).toEqual({ mode: 'morning', date: today, outcome: 'recorded', status: 'ready' });
    const { input } = mockDdbSend.mock.calls[1][0];
    expect(input.Key).toEqual({ pk: 'DAY', date: today });
    expect(input.ConditionExpression).toBe(
      'attribute_not_exists(#measured) OR (#measured.#settled = :false AND #measured.#status <> :ready)',
    );
    expect(input.UpdateExpression).not.toMatch(/notes|tags|energy|mood|stress|soreness/);
    // One day's reads, each reaching back far enough to date a gap.
    expect(googleCalls().map(([u]) => new URL(String(u)).searchParams.get('filter'))).toEqual(
      expect.arrayContaining([
        // A week back, so a missing night can say when the last one was.
        'sleep.interval.civil_end_time >= "2026-11-11" AND sleep.interval.civil_end_time < "2026-11-19"',
        'daily_heart_rate_variability.date >= "2026-10-14" AND daily_heart_rate_variability.date < "2026-11-19"',
      ]),
    );
  });

  it('should record a not-yet-synced morning too, so a later update or 22:00 can fill it in', async () => {
    fetchMock = stubGoogle(today, { sleep: false });
    mockDdbSend
      .mockResolvedValueOnce({})
      .mockImplementationOnce(async (cmd) => ({ Attributes: { pk: 'DAY', date: today, measured: cmd.input.ExpressionAttributeValues[':measured'] } }));

    expect(await ingest({ mode: 'morning' })).toMatchObject({ outcome: 'recorded', status: 'not_synced' });
  });

  it('should treat a write refused because an update got there first as already done', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: { pk: 'DAY', date: today, measured: { status: 'awaiting' } } })
      .mockRejectedValueOnce(conditionFailed());

    expect(await ingest({ mode: 'morning' })).toEqual({ mode: 'morning', date: today, outcome: 'already_ready' });
  });
});

describe('the first note of the day fetching readiness', () => {
  const today = '2026-11-18';
  const NOTE = { at: '2026-11-18T13:00:00.000Z', text: 'Slept badly' };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = stubGoogle(today);
    // 08:00 in Montreal: before the 10:00 run.
    jest.useFakeTimers({ now: new Date('2026-11-18T13:00:00Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick'] });
  });

  const awaitingWithNote = {
    pk: 'DAY',
    date: today,
    measured: { status: 'awaiting', settled: false },
    notes: { '20261118T130000Z-0000': NOTE },
  };
  /** The note write answers with the day; the measure write echoes what it was sent. */
  const noteThenMeasure = (day: Record<string, unknown> = awaitingWithNote) =>
    mockDdbSend
      .mockResolvedValueOnce({ Attributes: day })
      .mockImplementationOnce(async (cmd) => ({
        Attributes: { ...day, measured: cmd.input.ExpressionAttributeValues[':measured'] },
      }));

  it('should save the note, then record readiness from Google under the until-ready rule', async () => {
    noteThenMeasure();

    const { statusCode, body } = parse(await addHealthNote(bodyEvent({ date: today, text: 'Slept badly' })));

    expect(statusCode).toBe(200);
    expect(Object.values(body.notes)).toEqual([NOTE]);
    expect(body.measured).toMatchObject({ status: 'ready', sleep: { minutesAsleep: 450 } });
    expect(body.readinessFetch).toEqual({ attempted: true, outcome: 'recorded', status: 'ready' });
    const [noteWrite, measureWrite] = mockDdbSend.mock.calls.map(([c]) => c.input);
    expect(noteWrite.UpdateExpression).not.toContain('#measured =');
    expect(measureWrite.ConditionExpression).toBe(
      'attribute_not_exists(#measured) OR (#measured.#settled = :false AND #measured.#status <> :ready)',
    );
  });

  it('should fetch on update_health_log too, when that is the first write of the day', async () => {
    noteThenMeasure();

    const { body } = parse(await updateHealthLog(bodyEvent({ date: today, mood: 2 })));

    expect(body.readinessFetch).toEqual({ attempted: true, outcome: 'recorded', status: 'ready' });
  });

  it('should not call Google when the day already has readiness', async () => {
    mockDdbSend.mockResolvedValueOnce({ Attributes: { ...awaitingWithNote, measured: { status: 'ready' } } });

    const { body } = parse(await addHealthNote(bodyEvent({ date: today, text: 'Afternoon slump' })));

    expect(body.readinessFetch).toEqual({ attempted: false, reason: 'already_ready' });
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should keep the note and report the failure when Google cannot be read', async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    mockDdbSend.mockResolvedValueOnce({ Attributes: awaitingWithNote });

    const { statusCode, body } = parse(await addHealthNote(bodyEvent({ date: today, text: 'Slept badly' })));

    expect(statusCode).toBe(200);
    expect(Object.values(body.notes)).toEqual([NOTE]);
    // The measured half is untouched: a failed read is not an empty night.
    expect(body.measured.status).toBe('awaiting');
    expect(body.readinessFetch).toMatchObject({ attempted: true, outcome: 'failed', error: { code: 'upstream_auth', retry: 'owner_action' } });
    expect(body.fetchError).toMatchObject({ by: 'chat', error: { code: 'upstream_auth' } });
    // The note write, then the fetchError written on the day; no measured write.
    expect(mockDdbSend).toHaveBeenCalledTimes(2);
    expect(mockDdbSend.mock.calls[1][0].input.UpdateExpression).toBe('SET #fetchError = :fetchError');
  });

  it('should record an empty night as an answer, not a failure', async () => {
    fetchMock = stubGoogle(today, { sleep: false });
    noteThenMeasure();

    const { body } = parse(await addHealthNote(bodyEvent({ date: today, text: 'Forgot the watch' })));

    // Today is not over: an empty night may still sync.
    expect(body.readinessFetch).toEqual({ attempted: true, outcome: 'recorded', status: 'not_synced' });
    expect(body.fetchError).toBeUndefined();
    expect(body.measured.missing[0]).toEqual({ signal: 'sleep', latestDate: null });
  });

  it('should call an empty night on a past day no_data', async () => {
    fetchMock = stubGoogle('2026-11-10', { sleep: false });
    noteThenMeasure({ ...awaitingWithNote, date: '2026-11-15' });

    const { body } = parse(await addHealthNote(bodyEvent({ date: '2026-11-15', text: 'Battery died' })));

    expect(body.readinessFetch).toEqual({ attempted: true, outcome: 'recorded', status: 'no_data' });
  });

  it('should leave a reading another writer made first, and say so', async () => {
    mockDdbSend.mockResolvedValueOnce({ Attributes: awaitingWithNote }).mockRejectedValueOnce(conditionFailed());

    const { body } = parse(await addHealthNote(bodyEvent({ date: today, text: 'Slept badly' })));

    expect(body.readinessFetch).toEqual({ attempted: true, outcome: 'already_ready' });
  });
});

describe('adding a note', () => {
  const day = '2026-11-17';
  const readyDay = { pk: 'DAY', date: day, measured: { status: 'ready' } };
  const refusedWith = (item?: Record<string, unknown>) =>
    new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {}, Item: item as never });

  beforeEach(() => {
    // 18:30 in Montreal.
    jest.useFakeTimers({ now: new Date('2026-11-17T23:30:00Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick'] });
  });

  it('should append one timestamped entry in a single write, and add its tags to the day\'s set', async () => {
    mockDdbSend.mockImplementationOnce(async (cmd) => ({
      Attributes: { ...readyDay, notes: { [cmd.input.ExpressionAttributeNames['#id']]: cmd.input.ExpressionAttributeValues[':note'] }, tags: new Set(['legs']) },
    }));

    const { statusCode, body } = parse(await addHealthNote(bodyEvent({ date: day, text: 'Legs wrecked', tags: ['Legs'] })));

    expect(statusCode).toBe(200);
    expect(body.id).toMatch(/^20261117T233000Z-[0-9a-f]{4}$/);
    expect(body.notes).toEqual({ [body.id]: { at: '2026-11-17T23:30:00.000Z', text: 'Legs wrecked' } });
    expect(body.tags).toEqual(['legs']);
    const { input } = mockDdbSend.mock.calls[0][0];
    expect(input.UpdateExpression).toBe('SET #notes.#id = :note, #notesUpdatedAt = :now ADD #tags :tags');
    expect(input.ConditionExpression).toBe('attribute_exists(#measured) AND attribute_exists(#notes) AND size(#notes) < :max');
    expect(input.ExpressionAttributeValues[':tags']).toEqual(new Set(['legs']));
    // Nothing measured is named in the write.
    expect(JSON.stringify(input.ExpressionAttributeNames)).not.toMatch(/sleep|hrv|verdict|status/);
  });

  it('should create the notes map with the day\'s first entry', async () => {
    mockDdbSend
      .mockRejectedValueOnce(refusedWith({ pk: { S: 'DAY' }, measured: { M: {} } }))
      .mockImplementationOnce(async (cmd) => ({ Attributes: { ...readyDay, notes: cmd.input.ExpressionAttributeValues[':first'] } }));

    const { statusCode, body } = parse(await addHealthNote(bodyEvent({ date: day, text: 'First' })));

    expect(statusCode).toBe(200);
    expect(Object.values(body.notes)).toEqual([{ at: '2026-11-17T23:30:00.000Z', text: 'First' }]);
    const retry = mockDdbSend.mock.calls[1][0].input;
    expect(retry.UpdateExpression).toBe('SET #notes = :first, #notesUpdatedAt = :now');
    expect(retry.ConditionExpression).toBe('attribute_exists(#measured) AND attribute_not_exists(#notes)');
  });

  it('should refuse a day the scheduler has not created', async () => {
    mockDdbSend.mockRejectedValueOnce(refusedWith(undefined));

    const { statusCode, body } = parse(await addHealthNote(bodyEvent({ date: '2026-11-19', text: 'Tomorrow' })));

    expect(statusCode).toBe(404);
    expect(body.message).toContain('No health log entry for 2026-11-19');
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  it('should refuse a day that is full', async () => {
    mockDdbSend.mockRejectedValueOnce(refusedWith({ measured: { M: {} }, notes: { M: {} } }));

    expect((await addHealthNote(bodyEvent({ date: day, text: 'One more' }))).statusCode).toBe(409);
  });

  it.each([
    ['no text', { date: day }],
    ['empty text', { date: day, text: '   ' }],
    ['a measured value', { date: day, text: 'x', measured: { verdict: 'push' } }],
    ['a non-English tag', { date: day, text: 'x', tags: ['睡眠'] }],
  ])('should reject %s without writing', async (_label, payload) => {
    expect((await addHealthNote(bodyEvent(payload))).statusCode).toBe(400);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});

describe('correcting a day (merge patch)', () => {
  const day = '2026-11-17';
  const A = '20261117T130000Z-aaaa';
  const B = '20261117T180000Z-bbbb';

  it('should rewrite one entry, remove another, and patch only the fields sent', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Attributes: {
        pk: 'DAY',
        date: day,
        measured: { status: 'ready' },
        notes: { [A]: { at: 'x', text: 'Sore legs, not knees', editedAt: 'y' } },
        tags: new Set(['legs', 'cold']),
      },
    });

    const { statusCode, body } = parse(
      await updateHealthLog(
        bodyEvent({ date: day, notes: { [A]: { text: 'Sore legs, not knees' }, [B]: null }, tags: ['Legs', 'cold'], energy: 2, mood: null }),
      ),
    );

    expect(statusCode).toBe(200);
    expect(body.notes).toEqual({ [A]: { at: 'x', text: 'Sore legs, not knees', editedAt: 'y' } });
    expect(body.tags).toEqual(['cold', 'legs']);
    const { input } = mockDdbSend.mock.calls[0][0];
    expect(input.ExpressionAttributeNames).toMatchObject({ '#n0': A, '#n1': B });
    expect(input.UpdateExpression).toBe(
      'SET #notesUpdatedAt = :now, #energy = :energy, #tags = :tags, #notes.#n0.#text = :t0, #notes.#n0.#editedAt = :now ' +
        'REMOVE #mood, #notes.#n1',
    );
    // Every entry named must already exist: a typo cannot create one.
    expect(input.ConditionExpression).toBe(
      'attribute_exists(#measured) AND attribute_exists(#notes.#n0) AND attribute_exists(#notes.#n1)',
    );
    expect(input.ExpressionAttributeValues[':tags']).toEqual(new Set(['legs', 'cold']));
  });

  it('should clear the tags with null or an empty list', async () => {
    for (const tags of [null, []]) {
      mockDdbSend.mockReset();
      mockDdbSend.mockResolvedValueOnce({ Attributes: { pk: 'DAY', date: day, measured: { status: 'ready' } } });
      const { body } = parse(await updateHealthLog(bodyEvent({ date: day, tags })));
      expect(mockDdbSend.mock.calls[0][0].input.UpdateExpression).toBe('SET #notesUpdatedAt = :now REMOVE #tags');
      expect(body.tags).toEqual([]);
    }
  });

  it('should say which ids it could not find, and point to add_health_note', async () => {
    mockDdbSend.mockRejectedValueOnce(conditionFailed());

    const { statusCode, body } = parse(await updateHealthLog(bodyEvent({ date: day, notes: { [A]: { text: 'x' } } })));

    expect(statusCode).toBe(404);
    expect(body.message).toContain(A);
    expect(body.message).toContain('add_health_note');
  });

  it('should refuse a day the scheduler has not created', async () => {
    mockDdbSend.mockRejectedValueOnce(conditionFailed());

    const { statusCode, body } = parse(await updateHealthLog(bodyEvent({ date: '2026-11-19', mood: 3 })));

    expect(statusCode).toBe(404);
    expect(body.message).toContain('No health log entry for 2026-11-19');
  });

  it.each([
    ['a measured value', { date: day, measured: { verdict: 'push' } }],
    ['the creation stamp', { date: day, createdAt: '2020-01-01' }],
    ['no change at all', { date: day }],
    ['a rating out of range', { date: day, energy: 6 }],
    ['a non-English tag', { date: day, tags: ['睡眠'] }],
    ['notes as plain text (the old shape)', { date: day, notes: 'Tired' }],
    ['a new note smuggled in under a made-up id', { date: day, notes: { 'my-note': { text: 'x' } } }],
    ['an entry with fields other than text', { date: day, notes: { [A]: { text: 'x', at: '2020-01-01' } } }],
    ['an empty notes patch', { date: day, notes: {} }],
    ['no date', { mood: 3 }],
  ])('should reject %s without writing', async (_label, payload) => {
    const { statusCode } = parse(await updateHealthLog(bodyEvent(payload)));

    expect(statusCode).toBe(400);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  it('should accept every field the schema advertises', () => {
    expect(
      updateHealthLogSchema.safeParse({
        date: day,
        notes: { [A]: { text: 'x' }, [B]: null },
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
  it('should return days that match the advertised outputSchema, as stored', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-19T03:00:00Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick'] });
    const baseline = daysBefore('2026-11-18', 14);
    const measured = measureDay(
      {
        date: '2026-11-18',
        sleeps: [night('2026-11-18', 450)],
        hrv: daily([...baseline, '2026-11-18'], 50),
        restingHeartRate: daily([...baseline, '2026-11-18'], 55),
      },
      { dayIsOver: true },
    );
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        {
          pk: 'DAY',
          date: '2026-11-18',
          measured,
          measuredAt: '2026-11-19T03:00:00.000Z',
          createdAt: '2026-11-18T05:05:00.000Z',
          notes: { '20261118T130000Z-a1b2': { at: '2026-11-18T13:00:00.000Z', text: 'Legs sore' } },
          // DynamoDB hands a string set back as a Set.
          tags: new Set(['legs']),
          soreness: 4,
          notesUpdatedAt: '2026-11-18T13:00:00.000Z',
        },
        {
          pk: 'DAY',
          date: '2026-11-17',
          measured: measureDay({ date: '2026-11-17', sleeps: [], hrv: [], restingHeartRate: [] }, { dayIsOver: true }),
          createdAt: '2026-11-17T05:05:00.000Z',
          fetchError: toFetchError(new GoogleHealthError('refused', 'auth', 401), 'nightly'),
        },
      ],
    });

    const { body } = parse(await listHealthLog(queryEvent()));

    expect(body.days[0].tags).toEqual(['legs']);
    expectMatchesOutputSchema('list_health_log', body);
  });

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
