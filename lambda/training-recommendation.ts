import type { MuscleGroup } from './workout-muscles';
import type { MuscleVolumeRow, VolumeStatus } from './muscle-volume-status';
import type { PlanExercise, PlanSession, Range } from './workout-plan-schema';
import type { ReadinessStatus, Verdict } from './readiness';

/**
 * "What should I train today, and how hard?" — the two halves the MCP server
 * already answers separately, joined.
 *
 * `get_muscle_volume_status` knows *what* is behind: which muscles are under
 * their weekly target. `get_readiness` knows *how hard* today can be: last
 * night's recovery. Neither alone tells a lifter what to do when chest is
 * under target but last night was four hours of sleep, and an agent asked
 * that question re-derived the join per conversation. This module is the join,
 * so there is one answer to drift from, not several.
 *
 * Two decisions, kept apart on purpose:
 *
 *   which session   chosen from the volume status alone — the plan's sessions
 *                   ranked by how much of what they train is behind
 *   how hard        from readiness alone — each slot of that session adjusted
 *                   by the verdict and by its own muscle's status
 *
 * They are separate because they fail separately. Before the watch has synced,
 * the session is still knowable and useful; the intensity is not, and is
 * withheld rather than guessed — the same rule get_readiness follows.
 *
 * Readiness only ever takes volume *away* from the plan. A "push" day runs a
 * slot at the top of its prescribed range, never beyond it: the menu is
 * checked against the weekly targets when it is published (see
 * workout-plan-compliance.ts), and an adjustment that added sets on good days
 * would quietly break that guarantee.
 *
 * Free of AWS SDK imports, like the modules it joins.
 */

/** How much each muscle status argues for training a session that hits it. */
export const STATUS_WEIGHT: Readonly<Record<VolumeStatus, number>> = {
  under: 2,
  maintenance: 1,
  in_range: 0,
  over: -1,
};

/**
 * Share of a slot's minimum sets kept on an easy day: roughly the one-third
 * cut a deload makes, which holds the muscle while shedding most of the
 * fatigue.
 */
export const EASY_SET_FRACTION = 2 / 3;

/** RPE points taken off the prescription on an easy day. */
export const EASY_RPE_DROP = 1;

/**
 * - `top`: push day — the top of the prescribed set range, prescribed RPE.
 * - `as_planned`: the prescription unchanged.
 * - `reduced`: fewer sets and/or a lower RPE ceiling than prescribed.
 * - `skip`: leave the slot out today.
 */
export type SlotAction = 'top' | 'as_planned' | 'reduced' | 'skip';

export interface SessionScore {
  readonly id: string;
  readonly name: string;
  readonly score: number;
  /** The muscles that earned the score, with their status, strongest first. */
  readonly behind: readonly { muscle: MuscleGroup; status: VolumeStatus }[];
  readonly bonus: boolean;
}

export interface SlotPrescription {
  readonly order: number;
  readonly options: readonly string[];
  readonly muscle: MuscleGroup;
  /** This muscle's current volume status; null where the plan sets no target. */
  readonly volumeStatus: VolumeStatus | null;
  readonly action: SlotAction;
  /** Sets for today; `planned` is what the menu says, for comparison. */
  readonly sets: Range | null;
  readonly rpe: Range | null;
  readonly reps: Range;
  readonly planned: { readonly sets: Range; readonly rpe: Range | null };
}

export interface ReadinessSummary {
  /** `unavailable` when the readiness read itself failed (e.g. not connected). */
  readonly status: ReadinessStatus | 'unavailable';
  /** The local day readiness judged; null when it could not be read. */
  readonly date: string | null;
  readonly verdict: Verdict | null;
  readonly reasons: readonly string[];
}

export interface TrainingRecommendation {
  readonly readiness: ReadinessSummary;
  /** The session to run; null only when the plan has no sessions at all. */
  readonly session: SessionScore | null;
  /** Every other session, best first — the fallbacks if the gym is busy. */
  readonly alternatives: readonly SessionScore[];
  /**
   * Today's version of the chosen session, slot by slot. Null while readiness
   * has no verdict: the session is known, how hard to run it is not.
   */
  readonly prescription: readonly SlotPrescription[] | null;
  /**
   * True on an easy day when no session trains anything that is behind:
   * nothing to gain today that is worth the recovery it costs.
   */
  readonly restSuggested: boolean;
  readonly notes: readonly string[];
}

export interface RecommendationInput {
  readonly readiness: ReadinessSummary;
  readonly volume: readonly Pick<MuscleVolumeRow, 'muscle' | 'status'>[];
  readonly rotation: readonly string[];
  readonly bonusSessions: readonly string[];
  readonly sessions: readonly PlanSession[];
}

/**
 * Ranks every session the plan names by how much of what it trains is behind.
 * Each muscle counts once per session however many slots hit it: two chest
 * slots do not make a session twice as much "the chest day" for this purpose.
 * Ties go to rotation order, then bonus sessions, so the plan's own sequence
 * breaks them rather than array position.
 */
export function rankSessions(
  sessions: readonly PlanSession[],
  statusOf: ReadonlyMap<MuscleGroup, VolumeStatus>,
  rotation: readonly string[],
  bonusSessions: readonly string[],
): SessionScore[] {
  const order = [...rotation, ...bonusSessions.filter((id) => !rotation.includes(id))];
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? order.length : i;
  };

  return sessions
    .map((session) => {
      const muscles = [...new Set(session.exercises.map((e) => e.muscle))];
      const judged = muscles
        .map((muscle) => ({ muscle, status: statusOf.get(muscle) }))
        .filter((m): m is { muscle: MuscleGroup; status: VolumeStatus } => m.status !== undefined);
      const score = judged.reduce((total, m) => total + STATUS_WEIGHT[m.status], 0);
      const behind = judged
        .filter((m) => STATUS_WEIGHT[m.status] > 0)
        .sort((a, b) => STATUS_WEIGHT[b.status] - STATUS_WEIGHT[a.status]);
      return {
        id: session.id,
        name: session.name,
        score,
        behind,
        bonus: bonusSessions.includes(session.id) && !rotation.includes(session.id),
      };
    })
    .sort((a, b) => b.score - a.score || rank(a.id) - rank(b.id));
}

/** One slot, adjusted for the day's verdict and its own muscle's status. */
export function prescribeSlot(
  slot: PlanExercise,
  verdict: Verdict,
  volumeStatus: VolumeStatus | null,
): SlotPrescription {
  const base = {
    order: slot.order,
    options: slot.options,
    muscle: slot.muscle,
    volumeStatus,
    reps: slot.reps,
    planned: { sets: slot.sets, rpe: slot.rpe },
  };
  const exact = (n: number): Range => ({ min: n, max: n });

  // A muscle already over its weekly target gains nothing from more today. On
  // an easy day it is the first thing to drop; otherwise it is held to the
  // bottom of its range.
  if (volumeStatus === 'over') {
    if (verdict === 'easy') return { ...base, action: 'skip', sets: null, rpe: null };
    const sets = exact(slot.sets.min);
    const unchanged = slot.sets.min === slot.sets.max;
    return { ...base, action: unchanged ? 'as_planned' : 'reduced', sets, rpe: slot.rpe };
  }

  switch (verdict) {
    case 'push':
      return {
        ...base,
        action: slot.sets.min === slot.sets.max ? 'as_planned' : 'top',
        sets: exact(slot.sets.max),
        rpe: slot.rpe,
      };
    case 'normal':
      return { ...base, action: 'as_planned', sets: slot.sets, rpe: slot.rpe };
    case 'easy': {
      const sets = exact(Math.max(1, Math.round(slot.sets.min * EASY_SET_FRACTION)));
      const rpe = slot.rpe && {
        min: Math.max(1, slot.rpe.min - EASY_RPE_DROP),
        max: Math.max(1, slot.rpe.max - EASY_RPE_DROP),
      };
      return { ...base, action: 'reduced', sets, rpe };
    }
  }
}

export function recommendTraining(input: RecommendationInput): TrainingRecommendation {
  const statusOf = new Map(input.volume.map((row) => [row.muscle, row.status] as const));
  const ranked = rankSessions(input.sessions, statusOf, input.rotation, input.bonusSessions);
  const [best, ...alternatives] = ranked;
  const notes: string[] = [];

  if (!best) {
    return { readiness: input.readiness, session: null, alternatives: [], prescription: null, restSuggested: false, notes: ['The plan has no sessions.'] };
  }

  const verdict = input.readiness.status === 'ready' ? input.readiness.verdict : null;
  if (!verdict) {
    notes.push(
      input.readiness.status === 'unavailable'
        ? 'Readiness could not be read, so only the session is recommended; run it as planned or decide intensity by feel.'
        : 'Readiness has no verdict yet (see readiness.status), so only the session is recommended. Ask again once the watch has synced for today\'s intensity.',
    );
  }
  if (best.score <= 0) {
    notes.push('Nothing any session trains is behind its weekly target; the top session is simply the least over.');
  }

  const restSuggested = verdict === 'easy' && best.score <= 0;
  if (restSuggested) {
    notes.push('Easy day with nothing behind: a rest day costs no progress. If you train anyway, run the session below.');
  }

  const session = input.sessions.find((s) => s.id === best.id)!;
  const prescription = verdict
    ? [...session.exercises]
        .sort((a, b) => a.order - b.order)
        .map((slot) => prescribeSlot(slot, verdict, statusOf.get(slot.muscle) ?? null))
    : null;

  return { readiness: input.readiness, session: best, alternatives, prescription, restSuggested, notes };
}
