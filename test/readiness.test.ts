import {
  BASELINE_DAYS,
  MIN_BASELINE_DAYS,
  addDays,
  civilDate,
  isIsoDate,
  judgeReadiness,
  localDate,
  nightOf,
  parseDailyHrv,
  parseDailyRestingHeartRate,
  parseSleep,
  type DailyValue,
  type SleepSession,
} from '../lambda/readiness';

const TODAY = '2026-09-26';

/** `days` consecutive daily values ending the day before `end`, all equal to `value(i)`. */
const history = (end: string, days: number, value: (i: number) => number): DailyValue[] =>
  Array.from({ length: days }, (_, i) => ({ date: addDays(end, -(i + 1)), value: value(i) }));

/** A spread-out HRV baseline around 60 ms, so a z-score is meaningful. */
const hrvBaseline = history(TODAY, BASELINE_DAYS, (i) => [55, 60, 65][i % 3]);
const rhrBaseline = history(TODAY, BASELINE_DAYS, (i) => [54, 55, 56][i % 3]);

const night = (over: Partial<SleepSession> = {}): SleepSession => ({
  endDate: TODAY,
  endTime: '2026-09-25T22:10:00Z',
  minutesAsleep: 450,
  mainSleep: true,
  nap: false,
  processed: true,
  ...over,
});

const judge = (over: {
  sleeps?: SleepSession[];
  hrvToday?: number | null;
  rhrToday?: number | null;
  hrv?: DailyValue[];
  rhr?: DailyValue[];
} = {}) =>
  judgeReadiness({
    date: TODAY,
    sleeps: over.sleeps ?? [night()],
    hrv: [
      ...(over.hrv ?? hrvBaseline),
      ...(over.hrvToday === null ? [] : [{ date: TODAY, value: over.hrvToday ?? 62 }]),
    ],
    restingHeartRate: [
      ...(over.rhr ?? rhrBaseline),
      ...(over.rhrToday === null ? [] : [{ date: TODAY, value: over.rhrToday ?? 55 }]),
    ],
  });

describe('dates', () => {
  test('localDate is the owner\'s calendar day, not the UTC one', () => {
    // 20:00 UTC on the 25th is 05:00 on the 26th in Tokyo — the hour this is asked.
    expect(localDate(new Date('2026-09-25T20:00:00Z'), 'Asia/Tokyo')).toBe('2026-09-26');
    expect(localDate(new Date('2026-09-25T20:00:00Z'), 'UTC')).toBe('2026-09-25');
  });

  test('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  test('isIsoDate rejects impossible dates', () => {
    expect(isIsoDate('2026-09-26')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('26-09-2026')).toBe(false);
  });
});

describe('parsing Google Health data points', () => {
  test('civilDate zero-pads google.type.Date', () => {
    expect(civilDate({ year: 2026, month: 9, day: 6 })).toBe('2026-09-06');
    expect(civilDate({ year: 2026, month: 9 })).toBeNull();
  });

  test('daily HRV reads the average rMSSD', () => {
    expect(
      parseDailyHrv({
        dailyHeartRateVariability: {
          date: { year: 2026, month: 9, day: 26 },
          averageHeartRateVariabilityMilliseconds: 48.7,
          nonRemHeartRateBeatsPerMinute: '52',
        },
      }),
    ).toEqual({ date: '2026-09-26', value: 48.7 });
    // A point carrying only the other HRV fields has no value to judge on.
    expect(
      parseDailyHrv({ dailyHeartRateVariability: { date: { year: 2026, month: 9, day: 26 }, entropy: 3.1 } }),
    ).toBeNull();
  });

  test('daily resting heart rate reads int64 bpm sent as a string', () => {
    expect(
      parseDailyRestingHeartRate({
        dailyRestingHeartRate: { date: { year: 2026, month: 9, day: 26 }, beatsPerMinute: '57' },
      }),
    ).toEqual({ date: '2026-09-26', value: 57 });
  });

  test('sleep is keyed on the local date it ended, with omitted booleans read as false', () => {
    const point = {
      name: 'users/me/dataTypes/sleep/dataPoints/abc',
      sleep: {
        interval: {
          startTime: '2026-09-25T14:00:00Z',
          endTime: '2026-09-25T21:30:00Z',
          civilEndTime: { date: { year: 2026, month: 9, day: 26 }, time: { hours: 6, minutes: 30 } },
        },
        type: 'STAGES',
        metadata: { processed: true, mainSleep: true },
        summary: { minutesAsleep: '412', minutesAwake: '38' },
      },
    };
    expect(parseSleep(point)).toEqual({
      endDate: '2026-09-26',
      endTime: '2026-09-25T21:30:00Z',
      minutesAsleep: 412,
      mainSleep: true,
      nap: false,
      processed: true,
    });

    const processing = { sleep: { ...point.sleep, metadata: {} } };
    expect(parseSleep(processing)?.processed).toBe(false);
    expect(parseSleep({ sleep: { interval: {} } })).toBeNull();
  });
});

test('nightOf prefers the main sleep and ignores naps', () => {
  const nap = night({ nap: true, mainSleep: false, minutesAsleep: 600 });
  const shortSegment = night({ mainSleep: false, minutesAsleep: 90 });
  const main = night({ minutesAsleep: 400 });
  expect(nightOf([nap, shortSegment, main], TODAY)).toBe(main);
  // With no main sleep marked, the longest non-nap stands in.
  expect(nightOf([nap, shortSegment, night({ mainSleep: false, minutesAsleep: 380 })], TODAY)?.minutesAsleep).toBe(380);
  expect(nightOf([night({ endDate: '2026-09-25' })], TODAY)).toBeNull();
});

describe('withholding a verdict', () => {
  test('no night ending today → not_synced, with the newest night that did sync', () => {
    const result = judge({ sleeps: [night({ endDate: '2026-09-24' })], hrvToday: null, rhrToday: null });
    expect(result.status).toBe('not_synced');
    expect(result.verdict).toBeNull();
    expect(result.missing).toEqual([
      { signal: 'sleep', latestDate: '2026-09-24' },
      { signal: 'hrv', latestDate: '2026-09-25' },
      { signal: 'restingHeartRate', latestDate: '2026-09-25' },
    ]);
  });

  test('yesterday\'s HRV is never used in place of today\'s', () => {
    // Yesterday was a great night; today's HRV has not arrived. The answer must
    // be "wait", not a verdict built on yesterday.
    const hrv = [...hrvBaseline.filter((v) => v.date !== '2026-09-25'), { date: '2026-09-25', value: 90 }];
    const result = judge({ hrv, hrvToday: null });
    expect(result.status).toBe('pending');
    expect(result.verdict).toBeNull();
    expect(result.signals.hrv).toBeNull();
  });

  test('a night still being processed → pending', () => {
    const result = judge({ sleeps: [night({ processed: false })] });
    expect(result.status).toBe('pending');
    expect(result.verdict).toBeNull();
  });

  test('too little HRV history → insufficient_baseline', () => {
    const result = judge({ hrv: hrvBaseline.slice(0, MIN_BASELINE_DAYS - 1) });
    expect(result.status).toBe('insufficient_baseline');
    expect(result.verdict).toBeNull();
  });

  test('history older than the baseline window does not count toward it', () => {
    const old = history(addDays(TODAY, -BASELINE_DAYS), 20, () => 60);
    expect(judge({ hrv: old }).status).toBe('insufficient_baseline');
  });
});

describe('verdicts', () => {
  test('a full night, HRV at or above baseline and a normal RHR → push', () => {
    const result = judge({ hrvToday: 64, rhrToday: 55, sleeps: [night({ minutesAsleep: 460 })] });
    expect(result.status).toBe('ready');
    expect(result.verdict).toBe('push');
    expect(result.signals.hrv).toMatchObject({ date: TODAY, flag: 'normal' });
    expect(result.signals.restingHeartRate).toMatchObject({ date: TODAY, flag: 'normal' });
    expect(result.missing).toEqual([]);
  });

  test('an unremarkable morning → normal', () => {
    // HRV a touch under the mean, not enough to flag; sleep fine but not full.
    const result = judge({ hrvToday: 58, sleeps: [night({ minutesAsleep: 390 })] });
    expect(result.verdict).toBe('normal');
  });

  test('HRV well below baseline alone → easy', () => {
    const result = judge({ hrvToday: 40 });
    expect(result.signals.hrv?.flag).toBe('low');
    expect(result.verdict).toBe('easy');
  });

  test('a very short night alone → easy', () => {
    expect(judge({ sleeps: [night({ minutesAsleep: 280 })] }).verdict).toBe('easy');
  });

  test('RHR well above baseline alone → easy', () => {
    const result = judge({ rhrToday: 61 });
    expect(result.signals.restingHeartRate?.flag).toBe('elevated');
    expect(result.verdict).toBe('easy');
  });

  test('one mild flag is noise; two agreeing are not', () => {
    // Short sleep only.
    expect(judge({ sleeps: [night({ minutesAsleep: 340 })] }).verdict).toBe('normal');
    // Short sleep and a slightly raised RHR together.
    expect(judge({ sleeps: [night({ minutesAsleep: 340 })], rhrToday: 58 }).verdict).toBe('easy');
  });

  test('a missing RHR still yields a verdict from sleep and HRV, and says so', () => {
    const result = judge({ rhrToday: null, hrvToday: 64 });
    expect(result.status).toBe('ready');
    expect(result.verdict).toBe('push');
    expect(result.missing).toEqual([{ signal: 'restingHeartRate', latestDate: '2026-09-25' }]);
    expect(result.reasons.join(' ')).toMatch(/Resting HR for 2026-09-26 not available/);
  });

  test('a flat baseline does not divide by zero', () => {
    const flat = history(TODAY, 10, () => 60);
    const result = judge({ hrv: flat, hrvToday: 45 });
    expect(result.signals.hrv?.z).toBe(0);
    expect(result.status).toBe('ready');
  });
});
