import type { MuscleGroup } from './workout-muscles';
import type { WeeklySetTarget } from './workout-plan-schema';
import type { WeekSummary } from './workout-schema';
import {
  DEFAULT_WINDOW_DAYS,
  muscleVolumeStatus,
  rollUpSets,
  windowBounds,
  type DayTally,
  type MuscleVolumeRow,
  type VolumeStatus,
} from './muscle-volume-status';

/**
 * The import report's view of the weekly set targets.
 *
 * The report used to judge every muscle against a hard-coded "~10-20 sets"
 * guide — the same kind of private copy of the targets that muscle-volume-status
 * was written to retire. It called chest "below guide" at the 8-9 sets the plan
 * actually asks for. The verdicts here come from that module and the plan's
 * current target set, so the email, the progress page and the MCP server agree.
 *
 * Kept free of AWS SDK imports, like the module it builds on, so it can be tested
 * without mocking the ingest Lambda's clients.
 */

/** What the report needs from the plan table; null when no targets are published. */
export interface ReportTargets {
  readonly targets: readonly WeeklySetTarget[];
  readonly sessionsPerWeek: number;
}

const STATUS_LABEL: Record<VolumeStatus, string> = {
  under: 'UNDER',
  maintenance: 'maintenance',
  in_range: 'in range',
  over: 'over',
};

const rangeText = (min: number, max: number): string =>
  min === max ? `${min}` : `${min}-${max}`;

const oneDecimal = (n: number): string => n.toFixed(1);

/**
 * One line per target, not per muscle: a shared target (glutes + hamstrings) is
 * judged on the combined count, so printing it twice would repeat one verdict
 * under two names.
 */
function targetRows(rows: readonly MuscleVolumeRow[]): MuscleVolumeRow[] {
  const seen = new Set<MuscleGroup>();
  const out: MuscleVolumeRow[] = [];
  for (const row of rows) {
    if (seen.has(row.muscle)) continue;
    seen.add(row.muscle);
    for (const m of row.sharedWith) seen.add(m);
    out.push(row);
  }
  return out;
}

const rowName = (row: MuscleVolumeRow): string =>
  [row.muscle, ...row.sharedWith].join(' + ');

function targetLine(row: MuscleVolumeRow, sets: string): string {
  const maintenance =
    row.status === 'under' && row.maintenance !== null
      ? `, maintenance ${row.maintenance}`
      : '';
  return `${rowName(row)}: ${sets} (target ${rangeText(row.target.min, row.target.max)}${maintenance}) — ${STATUS_LABEL[row.status]}`;
}

export interface TargetReport {
  readonly lines: string[];
  /** Targets currently short, for the subject line. */
  readonly underCount: number;
}

/**
 * The trailing seven days against the weekly targets, plus the recent weekly
 * average against the same ranges.
 *
 * The seven-day window ends on the day of the import, the same window the
 * progress page reads, so the email and the page never disagree about "this
 * week". The average is judged against the ordinary (non-bonus) range: bonus
 * weeks are the exception, and averaging them in is what the average is for.
 */
export function targetReportLines(
  plan: ReportTargets,
  days: readonly DayTally[],
  recentWeeks: readonly WeekSummary[],
  asOf: Date,
): TargetReport {
  const bounds = windowBounds(asOf, DEFAULT_WINDOW_DAYS);
  const inWindow = days.filter((d) => d.date >= bounds.from && d.date <= bounds.to);
  const week = muscleVolumeStatus(plan.targets, rollUpSets(inWindow), {
    days: bounds.days,
    sessions: inWindow.length,
    sessionsPerWeek: plan.sessionsPerWeek,
  });

  const weekRows = targetRows(week.muscles);
  const underCount = weekRows.filter((r) => r.status === 'under').length;

  const lines: string[] = [
    '',
    `— Last 7 days vs weekly targets (${bounds.from} → ${bounds.to}, ${inWindow.length} session${
      inWindow.length === 1 ? '' : 's'
    }${week.bonusWindow ? ', bonus week' : ''}) —`,
    ...weekRows.map((r) => targetLine(r, `${r.countedSets} set${r.countedSets === 1 ? '' : 's'}`)),
  ];
  if (week.untargeted.length) {
    lines.push(`No target: ${week.untargeted.map((u) => `${u.muscle} ${u.sets}`).join(', ')}`);
  }

  if (recentWeeks.length) {
    // Summed then divided, so the shared-target arithmetic in muscleVolumeStatus
    // sees per-week averages exactly as it would see one week's counts. Sessions
    // are passed as zero so the ordinary range, not the bonus one, is in force.
    const totals = rollUpSets(recentWeeks.map((w) => ({ date: w.sk, muscles: w.muscles })));
    const averages = new Map<MuscleGroup, number>();
    for (const [muscle, total] of totals) averages.set(muscle, total / recentWeeks.length);
    const avg = muscleVolumeStatus(plan.targets, averages, {
      days: DEFAULT_WINDOW_DAYS,
      sessions: 0,
      sessionsPerWeek: plan.sessionsPerWeek,
    });

    lines.push('', `— Sets per week, averaged over the last ${recentWeeks.length} weeks, vs targets —`);
    for (const r of targetRows(avg.muscles)) lines.push(targetLine(r, oneDecimal(r.countedSets)));
    for (const u of [...avg.untargeted].sort((a, b) => b.sets - a.sets)) {
      lines.push(`${u.muscle}: ${oneDecimal(u.sets)} (no target)`);
    }
  }

  return { lines, underCount };
}
