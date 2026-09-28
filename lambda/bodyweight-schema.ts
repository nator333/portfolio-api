import { firstOfDay, type Reading } from './weight-trend';
import { LB_PER_KG } from './workout-schema';

/**
 * The owner's bodyweight as the public Training page shows it: one average per
 * calendar month, nothing finer.
 *
 * That granularity is the owner's decision about what to publish, and this
 * module is where it is enforced, before anything is stored. Only the monthly
 * averages are ever written; the individual weigh-ins the ingest reads from
 * Google Health are discarded once averaged, as is body fat, which is not
 * published at all.
 *
 * A month with only a handful of weigh-ins would not really be an average (a
 * single-day "average" is just that day's weight), so a month is published
 * only once it has MIN_DAYS_PER_MONTH distinct weigh-in days. The current
 * month is included as soon as it clears that bar, flagged `complete: false`.
 *
 * Free of AWS SDK imports, like the other schema modules.
 */

/** The cv-table item the ingest writes and GET /bodyweight reads. */
export const BODYWEIGHT_ITEM_ID = 'bodyweight-monthly';

/** Fewest weigh-in days for a month to be published. */
export const MIN_DAYS_PER_MONTH = 7;

/** Months re-read from Google Health on every run; older stored months are kept. */
export const INGEST_MONTHS = 24;

export interface MonthlyBodyweight {
  /** "YYYY-MM". */
  readonly month: string;
  readonly kg: number;
  readonly lb: number;
  /** False for the month still in progress. */
  readonly complete: boolean;
}

/** The stored snapshot. */
export interface BodyweightSnapshot {
  readonly months: MonthlyBodyweight[];
  /** ISO instant of the last successful ingest. */
  readonly updatedAt: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Monthly averages of daily weigh-ins, oldest month first. Each day counts
 * once, by its earliest (morning) reading, the same rule the private weight
 * trend uses, so the public number is the average of the same daily values.
 */
export function monthlyAverages(readings: readonly Reading[], today: string): MonthlyBodyweight[] {
  const byMonth = new Map<string, number[]>();
  for (const day of firstOfDay(readings)) {
    if (day.date > today) continue;
    const month = day.date.slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), day.value]);
  }
  const currentMonth = today.slice(0, 7);
  return [...byMonth]
    .filter(([, values]) => values.length >= MIN_DAYS_PER_MONTH)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, values]) => {
      const kg = values.reduce((sum, v) => sum + v, 0) / values.length;
      return { month, kg: round1(kg), lb: round1(kg * LB_PER_KG), complete: month < currentMonth };
    });
}

/**
 * The stored months with the freshly computed ones laid over them. Months from
 * `fromMonth` on are replaced wholesale by `fresh`, including dropping one that
 * no longer clears the threshold (a deleted weigh-in, say). Older months,
 * beyond what the ingest re-reads, are kept as they were, so the history grows
 * past INGEST_MONTHS rather than being truncated to it.
 */
export function mergeMonths(
  stored: readonly MonthlyBodyweight[],
  fresh: readonly MonthlyBodyweight[],
  fromMonth: string,
): MonthlyBodyweight[] {
  return [...stored.filter((m) => m.month < fromMonth), ...fresh.filter((m) => m.month >= fromMonth)].sort((a, b) =>
    a.month.localeCompare(b.month),
  );
}

/** The first day of the month `months - 1` months before `today`'s month. */
export function windowStart(today: string, months: number): string {
  const [y, m] = today.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1 - (months - 1), 1));
  return start.toISOString().slice(0, 10);
}
