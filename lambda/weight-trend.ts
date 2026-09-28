import { addDays, civilDate, localDate } from './readiness';
import { LB_PER_KG } from './workout-schema';

/**
 * Bodyweight over time, from the owner's smart-scale weigh-ins in Google
 * Health, and how it relates to what the training log says about strength.
 *
 * Raw scale readings swing a kilogram or two from day to day on water and
 * food alone, so a single reading answers nothing. This module turns them
 * into the three things that do:
 *
 *   trend   a 7-day trailing mean, the weight the swings are around
 *   rate    a least-squares slope over the last 28 days, in kg, lb and % of
 *           bodyweight per week — robust to both the swings and missed days,
 *           unlike "latest minus four weeks ago", which is two noisy points
 *   ratio   an exercise's estimated 1RM over the bodyweight trend on the same
 *           day: "stronger, or just heavier?"
 *
 * Like readiness.ts, it never falls back to stale data silently: when the
 * newest weigh-in is old, the answer says so rather than presenting last
 * month's weight as today's.
 *
 * Free of AWS SDK and network imports.
 */

/** Days the trend averages over, ending on (and including) the day. */
export const TREND_DAYS = 7;
/** Fewest weigh-ins inside TREND_DAYS for a trend value to be given. */
export const MIN_TREND_POINTS = 3;
/** Days the rate is fitted over, ending on the newest weigh-in. */
export const RATE_DAYS = 28;
/** Fewest weigh-ins, and least span in days, for a rate to be given. */
export const MIN_RATE_POINTS = 7;
export const MIN_RATE_SPAN_DAYS = 14;
/** A weigh-in older than this is reported as stale. */
export const STALE_AFTER_DAYS = 7;
/**
 * Pace bands, in % of bodyweight per week. Descriptive, not prescriptive:
 * whether "fast" is right depends on the owner's goal, which this doesn't know.
 */
export const STABLE_PERCENT_PER_WEEK = 0.1;
export const FAST_PERCENT_PER_WEEK = 0.5;
/** How far back a lift may look for a bodyweight trend to divide by. */
export const RATIO_MAX_GAP_DAYS = 7;

export type Pace = 'stable' | 'gaining_slowly' | 'gaining_fast' | 'losing_slowly' | 'losing_fast';

/** One reading, placed on the owner's local calendar day. */
export interface Reading {
  readonly date: string;
  /** RFC 3339 instant of the reading. */
  readonly time: string;
  readonly value: number;
}

export interface DailyPoint {
  readonly date: string;
  readonly value: number;
}

// --- Parsing Google Health data points -----------------------------------------

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;

/**
 * The owner's local date of a sample, from the first source that has it:
 * `civilTime` (output-only, and output-only fields are exactly what went
 * missing for sleep), else `physicalTime` shifted by `utcOffset`, else
 * `physicalTime` in the configured `timeZone`.
 */
export function sampleDate(sampleTime: unknown, timeZone?: string): { date: string; time: string } | null {
  const st = asObject(sampleTime);
  const time = typeof st?.physicalTime === 'string' ? st.physicalTime : null;
  const ms = time ? Date.parse(time) : NaN;
  if (!time || Number.isNaN(ms)) return null;
  const offsetMatch = typeof st?.utcOffset === 'string' ? /^(-?\d+(?:\.\d+)?)s$/.exec(st.utcOffset) : null;
  const date =
    civilDate(asObject(st?.civilTime)?.date) ??
    (offsetMatch ? new Date(ms + Number(offsetMatch[1]) * 1000).toISOString().slice(0, 10) : null) ??
    (timeZone ? localDate(new Date(ms), timeZone) : null);
  return date ? { date, time } : null;
}

/** A `weight` data point → kilograms on its local day. */
export function parseWeight(point: unknown, timeZone?: string): Reading | null {
  const weight = asObject(asObject(point)?.weight);
  const when = sampleDate(weight?.sampleTime, timeZone);
  const grams = typeof weight?.weightGrams === 'number' ? weight.weightGrams : Number(weight?.weightGrams);
  return when && Number.isFinite(grams) && grams > 0 ? { ...when, value: grams / 1000 } : null;
}

/** A `body-fat` data point → percent on its local day. */
export function parseBodyFat(point: unknown, timeZone?: string): Reading | null {
  const bodyFat = asObject(asObject(point)?.bodyFat);
  const when = sampleDate(bodyFat?.sampleTime, timeZone);
  const percent = typeof bodyFat?.percentage === 'number' ? bodyFat.percentage : Number(bodyFat?.percentage);
  return when && Number.isFinite(percent) && percent > 0 && percent < 100 ? { ...when, value: percent } : null;
}

// --- Arithmetic --------------------------------------------------------------------

/**
 * One value per day: the day's earliest reading. On a smart scale that is the
 * morning weigh-in, the one taken in the same state every day; a later one
 * after a meal or a session adds only noise. Oldest day first.
 */
export function firstOfDay(readings: readonly Reading[]): DailyPoint[] {
  const byDate = new Map<string, Reading>();
  for (const r of readings) {
    const kept = byDate.get(r.date);
    if (!kept || Date.parse(r.time) < Date.parse(kept.time)) byDate.set(r.date, r);
  }
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ date, value }) => ({ date, value }));
}

/** Days between two ISO dates, `b - a`. */
export const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Mean of the points in the TREND_DAYS ending on `date`; null when too few. */
export function trendOn(points: readonly DailyPoint[], date: string): number | null {
  const from = addDays(date, -(TREND_DAYS - 1));
  const inWindow = points.filter((p) => p.date >= from && p.date <= date);
  if (inWindow.length < MIN_TREND_POINTS) return null;
  return inWindow.reduce((sum, p) => sum + p.value, 0) / inWindow.length;
}

/** Least-squares slope per day over the points; null with fewer than two. */
export function slopePerDay(points: readonly DailyPoint[]): number | null {
  if (points.length < 2) return null;
  const origin = points[0].date;
  const xs = points.map((p) => daysBetween(origin, p.date));
  const ys = points.map((p) => p.value);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sxx = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  if (sxx === 0) return null;
  return xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / sxx;
}

export function paceOf(percentPerWeek: number): Pace {
  const magnitude = Math.abs(percentPerWeek);
  if (magnitude < STABLE_PERCENT_PER_WEEK) return 'stable';
  const fast = magnitude >= FAST_PERCENT_PER_WEEK;
  return percentPerWeek > 0 ? (fast ? 'gaining_fast' : 'gaining_slowly') : fast ? 'losing_fast' : 'losing_slowly';
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const toLb = (kg: number) => kg * LB_PER_KG;

export interface Rate {
  readonly from: string;
  readonly to: string;
  readonly points: number;
  readonly perWeek: number;
  readonly percentPerWeek: number;
}

/** The fitted rate over the RATE_DAYS ending on the newest point, or why there is none. */
export function rateOf(points: readonly DailyPoint[]): Rate | { reason: string } {
  const last = points.at(-1);
  if (!last) return { reason: 'No readings in the window.' };
  const from = addDays(last.date, -(RATE_DAYS - 1));
  const recent = points.filter((p) => p.date >= from);
  const span = daysBetween(recent[0].date, last.date);
  if (recent.length < MIN_RATE_POINTS || span < MIN_RATE_SPAN_DAYS) {
    return {
      reason:
        `Only ${recent.length} reading day(s) over ${span} day(s) in the last ${RATE_DAYS}; a rate needs ` +
        `at least ${MIN_RATE_POINTS} over ${MIN_RATE_SPAN_DAYS} days.`,
    };
  }
  const slope = slopePerDay(recent)!;
  const mean = recent.reduce((sum, p) => sum + p.value, 0) / recent.length;
  return {
    from: recent[0].date,
    to: last.date,
    points: recent.length,
    perWeek: slope * 7,
    percentPerWeek: (slope * 7 * 100) / mean,
  };
}

// --- The answer ----------------------------------------------------------------------

export interface WeightTrendInput {
  /** The owner's local today. */
  readonly asOf: string;
  readonly weights: readonly Reading[];
  readonly bodyFat: readonly Reading[];
}

export function weightTrend(input: WeightTrendInput) {
  const daily = firstOfDay(input.weights);
  const fatDaily = firstOfDay(input.bodyFat);
  const fatByDate = new Map(fatDaily.map((p) => [p.date, p.value]));

  const series = daily.map((p) => {
    const trend = trendOn(daily, p.date);
    return {
      date: p.date,
      kg: round2(p.value),
      lb: round1(toLb(p.value)),
      trendKg: trend === null ? null : round2(trend),
      trendLb: trend === null ? null : round1(toLb(trend)),
      bodyFatPercent: fatByDate.has(p.date) ? round1(fatByDate.get(p.date)!) : null,
    };
  });

  const newest = series.at(-1) ?? null;
  const daysSince = newest ? daysBetween(newest.date, input.asOf) : null;

  const weightRate = rateOf(daily);
  const rate =
    'reason' in weightRate
      ? weightRate
      : {
          from: weightRate.from,
          to: weightRate.to,
          points: weightRate.points,
          kgPerWeek: round2(weightRate.perWeek),
          lbPerWeek: round2(toLb(weightRate.perWeek)),
          percentPerWeek: round2(weightRate.percentPerWeek),
          pace: paceOf(weightRate.percentPerWeek),
        };

  const fatRate = rateOf(fatDaily);
  const newestFat = fatDaily.at(-1) ?? null;
  const bodyFat = newestFat
    ? {
        latest: { date: newestFat.date, percent: round1(newestFat.value) },
        trendPercent: (() => {
          const t = trendOn(fatDaily, newestFat.date);
          return t === null ? null : round1(t);
        })(),
        // Body fat is already a percentage, so its rate is in percentage points.
        rate: 'reason' in fatRate
          ? fatRate
          : { from: fatRate.from, to: fatRate.to, points: fatRate.points, pointsPerWeek: round2(fatRate.perWeek) },
      }
    : null;

  const notes: string[] = [];
  if (!newest) notes.push('No weigh-ins in the window. Has the scale synced to Google Health?');
  else if (daysSince! > STALE_AFTER_DAYS) {
    notes.push(`The newest weigh-in is ${daysSince} days old (${newest.date}); this is not today's weight.`);
  }

  return {
    latest: newest && { ...newest, daysAgo: daysSince, stale: daysSince! > STALE_AFTER_DAYS },
    rate,
    bodyFat,
    series,
    notes,
  };
}

// --- Strength relative to bodyweight -----------------------------------------------

export interface LiftSession {
  readonly date: string;
  /** Best estimated 1RM of the session, in kg. */
  readonly e1rmKg: number;
}

/**
 * Each session's best estimated 1RM over the bodyweight trend on that day, or
 * the nearest earlier day within RATIO_MAX_GAP_DAYS. A session with no trend
 * that close is left out rather than divided by a weight from weeks away.
 */
export function relativeStrength(sessions: readonly LiftSession[], weights: readonly DailyPoint[]) {
  const rows = sessions
    .filter((s) => s.e1rmKg > 0)
    .map((s) => {
      for (let back = 0; back <= RATIO_MAX_GAP_DAYS; back += 1) {
        const day = addDays(s.date, -back);
        const trend = trendOn(weights, day);
        if (trend !== null) {
          return {
            date: s.date,
            e1rmKg: round1(s.e1rmKg),
            bodyweightKg: round2(trend),
            ratio: round2(s.e1rmKg / trend),
          };
        }
      }
      return null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const first = rows[0];
  const last = rows.at(-1);
  return {
    sessions: rows,
    change:
      first && last && first !== last
        ? {
            from: first.date,
            to: last.date,
            e1rmKg: round1(last.e1rmKg - first.e1rmKg),
            bodyweightKg: round2(last.bodyweightKg - first.bodyweightKg),
            ratio: round2(last.ratio - first.ratio),
          }
        : null,
  };
}
