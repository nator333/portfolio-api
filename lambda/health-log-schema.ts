import { z } from 'zod';
import { REFLECTION_THEMES_MAX, isoDate, themeTags } from './reflection-schema';
import {
  addDays,
  judgeReadiness,
  type DailyValue,
  type ReadinessInput,
  type ReadinessStatus,
  type SleepSession,
  type Verdict,
} from './readiness';

/**
 * The health log: one private record per day of the owner's calendar.
 *
 * Each record has two halves with two different writers, and neither may
 * touch the other's:
 *
 *   measured   last night's sleep, HRV and resting heart rate from Google
 *              Health, judged by the same arithmetic as get_readiness. Always
 *              read from Google by the server, never supplied by Claude: a
 *              placeholder at 00:05, a reading on the day's first
 *              update_health_log or at 10:00, whichever comes first, and a
 *              refresh at 22:00 (see health-log-ingest.ts and
 *              health-log-measure.ts).
 *   notes      written by Claude through update_health_log, from what the
 *              owner says in conversation: how the day felt, soreness,
 *              illness, stress, and so on.
 *
 * Only the job creates records. update_health_log can change the notes of a
 * record that already exists and nothing else, so Claude can neither invent a
 * day nor alter a number that came from the watch. The job writes a record for
 * every day in its window, including days with no watch data (status
 * "not_synced"), so a day the watch was off can still be annotated.
 *
 * The 00:05 run exists because the owner mostly talks about a day during it,
 * long before 22:00. It opens today with an "awaiting" placeholder and reads
 * nothing from Google, so it still runs when the Google grant has lapsed.
 *
 * Why scheduled when get_readiness deliberately is not: get_readiness answers
 * "how should I train this morning?", before the watch's sync time is known.
 * The log records a day after the fact, at 22:00 local, when that morning's
 * data has long since synced. Each run rewrites the whole LOG_DAYS window, so
 * the first run is the backfill, and a late sync or a failed run is picked up
 * the next night.
 *
 * ## Storage shape
 *
 * `pk` HASH (always "DAY"), `date` RANGE. One partition is plenty for one
 * person's days, and "the days between X and Y" is then a single Query.
 */

export const HEALTH_LOG_PK = 'DAY';

/** Days each run covers, ending today: the first run is a 28-day backfill. */
export const LOG_DAYS = 28;

/** Status of a day opened at 00:05 and not yet measured. */
export const AWAITING = 'awaiting';

/**
 * Google answered, and had nothing for the night: the watch was off, flat, or
 * never synced. Used once the day is over (the 22:00 run, or any read of a past
 * day); earlier on the day itself the same answer is "not_synced", since the
 * morning sync may simply not have happened yet. Never settled, so a late sync
 * within the 28-day window still fills it in.
 *
 * Distinct from a failed read, which never changes `measured` and is recorded
 * as `fetchError` instead.
 */
export const NO_DATA = 'no_data';

export type MeasuredStatus = ReadinessStatus | typeof AWAITING | typeof NO_DATA;

/**
 * Why the last attempt to read Google for a day failed.
 *
 *   auth     the stored grant was refused: re-run scripts/google-health-auth.ts
 *   api      Google Health returned an error status
 *   network  the request did not complete (timeout, connection)
 *   parse    Google returned data this code could not read: a bug here, not
 *            an empty day
 *   unknown  anything else
 */
export type FetchErrorKind = 'auth' | 'api' | 'network' | 'parse' | 'unknown';

export interface FetchError {
  at: string;
  kind: FetchErrorKind;
  message: string;
  /** Which writer hit it. */
  by: 'update' | 'morning' | 'nightly';
}

export const HEALTH_NOTES_MAX = 4000;
/** Tags share the reflections' vocabulary and limit. */
export const HEALTH_TAGS_MAX = REFLECTION_THEMES_MAX;
export const HEALTH_LIST_DEFAULT_DAYS = 14;
export const HEALTH_LIST_MAX_DAYS = 92;

/**
 * The 1–5 ratings Claude may record, each in its plain sense: energy and mood
 * 5 is high, stress and soreness 5 is severe.
 */
export const HEALTH_RATINGS = ['energy', 'mood', 'stress', 'soreness'] as const;
export type HealthRating = (typeof HEALTH_RATINGS)[number];

/** The attributes update_health_log may write. Everything else is the job's. */
export const HEALTH_NOTE_FIELDS = ['notes', 'tags', ...HEALTH_RATINGS] as const;
export type HealthNoteField = (typeof HEALTH_NOTE_FIELDS)[number];

/** The measured half of a day, as the job stores it. */
export interface MeasuredDay {
  /**
   * "awaiting" until Google is first read for the day; then a readiness status,
   * or "no_data" when Google had nothing for a day that is over.
   */
  status: MeasuredStatus;
  verdict: Verdict | null;
  /** Why the verdict is what it is; only when `status` is "ready". */
  reasons: string[];
  /**
   * Signals Google had no value for, each with the newest date it does have:
   * a run of days missing since the same date is a watch left off or flat.
   */
  missing: { signal: 'sleep' | 'hrv' | 'restingHeartRate'; latestDate: string | null }[];
  sleep: { minutesAsleep: number | null; endTime: string; processed: boolean } | null;
  hrv: { milliseconds: number; baselineMean: number | null; z: number | null; flag: string | null } | null;
  restingHeartRate: {
    beatsPerMinute: number;
    baselineMean: number | null;
    deltaBpm: number | null;
    flag: string | null;
  } | null;
  /**
   * True once every signal is in and judged. A settled day is never rewritten:
   * the log keeps what was measured, not whatever a later recalculation says.
   */
  settled: boolean;
}

export interface HealthLogItem {
  pk: typeof HEALTH_LOG_PK;
  date: string;
  measured: MeasuredDay;
  /** When Google was last read successfully for this day. */
  measuredAt?: string;
  createdAt: string;
  /**
   * The last read of Google for this day failed. `measured` is left as it was;
   * cleared by the next successful read. If `fetchError.at` is later than
   * `measuredAt`, the newest attempt is the one that failed.
   */
  fetchError?: FetchError;
  notes?: string;
  tags?: string[];
  energy?: number;
  mood?: number;
  stress?: number;
  soreness?: number;
  notesUpdatedAt?: string;
}

/** The dates a run covers, oldest first, ending on `today`. */
export function logDates(today: string, days = LOG_DAYS): string[] {
  return Array.from({ length: days }, (_, i) => addDays(today, i - days + 1));
}

/**
 * Reduce one day's readiness judgement to what the log keeps. `dayIsOver`
 * turns an empty night into "no_data" rather than "not_synced".
 */
export function measureDay(input: ReadinessInput, opts: { dayIsOver: boolean }): MeasuredDay {
  // Only what existed up to the day. The judgement never looks later anyway,
  // but `missing[].latestDate` would: a window read at 22:00 holds later
  // nights, and "latest sleep: today" on a day ten days back says nothing.
  const { date } = input;
  const result = judgeReadiness({
    date,
    sleeps: input.sleeps.filter((s) => s.endDate <= date),
    hrv: input.hrv.filter((v) => v.date <= date),
    restingHeartRate: input.restingHeartRate.filter((v) => v.date <= date),
  });
  const { sleep, hrv, restingHeartRate } = result.signals;
  const measured: MeasuredDay = {
    status: result.status === 'not_synced' && opts.dayIsOver ? NO_DATA : result.status,
    verdict: result.verdict,
    // The other statuses' reasons are prompts to "sync and ask again", which
    // mean nothing in a log read days later; `missing` says what was absent.
    reasons: result.status === 'ready' ? [...result.reasons] : [],
    missing: result.missing.map((m) => ({ signal: m.signal, latestDate: m.latestDate })),
    sleep: sleep && { minutesAsleep: sleep.minutesAsleep, endTime: sleep.endTime, processed: sleep.processed },
    hrv: hrv && {
      milliseconds: hrv.milliseconds,
      baselineMean: hrv.baseline?.mean ?? null,
      z: hrv.z,
      flag: hrv.flag,
    },
    restingHeartRate: restingHeartRate && {
      beatsPerMinute: restingHeartRate.beatsPerMinute,
      baselineMean: restingHeartRate.baseline?.mean ?? null,
      deltaBpm: restingHeartRate.deltaBpm,
      flag: restingHeartRate.flag,
    },
    settled: false,
  };
  measured.settled = measured.status === 'ready' && measured.restingHeartRate?.flag != null;
  return measured;
}

/** What the 00:05 run writes: an open day with nothing measured yet. */
export function awaitingDay(): MeasuredDay {
  return {
    status: AWAITING,
    verdict: null,
    reasons: [],
    // Nothing has been asked yet, so nothing is known to be missing.
    missing: [],
    sleep: null,
    hrv: null,
    restingHeartRate: null,
    settled: false,
  };
}

/** Every day in the window, measured from one set of reads. */
export function measureDays(
  dates: readonly string[],
  signals: { sleeps: readonly SleepSession[]; hrv: readonly DailyValue[]; restingHeartRate: readonly DailyValue[] },
  opts: { dayIsOver: boolean },
): { date: string; measured: MeasuredDay }[] {
  return dates.map((date) => ({ date, measured: measureDay({ date, ...signals }, opts) }));
}

// --- What Claude may send ------------------------------------------------------

const rating = z.number().int().min(1).max(5).nullable();

export const updateHealthLogSchema = z
  .object({
    date: isoDate,
    /** Replaces the day's notes; null clears them. */
    notes: z.string().trim().min(1).max(HEALTH_NOTES_MAX).nullable().optional(),
    tags: themeTags.nullable().optional(),
    energy: rating.optional(),
    mood: rating.optional(),
    stress: rating.optional(),
    soreness: rating.optional(),
  })
  .strict()
  .refine((value) => HEALTH_NOTE_FIELDS.some((field) => value[field] !== undefined), {
    message: `Provide at least one of: ${HEALTH_NOTE_FIELDS.join(', ')}`,
  });

export type UpdateHealthLog = z.infer<typeof updateHealthLogSchema>;

export const listHealthLogSchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: '`from` must not be after `to`',
  })
  .refine((value) => !value.from || !value.to || addDays(value.from, HEALTH_LIST_MAX_DAYS - 1) >= value.to, {
    message: `At most ${HEALTH_LIST_MAX_DAYS} days per read`,
  });

/** A record as a client sees it: the storage key dropped. */
export function toHealthLogEntry(item: HealthLogItem) {
  const { pk: _pk, ...rest } = item;
  return rest;
}
