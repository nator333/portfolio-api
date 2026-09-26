import { targetReportLines } from '../lambda/workout-target-report';
import type { WeeklySetTarget } from '../lambda/workout-plan-schema';
import type { WeekSummary } from '../lambda/workout-schema';

const TARGETS: WeeklySetTarget[] = [
  { muscles: ['Chest'], sets: { min: 8, max: 9 }, bonusWeekSets: null },
  { muscles: ['Glutes', 'Hamstrings'], sets: { min: 9, max: 11 }, bonusWeekSets: null },
  { muscles: ['Quads'], sets: { min: 8, max: 10 }, bonusWeekSets: { min: 13, max: 18 }, maintenanceSets: 4 },
];
const PLAN = { targets: TARGETS, sessionsPerWeek: 3 };
const AS_OF = new Date('2026-09-26T12:00:00Z');

const week = (sk: string, muscles: Record<string, number>): WeekSummary => ({
  sk,
  sets: Object.values(muscles).reduce((a, b) => a + b, 0),
  sessions: 3,
  muscles,
});

describe('targetReportLines', () => {
  it('judges the trailing 7 days, ending on the import date, against the plan targets', () => {
    const { lines, underCount } = targetReportLines(
      PLAN,
      [
        // Outside the window: must not count.
        { date: '2026-09-19', muscles: { Chest: 20 } },
        { date: '2026-09-20', muscles: { Chest: 4, Glutes: 5, Quads: 5 } },
        { date: '2026-09-24', muscles: { Chest: 5, Hamstrings: 5, Abs: 3 } },
      ],
      [],
      AS_OF,
    );

    expect(lines).toContain(
      '— Last 7 days vs weekly targets (2026-09-20 → 2026-09-26, 2 sessions) —',
    );
    expect(lines).toContain('Chest: 9 sets (target 8-9) — in range');
    // A shared target is one line judged on the combined count.
    expect(lines).toContain('Hamstrings + Glutes: 10 sets (target 9-11) — in range');
    expect(lines.filter((l) => l.startsWith('Glutes'))).toHaveLength(0);
    // Below range but above the maintenance floor.
    expect(lines).toContain('Quads: 5 sets (target 8-10) — maintenance');
    expect(lines).toContain('No target: Abs 3');
    expect(underCount).toBe(0);
  });

  it('counts targets short of their range and names the maintenance floor', () => {
    const { lines, underCount } = targetReportLines(
      PLAN,
      [{ date: '2026-09-25', muscles: { Chest: 2, Quads: 1 } }],
      [],
      AS_OF,
    );
    expect(lines).toContain('Chest: 2 sets (target 8-9) — UNDER');
    expect(lines).toContain('Quads: 1 set (target 8-10, maintenance 4) — UNDER');
    expect(lines).toContain('Hamstrings + Glutes: 0 sets (target 9-11) — UNDER');
    expect(underCount).toBe(3);
  });

  it('uses the bonus-week range when the window holds more sessions than the rotation', () => {
    const { lines } = targetReportLines(
      PLAN,
      ['2026-09-20', '2026-09-22', '2026-09-24', '2026-09-26'].map((date) => ({
        date,
        muscles: { Quads: 4 },
      })),
      [],
      AS_OF,
    );
    expect(lines[1]).toContain('4 sessions, bonus week');
    expect(lines).toContain('Quads: 16 sets (target 13-18) — in range');
  });

  it('averages recent weeks against the ordinary weekly range', () => {
    const { lines } = targetReportLines(
      PLAN,
      [],
      [
        week('2026-W37', { Chest: 10, Quads: 14, Abs: 4 }),
        week('2026-W38', { Chest: 5, Quads: 14, Abs: 2 }),
      ],
      AS_OF,
    );
    expect(lines).toContain('— Sets per week, averaged over the last 2 weeks, vs targets —');
    expect(lines).toContain('Chest: 7.5 (target 8-9) — UNDER');
    // 14/week would be in range on a bonus week, but the average is held to the ordinary range.
    expect(lines).toContain('Quads: 14.0 (target 8-10) — over');
    expect(lines).toContain('Abs: 3.0 (no target)');
  });
});
