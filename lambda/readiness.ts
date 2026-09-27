/**
 * "Should today be a hard session, a normal one, or an easy one?" — decided
 * from last night's recovery signals, and only from last night's.
 *
 * The signals come from the Google Health API (see google-health.ts) and are
 * fetched at the moment the question is asked, not by a scheduled ingest: last
 * night's sleep, HRV and resting heart rate only exist once the watch has
 * synced after waking, and a batch that ran before that would quietly have
 * judged today on the night before last. For the same reason nothing here ever
 * falls back to an older value when today's is missing. A verdict built on
 * stale recovery data is worse than no verdict — it says "go hard" with
 * confidence it hasn't earned — so a missing signal is reported as missing,
 * with the date of the newest value that *does* exist, and the verdict is
 * withheld until the data arrives.
 *
 * Kept free of AWS SDK and network imports so the handler, the MCP server and
 * the tests all share the same arithmetic.
 */

/** Days of history (ending yesterday) that today's values are judged against. */
export const BASELINE_DAYS = 28;

/**
 * Fewest baseline days a relative judgement is made on. HRV varies a great deal
 * night to night, so "low for you" means nothing until there is roughly a week
 * of "you" to compare against.
 */
export const MIN_BASELINE_DAYS = 7;

/**
 * HRV is compared on its natural log, the usual practice for rMSSD: its
 * distribution is right-skewed, and a drop from 60 to 50 ms matters more than
 * one from 110 to 100. Thresholds are in baseline standard deviations.
 */
export const HRV_LOW_Z = -1;
export const HRV_SLIGHTLY_LOW_Z = -0.5;

/** Resting heart rate above its baseline mean, in beats per minute. */
export const RHR_ELEVATED_BPM = 5;
export const RHR_SLIGHTLY_ELEVATED_BPM = 3;

/** Minutes actually asleep (not time in bed). */
export const SLEEP_VERY_SHORT_MINUTES = 300;
export const SLEEP_SHORT_MINUTES = 360;
/** A "push" day asks for a genuinely full night, not merely a non-short one. */
export const SLEEP_FULL_MINUTES = 420;

export type Verdict = 'push' | 'normal' | 'easy';

/**
 * - `ready`: every required signal for the day is in; `verdict` is set.
 * - `not_synced`: no sleep ending on the day has reached the API yet — the
 *   watch has not synced since waking (or was not worn).
 * - `pending`: the night has synced but is still being processed, or the day's
 *   HRV has not been published yet. Ask again in a few minutes.
 * - `insufficient_baseline`: too little HRV history to say what "low" means.
 */
export type ReadinessStatus = 'ready' | 'not_synced' | 'pending' | 'insufficient_baseline';

export type HrvFlag = 'low' | 'slightly_low' | 'normal';
export type RhrFlag = 'elevated' | 'slightly_elevated' | 'normal';
export type SleepFlag = 'very_short' | 'short' | 'normal';

/** One night's sleep, reduced to what the judgement reads. */
export interface SleepSession {
  /** The owner's local calendar date the session ended on — the morning after. */
  readonly endDate: string;
  /** RFC 3339 instant the session ended. */
  readonly endTime: string;
  readonly minutesAsleep: number | null;
  readonly mainSleep: boolean;
  readonly nap: boolean;
  /** False while the sleep-stage algorithms are still running on the night. */
  readonly processed: boolean;
}

/** A once-a-day value: daily HRV (ms) or daily resting heart rate (bpm). */
export interface DailyValue {
  readonly date: string;
  readonly value: number;
}

export interface ReadinessInput {
  /** The owner's local date being judged, ISO YYYY-MM-DD. */
  readonly date: string;
  /** Sleep sessions ending on `date`; others are ignored. */
  readonly sleeps: readonly SleepSession[];
  /** Daily HRV covering the baseline window and `date`. */
  readonly hrv: readonly DailyValue[];
  /** Daily resting heart rate covering the baseline window and `date`. */
  readonly restingHeartRate: readonly DailyValue[];
}

export interface Baseline {
  readonly mean: number;
  readonly sd: number;
  readonly days: number;
}

export interface MissingSignal {
  readonly signal: 'sleep' | 'hrv' | 'restingHeartRate';
  /** Newest date the signal does have a value for, so a sync gap is visible. */
  readonly latestDate: string | null;
}

export interface ReadinessResult {
  readonly date: string;
  readonly status: ReadinessStatus;
  readonly verdict: Verdict | null;
  readonly reasons: string[];
  readonly signals: {
    readonly sleep: (SleepSession & { flag: SleepFlag | null }) | null;
    readonly hrv: {
      readonly date: string;
      readonly milliseconds: number;
      readonly baseline: Baseline | null;
      /** Standard deviations from the baseline, on the log scale. */
      readonly z: number | null;
      readonly flag: HrvFlag | null;
    } | null;
    readonly restingHeartRate: {
      readonly date: string;
      readonly beatsPerMinute: number;
      readonly baseline: Baseline | null;
      readonly deltaBpm: number | null;
      readonly flag: RhrFlag | null;
    } | null;
  };
  readonly missing: MissingSignal[];
}

// --- Dates -------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Calendar arithmetic on ISO dates, done in UTC so no zone can shift it. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The owner's calendar date at `instant`. "Today" has to be the owner's today:
 * the Lambda's clock is UTC, and for a Japan-based owner a UTC date is
 * yesterday until 09:00 — exactly the hours this tool is asked in.
 */
export function localDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// --- Parsing Google Health API data points -----------------------------------
//
// The API speaks protobuf JSON: int64 fields arrive as strings, dates as
// {year, month, day}, and a false boolean is usually omitted rather than sent.
// Each parser takes one raw data point and returns null for anything it cannot
// read, so one malformed point is skipped instead of failing the whole answer.

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;

/** int64 (string) or double (number) → finite number. */
function asNumber(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** google.type.Date → ISO YYYY-MM-DD. */
export function civilDate(value: unknown): string | null {
  const d = asObject(value);
  const year = asNumber(d?.year);
  const month = asNumber(d?.month);
  const day = asNumber(d?.day);
  if (year === null || month === null || day === null) return null;
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/** A `daily-heart-rate-variability` data point → its average nightly rMSSD. */
export function parseDailyHrv(point: unknown): DailyValue | null {
  const data = asObject(asObject(point)?.dailyHeartRateVariability);
  const date = civilDate(data?.date);
  const value = asNumber(data?.averageHeartRateVariabilityMilliseconds);
  return date && value !== null && value > 0 ? { date, value } : null;
}

/** A `daily-resting-heart-rate` data point → its bpm. */
export function parseDailyRestingHeartRate(point: unknown): DailyValue | null {
  const data = asObject(asObject(point)?.dailyRestingHeartRate);
  const date = civilDate(data?.date);
  const value = asNumber(data?.beatsPerMinute);
  return date && value !== null && value > 0 ? { date, value } : null;
}

/** A `sleep` data point → the session, keyed on the local date it ended. */
export function parseSleep(point: unknown): SleepSession | null {
  const sleep = asObject(asObject(point)?.sleep);
  const interval = asObject(sleep?.interval);
  const endDate = civilDate(asObject(interval?.civilEndTime)?.date);
  const endTime = typeof interval?.endTime === 'string' ? interval.endTime : null;
  if (!endDate || !endTime) return null;
  const metadata = asObject(sleep?.metadata);
  return {
    endDate,
    endTime,
    minutesAsleep: asNumber(asObject(sleep?.summary)?.minutesAsleep),
    // Proto3 JSON drops false booleans, so absent means false throughout.
    mainSleep: metadata?.mainSleep === true,
    nap: metadata?.nap === true,
    processed: metadata?.processed === true,
  };
}

// --- Judgement ---------------------------------------------------------------

function baselineOf(values: readonly number[]): Baseline | null {
  if (values.length < MIN_BASELINE_DAYS) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return { mean, sd: Math.sqrt(variance), days: values.length };
}

/** Values strictly inside the baseline window: the BASELINE_DAYS before `date`. */
function baselineValues(values: readonly DailyValue[], date: string): number[] {
  const from = addDays(date, -BASELINE_DAYS);
  return values.filter((v) => v.date >= from && v.date < date).map((v) => v.value);
}

function latestDate(values: readonly { date: string }[]): string | null {
  return values.reduce<string | null>((latest, v) => (latest === null || v.date > latest ? v.date : latest), null);
}

/**
 * The night that ended on `date`. The API marks one `mainSleep` per day; when
 * none is marked (a classic-only night, say) the longest non-nap stands in.
 */
export function nightOf(sleeps: readonly SleepSession[], date: string): SleepSession | null {
  const candidates = sleeps.filter((s) => s.endDate === date && !s.nap);
  if (candidates.length === 0) return null;
  return (
    candidates.find((s) => s.mainSleep) ??
    [...candidates].sort((a, b) => (b.minutesAsleep ?? 0) - (a.minutesAsleep ?? 0))[0]
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const roundBaseline = (b: Baseline | null): Baseline | null =>
  b && { mean: round1(b.mean), sd: round1(b.sd), days: b.days };

export function hrvFlag(z: number): HrvFlag {
  if (z <= HRV_LOW_Z) return 'low';
  if (z <= HRV_SLIGHTLY_LOW_Z) return 'slightly_low';
  return 'normal';
}

export function rhrFlag(deltaBpm: number): RhrFlag {
  if (deltaBpm >= RHR_ELEVATED_BPM) return 'elevated';
  if (deltaBpm >= RHR_SLIGHTLY_ELEVATED_BPM) return 'slightly_elevated';
  return 'normal';
}

export function sleepFlag(minutesAsleep: number): SleepFlag {
  if (minutesAsleep < SLEEP_VERY_SHORT_MINUTES) return 'very_short';
  if (minutesAsleep < SLEEP_SHORT_MINUTES) return 'short';
  return 'normal';
}

const hours = (minutes: number) => `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;

export function judgeReadiness(input: ReadinessInput): ReadinessResult {
  const { date } = input;
  const missing: MissingSignal[] = [];
  const withheld = (status: ReadinessStatus, reasons: string[], signals: ReadinessResult['signals']): ReadinessResult =>
    ({ date, status, verdict: null, reasons, signals, missing });

  // Sleep first: it is the sync signal. With no night ending today, the watch
  // has not synced since waking, and today's HRV and RHR cannot exist either.
  const night = nightOf(input.sleeps, date);
  const sleep = night && {
    ...night,
    flag: night.minutesAsleep === null ? null : sleepFlag(night.minutesAsleep),
  };

  const todayHrv = input.hrv.find((v) => v.date === date) ?? null;
  const hrvHistory = baselineValues(input.hrv, date);
  const hrvBase = baselineOf(hrvHistory);
  const lnBase = baselineOf(hrvHistory.map(Math.log));
  let z: number | null = null;
  if (todayHrv && lnBase) {
    // A zero spread (identical baseline values) would divide by zero; treat
    // any move as within noise rather than infinitely significant. Compared
    // against a tolerance, not 0: the log of identical values still leaves a
    // spread of ~1e-16 from rounding, which would make any dip look enormous.
    z = lnBase.sd > 1e-9 ? (Math.log(todayHrv.value) - lnBase.mean) / lnBase.sd : 0;
  }
  const hrv = todayHrv && {
    date: todayHrv.date,
    milliseconds: round1(todayHrv.value),
    baseline: roundBaseline(hrvBase),
    z: z === null ? null : round2(z),
    flag: z === null ? null : hrvFlag(z),
  };

  const todayRhr = input.restingHeartRate.find((v) => v.date === date) ?? null;
  const rhrBase = baselineOf(baselineValues(input.restingHeartRate, date));
  const delta = todayRhr && rhrBase ? todayRhr.value - rhrBase.mean : null;
  const restingHeartRate = todayRhr && {
    date: todayRhr.date,
    beatsPerMinute: todayRhr.value,
    baseline: roundBaseline(rhrBase),
    deltaBpm: delta === null ? null : round1(delta),
    flag: delta === null ? null : rhrFlag(delta),
  };

  const signals = { sleep, hrv, restingHeartRate };

  if (!night) {
    missing.push({ signal: 'sleep', latestDate: latestDate(input.sleeps.map((s) => ({ date: s.endDate }))) });
  }
  if (!todayHrv) missing.push({ signal: 'hrv', latestDate: latestDate(input.hrv) });
  if (!todayRhr) missing.push({ signal: 'restingHeartRate', latestDate: latestDate(input.restingHeartRate) });

  if (!night) {
    return withheld('not_synced', [
      `No night ending on ${date} has synced yet. Open the Fitbit / Google Health app so the watch syncs, then ask again.`,
    ], signals);
  }
  if (!night.processed || night.minutesAsleep === null) {
    return withheld('pending', [
      `Last night (ended ${night.endTime}) has synced but is still being processed. Ask again in a few minutes.`,
    ], signals);
  }
  if (!todayHrv) {
    return withheld('pending', [
      `Last night has synced but ${date}'s HRV has not been published yet. Ask again in a few minutes.`,
    ], signals);
  }
  if (!hrvBase) {
    return withheld('insufficient_baseline', [
      `Only ${hrvHistory.length} day(s) of HRV history in the last ${BASELINE_DAYS}; at least ${MIN_BASELINE_DAYS} are needed to judge what is low for you.`,
    ], signals);
  }

  // Judgement. Severe flags each call for an easy day on their own; mild ones
  // do when two agree, since any single mild dip is within ordinary noise.
  const reasons: string[] = [];
  let severe = 0;
  let mild = 0;

  const hFlag = hrv!.flag!;
  if (hFlag === 'low') severe += 1;
  if (hFlag === 'slightly_low') mild += 1;
  reasons.push(
    `HRV ${hrv!.milliseconds} ms vs your ${BASELINE_DAYS}-day mean ${hrv!.baseline!.mean} ms (z ${hrv!.z}): ${hFlag.replace('_', ' ')}.`,
  );

  if (restingHeartRate?.flag) {
    if (restingHeartRate.flag === 'elevated') severe += 1;
    if (restingHeartRate.flag === 'slightly_elevated') mild += 1;
    const sign = restingHeartRate.deltaBpm! >= 0 ? '+' : '';
    reasons.push(
      `Resting HR ${restingHeartRate.beatsPerMinute} bpm, ${sign}${restingHeartRate.deltaBpm} vs your mean ${restingHeartRate.baseline!.mean}: ${restingHeartRate.flag.replace('_', ' ')}.`,
    );
  } else if (restingHeartRate) {
    reasons.push(`Resting HR ${restingHeartRate.beatsPerMinute} bpm, not judged: fewer than ${MIN_BASELINE_DAYS} days of history.`);
  } else {
    reasons.push(`Resting HR for ${date} not available yet; judged on sleep and HRV alone.`);
  }

  const sFlag = sleep!.flag!;
  if (sFlag === 'very_short') severe += 1;
  if (sFlag === 'short') mild += 1;
  reasons.push(`Slept ${hours(night.minutesAsleep)}: ${sFlag.replace('_', ' ')}.`);

  let verdict: Verdict;
  if (severe > 0 || mild >= 2) {
    verdict = 'easy';
  } else if (mild === 0 && z! >= 0 && night.minutesAsleep >= SLEEP_FULL_MINUTES) {
    verdict = 'push';
  } else {
    verdict = 'normal';
  }

  return { date, status: 'ready', verdict, reasons, signals, missing };
}
