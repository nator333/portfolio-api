import { plannedWeeklySets, type PlanVersion, type WeeklySetTarget } from './workout-plan-schema';
import type { MuscleGroup } from './workout-muscles';

/**
 * Checks a menu against the targets it is supposed to serve.
 *
 * The dependency between the two halves of a program runs one way: the sessions
 * exist to deliver the weekly volume the targets ask for, so a menu must respect
 * the targets and never the reverse. Nothing enforced that while both lived in
 * one document, and they drifted apart silently — shoulders, biceps and triceps
 * were declared at 9-11, 5-6 and 6-8 against a rotation prescribing 11-14, 6-7
 * and 6-9, so running the program exactly as written reported as *over* target
 * on every muscle it had gone astray on.
 *
 * The check is deliberately one-directional. A target above what the sessions
 * directly prescribe is not a violation — it is the entire reason a target is
 * stated separately, since it folds in indirect work the slot list cannot
 * express (the glutes/hamstrings target sits above the 6 sets the rotation
 * assigns them). Only the opposite, a menu prescribing more than the intent
 * allows, is a contradiction.
 */

export interface ComplianceBreach {
  readonly muscles: readonly MuscleGroup[];
  /** Sets the menu prescribes at its upper bound. */
  readonly prescribed: number;
  /** The ceiling the target allows. */
  readonly allowed: number;
}

export interface ComplianceResult {
  /** Breaches on the ordinary rotation. These are refused outright. */
  readonly breaches: readonly ComplianceBreach[];
  /**
   * Breaches that appear only once the bonus session is added.
   *
   * Reported rather than refused. A bonus week is occasional and opt-in, and a
   * program may legitimately accept overshooting on it; refusing would also mean
   * a pre-existing bonus-week overshoot blocks every unrelated menu edit until
   * someone reopens a training decision. Visible, not fatal.
   */
  readonly bonusWarnings: readonly ComplianceBreach[];
}

/** Human-readable one-liner for a breach, used in the write paths' errors. */
export const describeBreach = (breach: ComplianceBreach): string =>
  `${breach.muscles.join(' + ')} is prescribed ${breach.prescribed} sets a week but its target allows at most ${breach.allowed}`;

const breachesFor = (
  prescribed: Partial<Record<MuscleGroup, { min: number; max: number }>>,
  targets: readonly WeeklySetTarget[],
  useBonusRange: boolean,
): ComplianceBreach[] => {
  const breaches: ComplianceBreach[] = [];
  for (const target of targets) {
    // A target spanning several muscles is judged on their combined prescription,
    // the same total the status rollup judges the logged sets on.
    const total = target.muscles.reduce((sum, m) => sum + (prescribed[m]?.max ?? 0), 0);
    if (total === 0) continue; // No slot prescribes it; nothing to contradict.

    const range = useBonusRange && target.bonusWeekSets ? target.bonusWeekSets : target.sets;
    if (total > range.max) {
      breaches.push({ muscles: target.muscles, prescribed: total, allowed: range.max });
    }
  }
  return breaches;
};

export function checkMenuAgainstTargets(
  menu: Pick<PlanVersion, 'sessions' | 'rotation' | 'bonusSessions'>,
  targets: readonly WeeklySetTarget[],
): ComplianceResult {
  const rotation = plannedWeeklySets(menu);
  const withBonus = plannedWeeklySets(menu, { includeBonus: true });

  const breaches = breachesFor(rotation, targets, false);
  // Only count a bonus-week breach that the rotation alone did not already have,
  // so one problem is not reported twice under two headings.
  const alreadyBreached = new Set(breaches.map((b) => b.muscles.join('+')));
  const bonusWarnings = breachesFor(withBonus, targets, true).filter(
    (b) => !alreadyBreached.has(b.muscles.join('+')),
  );

  return { breaches, bonusWarnings };
}
