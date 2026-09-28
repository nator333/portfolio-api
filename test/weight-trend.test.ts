import { addDays } from '../lambda/readiness';
import {
  firstOfDay,
  paceOf,
  parseBodyFat,
  parseWeight,
  rateOf,
  relativeStrength,
  sampleDate,
  slopePerDay,
  trendOn,
  weightTrend,
  type Reading,
} from '../lambda/weight-trend';

const TODAY = '2026-09-28';

/** A morning weigh-in (07:00 Montreal, UTC-4) on `date`. */
const reading = (date: string, value: number, hourUtc = 11): Reading => ({
  date,
  time: `${date}T${String(hourUtc).padStart(2, '0')}:00:00Z`,
  value,
});

/**
 * `days` daily readings ending today, rising `perDay` kg a day from `start`,
 * with a ±0.6 kg water-weight wobble that averages out over a week.
 */
const scale = (days: number, start: number, perDay: number): Reading[] =>
  Array.from({ length: days }, (_, i) => {
    const wobble = [0.6, -0.4, 0.2, -0.6, 0.4, -0.2, 0][i % 7];
    return reading(addDays(TODAY, -(days - 1 - i)), start + perDay * i + wobble);
  });

describe('parsing Google Health samples', () => {
  const weightPoint = (sampleTime: Record<string, unknown>, weightGrams: unknown = 80250) => ({
    weight: { sampleTime, weightGrams },
  });

  test('weight grams become kilograms on the local day', () => {
    expect(
      parseWeight(weightPoint({ physicalTime: '2026-09-28T11:05:00Z', utcOffset: '-14400s' })),
    ).toEqual({ date: '2026-09-28', time: '2026-09-28T11:05:00Z', value: 80.25 });
  });

  test('a late-evening weigh-in stays on its local day, though UTC is already tomorrow', () => {
    expect(sampleDate({ physicalTime: '2026-09-29T02:30:00Z', utcOffset: '-14400s' })?.date).toBe('2026-09-28');
    // No offset either: the configured zone decides.
    expect(sampleDate({ physicalTime: '2026-09-29T02:30:00Z' }, 'America/Toronto')?.date).toBe('2026-09-28');
    // civilTime wins when present.
    expect(
      sampleDate({ physicalTime: '2026-09-29T02:30:00Z', civilTime: { date: { year: 2026, month: 9, day: 28 } } })?.date,
    ).toBe('2026-09-28');
  });

  test('unusable points are skipped, not guessed', () => {
    expect(parseWeight(weightPoint({ physicalTime: '2026-09-28T11:05:00Z' }))).toBeNull(); // no way to place the day
    expect(parseWeight(weightPoint({ physicalTime: 'not a time', utcOffset: '0s' }))).toBeNull();
    expect(parseWeight(weightPoint({ physicalTime: '2026-09-28T11:05:00Z', utcOffset: '0s' }, 0))).toBeNull();
  });

  test('body fat reads its percentage', () => {
    expect(
      parseBodyFat({ bodyFat: { sampleTime: { physicalTime: '2026-09-28T11:05:00Z', utcOffset: '-14400s' }, percentage: 17.4 } }),
    ).toEqual({ date: '2026-09-28', time: '2026-09-28T11:05:00Z', value: 17.4 });
  });
});

test("each day keeps its earliest weigh-in, the morning one", () => {
  const daily = firstOfDay([
    reading('2026-09-27', 81.4, 22), // evening, after dinner
    reading('2026-09-27', 80.1, 11), // morning
    reading('2026-09-26', 80.3, 11),
  ]);
  expect(daily).toEqual([
    { date: '2026-09-26', value: 80.3 },
    { date: '2026-09-27', value: 80.1 },
  ]);
});

describe('trend and rate', () => {
  test('the trend is the mean of the last 7 days, and needs 3 readings', () => {
    const daily = firstOfDay(scale(7, 80, 0)); // flat, wobble only
    expect(trendOn(daily, TODAY)).toBeCloseTo(80, 5);
    expect(trendOn(daily.slice(0, 2), daily[1].date)).toBeNull();
  });

  test('the fitted rate sees through day-to-day wobble', () => {
    // +0.05 kg/day = +0.35 kg/week, under ±0.6 kg of daily noise.
    const rate = rateOf(firstOfDay(scale(28, 80, 0.05)));
    expect('reason' in rate).toBe(false);
    if (!('reason' in rate)) {
      expect(rate.perWeek).toBeCloseTo(0.35, 1);
      expect(rate.points).toBe(28);
    }
  });

  test('gaps do not distort the slope', () => {
    // Same underlying gain, but only every third day weighed.
    const sparse = firstOfDay(scale(28, 80, 0.05).filter((_, i) => i % 3 === 0));
    expect(slopePerDay(sparse)! * 7).toBeCloseTo(0.35, 1);
  });

  test('too few weigh-ins give a reason instead of a rate', () => {
    const rate = rateOf(firstOfDay(scale(5, 80, 0.05)));
    expect(rate).toHaveProperty('reason');
  });

  test('pace bands', () => {
    expect(paceOf(0.05)).toBe('stable');
    expect(paceOf(0.3)).toBe('gaining_slowly');
    expect(paceOf(0.7)).toBe('gaining_fast');
    expect(paceOf(-0.3)).toBe('losing_slowly');
    expect(paceOf(-0.8)).toBe('losing_fast');
  });
});

describe('the answer', () => {
  test('a steady lean bulk', () => {
    const result = weightTrend({ asOf: TODAY, weights: scale(60, 78, 0.03), bodyFat: [] });
    expect(result.latest).toMatchObject({ date: TODAY, daysAgo: 0, stale: false });
    expect(result.rate).toMatchObject({ pace: 'gaining_slowly' });
    // Both units, from the same fit.
    if ('kgPerWeek' in result.rate) expect(result.rate.lbPerWeek).toBeCloseTo(result.rate.kgPerWeek * 2.20462, 1);
    expect(result.bodyFat).toBeNull();
    expect(result.series).toHaveLength(60);
  });

  test('an old newest weigh-in is flagged, not presented as today', () => {
    const old = scale(30, 80, 0).map((r) => ({ ...r, date: addDays(r.date, -10), time: r.time }));
    const result = weightTrend({ asOf: TODAY, weights: old, bodyFat: [] });
    expect(result.latest).toMatchObject({ daysAgo: 10, stale: true });
    expect(result.notes.join(' ')).toMatch(/10 days old/);
  });

  test('no weigh-ins at all says so', () => {
    const result = weightTrend({ asOf: TODAY, weights: [], bodyFat: [] });
    expect(result.latest).toBeNull();
    expect(result.notes.join(' ')).toMatch(/No weigh-ins/);
  });

  test('body fat rides along with its own rate in percentage points', () => {
    const fat = scale(28, 18, -0.01).map((r) => ({ ...r, value: r.value / 1 }));
    const result = weightTrend({ asOf: TODAY, weights: scale(28, 80, 0), bodyFat: fat });
    expect(result.bodyFat?.latest.date).toBe(TODAY);
    expect(result.bodyFat?.rate).toHaveProperty('pointsPerWeek');
    expect(result.series.at(-1)?.bodyFatPercent).not.toBeNull();
  });
});

describe('strength relative to bodyweight', () => {
  const weights = firstOfDay(scale(60, 80, 0.02));

  test('divides each session by the bodyweight trend that day', () => {
    const result = relativeStrength(
      [
        { date: addDays(TODAY, -50), e1rmKg: 100 },
        { date: addDays(TODAY, -2), e1rmKg: 110 },
      ],
      weights,
    );
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].ratio).toBeCloseTo(100 / result.sessions[0].bodyweightKg, 2);
    expect(result.change?.e1rmKg).toBe(10);
    expect(result.change?.ratio).toBeGreaterThan(0); // stronger faster than heavier
  });

  test('a session with no weigh-ins nearby is left out, not divided by a distant weight', () => {
    const result = relativeStrength([{ date: addDays(TODAY, -90), e1rmKg: 100 }], weights);
    expect(result.sessions).toEqual([]);
    expect(result.change).toBeNull();
  });

  test('bodyweight-only sessions (no 1RM) are ignored', () => {
    expect(relativeStrength([{ date: TODAY, e1rmKg: 0 }], weights).sessions).toEqual([]);
  });
});
