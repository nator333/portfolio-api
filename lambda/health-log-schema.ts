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
 *   measured   written by the scheduled job (health-log-ingest.ts): a
 *              placeholder at 00:05 that opens the day, then at 22:00 last
 *              night's sleep, HRV and resting heart rate from Google Health,
 *              judged by the same arithmetic as get_readiness.
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
  /** A readiness status, or "awaiting" until the 22:00 run has measured the day. */
  status: ReadinessStatus | typeof AWAITING;
  verdict: Verdict | null;
  /** Why the verdict is what it is; only when `status` is "ready". */
  reasons: string[];
  /** Signals with no value for the day. */
  missing: string[];
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
  measuredAt: string;
  createdAt: string;
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

/** Reduce one day's readiness judgement to what the log keeps. */
export function measureDay(input: ReadinessInput): MeasuredDay {
  const result = judgeReadiness(input);
  const { sleep, hrv, restingHeartRate } = result.signals;
  const measured: MeasuredDay = {
    status: result.status,
    verdict: result.verdict,
    // The other statuses' reasons are prompts to "sync and ask again", which
    // mean nothing in a log read days later; `missing` says what was absent.
    reasons: result.status === 'ready' ? [...result.reasons] : [],
    missing: result.missing.map((m) => m.signal),
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
    missing: ['sleep', 'hrv', 'restingHeartRate'],
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
): { date: string; measured: MeasuredDay }[] {
  return dates.map((date) => ({ date, measured: measureDay({ date, ...signals }) }));
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
