import { MUSCLE_GROUPS, type MuscleGroup } from './workout-muscles';
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
 *   which session   chosen from the volume status and recent training — the
 *                   plan's sessions ranked by how much of what they train is
 *                   behind *and* recovered since it was last trained
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
 * Recovery is the reason the session choice needs the log and not only the
 * volume status. The status is a rolling seven-day count, so a muscle trained
 * yesterday can still read "behind": that is what recommended Upper B on
 * 2026-10-21, the day after Upper B. A behind muscle only argues for a session
 * once it has had its minimum days off (see RecoveryConfig).
 *
 * Free of AWS SDK imports, like the modules it joins.
 */

/**
 * How much each muscle status argues for training a session that hits it.
 * The volume-only score sums these (see rankSessionsByVolume); the
 * recovery-aware score counts behind muscles instead and uses them only to
 * order the `behind` list.
 */
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
 * Minimum whole days between two sessions training the same muscle.
 *
 * Small, low-fatigue muscles are set to a single day: lateral raises are
 * deliberately programmed in nearly every session, and a two-day rule would
 * make every upper day "unrecovered" for shoulders by design.
 */
export interface RecoveryConfig {
  readonly defaultDays: number;
  readonly byMuscle: Readonly<Partial<Record<MuscleGroup, number>>>;
}

export const DEFAULT_RECOVERY: RecoveryConfig = {
  defaultDays: 2,
  byMuscle: { Shoulders: 1, Calves: 1, Forearms: 1, Abs: 1 },
};

/**
 * How far back the log is read for "last trained". Past this a muscle is
 * simply recovered, whatever the recovery minimum, and its daysSince is null.
 */
export const RECOVERY_LOOKBACK_DAYS = 14;

/**
 * A session whose planned sets fall more than this share on unrecovered
 * muscles is ranked below every session that does not.
 */
export const RECOVERY_BLOCK_SHARE = 0.5;

/**
 * - `top`: push day — the top of the prescribed set range, prescribed RPE.
 * - `as_planned`: the prescription unchanged.
 * - `reduced`: fewer sets and/or a lower RPE ceiling than prescribed.
 * - `skip`: leave the slot out today.
 */
export type SlotAction = 'top' | 'as_planned' | 'reduced' | 'skip';

export interface SessionRecovery {
  /**
   * Whole days since each of the session's muscles was last trained, in the
   * owner's time zone; null when not trained within RECOVERY_LOOKBACK_DAYS.
   */
  readonly daysSinceByMuscle: Readonly<Partial<Record<MuscleGroup, number | null>>>;
  /** Share of the session's planned sets (top of each range) on unrecovered muscles, 0-1. */
  readonly unrecoveredSetShare: number;
  /** True when that share exceeds RECOVERY_BLOCK_SHARE; such a session ranks last. */
  readonly recoveryBlocked: boolean;
}

export interface SessionScore {
  readonly id: string;
  readonly name: string;
  /** How many of the `behind` muscles are also recovered. */
  readonly score: number;
  /** The muscles below their weekly target, with their status, strongest first. */
  readonly behind: readonly { muscle: MuscleGroup; status: VolumeStatus }[];
  readonly bonus: boolean;
  readonly recovery: SessionRecovery;
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

/** A session as the volume-only ranking scores it: no recovery. */
export type VolumeSessionScore = Omit<SessionScore, 'recovery'>;

/**
 * The recommendation as it was made before recovery was considered, kept
 * alongside the recovery-aware one so the two can be compared: where they
 * disagree, recovery is the reason.
 */
export interface VolumeOnlyRecommendation {
  readonly session: VolumeSessionScore | null;
  readonly alternatives: readonly VolumeSessionScore[];
  readonly prescription: readonly SlotPrescription[] | null;
  /** True on an easy day when this ranking's top session has nothing behind. */
  readonly restSuggested: boolean;
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
   * nothing to gain today that is worth the recovery it costs. Also true,
   * whatever the verdict, when every session is recovery-blocked.
   */
  readonly restSuggested: boolean;
  readonly notes: readonly string[];
  /** The volume-only ranking, without recovery, for comparison. */
  readonly volumeOnly: VolumeOnlyRecommendation;
}

export interface RecommendationInput {
  readonly readiness: ReadinessSummary;
  readonly volume: readonly Pick<MuscleVolumeRow, 'muscle' | 'status'>[];
  readonly rotation: readonly string[];
  readonly bonusSessions: readonly string[];
  readonly sessions: readonly PlanSession[];
  /** The owner's local date today, YYYY-MM-DD. */
  readonly today: string;
  /** Logged training days, each with the muscles it trained. Order does not matter. */
  readonly trainingDays: readonly TrainingDay[];
  /** Defaults to DEFAULT_RECOVERY. */
  readonly recovery?: RecoveryConfig;
}

export interface TrainingDay {
  /** YYYY-MM-DD, the owner's local date the sets were logged on. */
  readonly date: string;
  readonly muscles: readonly string[];
}

/** Whole calendar days from `from` to `to`, both YYYY-MM-DD. */
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Days since each muscle was last trained, as of `today`. The log carries
 * dates, not times, so this is in whole days: a muscle trained yesterday is 1,
 * today 0. Days after `today` or more than `lookbackDays` before it are
 * ignored; a muscle absent from the result was not trained in that span.
 */
export function daysSinceTrained(
  trainingDays: readonly TrainingDay[],
  today: string,
  lookbackDays: number = RECOVERY_LOOKBACK_DAYS,
): Map<MuscleGroup, number> {
  const since = new Map<MuscleGroup, number>();
  for (const day of trainingDays) {
    const days = daysBetween(day.date, today);
    if (!(days >= 0 && days <= lookbackDays)) continue;
    for (const muscle of day.muscles) {
      if (!(MUSCLE_GROUPS as readonly string[]).includes(muscle)) continue;
      const group = muscle as MuscleGroup;
      const known = since.get(group);
      if (known === undefined || days < known) since.set(group, days);
    }
  }
  return since;
}

export const recoveryDaysFor = (muscle: MuscleGroup, config: RecoveryConfig): number =>
  config.byMuscle[muscle] ?? config.defaultDays;

/** What rankSessions needs to judge recovery; omitted, every muscle counts as rested. */
export interface RecoveryContext {
  readonly daysSince: ReadonlyMap<MuscleGroup, number>;
  readonly config: RecoveryConfig;
}

const NO_HISTORY: RecoveryContext = { daysSince: new Map(), config: DEFAULT_RECOVERY };

/**
 * Ranks every session the plan names by how many of the muscles it trains are
 * below their weekly target *and* recovered. Each muscle counts once per
 * session however many slots hit it: two chest slots do not make a session
 * twice as much "the chest day" for this purpose.
 *
 * In order:
 *   1. recovery-blocked sessions after all others — more than half of their
 *      planned sets would land on muscles still recovering;
 *   2. score, highest first;
 *   3. the more rested session: higher average days since last trained,
 *      weighted by planned sets (a muscle untrained in the lookback counts as
 *      one day past it);
 *   4. rotation order, then bonus sessions, so the plan's own sequence breaks
 *      what is left rather than array position.
 */
export function rankSessions(
  sessions: readonly PlanSession[],
  statusOf: ReadonlyMap<MuscleGroup, VolumeStatus>,
  rotation: readonly string[],
  bonusSessions: readonly string[],
  recovery: RecoveryContext = NO_HISTORY,
): SessionScore[] {
  const order = [...rotation, ...bonusSessions.filter((id) => !rotation.includes(id))];
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? order.length : i;
  };
  const recovered = (muscle: MuscleGroup) => {
    const days = recovery.daysSince.get(muscle);
    return days === undefined || days >= recoveryDaysFor(muscle, recovery.config);
  };

  return sessions
    .map((session) => {
      const muscles = [...new Set(session.exercises.map((e) => e.muscle))];
      const behind = muscles
        .map((muscle) => ({ muscle, status: statusOf.get(muscle) }))
        .filter((m): m is { muscle: MuscleGroup; status: VolumeStatus } => m.status !== undefined)
        .filter((m) => STATUS_WEIGHT[m.status] > 0)
        .sort((a, b) => STATUS_WEIGHT[b.status] - STATUS_WEIGHT[a.status]);
      const score = behind.filter((m) => recovered(m.muscle)).length;

      let plannedSets = 0;
      let unrecoveredSets = 0;
      let restedSetDays = 0;
      for (const slot of session.exercises) {
        plannedSets += slot.sets.max;
        if (!recovered(slot.muscle)) unrecoveredSets += slot.sets.max;
        restedSetDays += slot.sets.max * (recovery.daysSince.get(slot.muscle) ?? RECOVERY_LOOKBACK_DAYS + 1);
      }
      const unrecoveredSetShare = plannedSets > 0 ? unrecoveredSets / plannedSets : 0;

      return {
        id: session.id,
        name: session.name,
        score,
        behind,
        bonus: bonusSessions.includes(session.id) && !rotation.includes(session.id),
        recovery: {
          daysSinceByMuscle: Object.fromEntries(
            muscles.map((muscle) => [muscle, recovery.daysSince.get(muscle) ?? null]),
          ),
          unrecoveredSetShare: Math.round(unrecoveredSetShare * 100) / 100,
          recoveryBlocked: unrecoveredSetShare > RECOVERY_BLOCK_SHARE,
        },
        rested: plannedSets > 0 ? restedSetDays / plannedSets : 0,
      };
    })
    .sort(
      (a, b) =>
        Number(a.recovery.recoveryBlocked) - Number(b.recovery.recoveryBlocked) ||
        b.score - a.score ||
        b.rested - a.rested ||
        rank(a.id) - rank(b.id),
    )
    .map(({ rested: _rested, ...score }) => score);
}

/**
 * The ranking as it was before recovery: each session scored by the status
 * of the muscles it trains (STATUS_WEIGHT: under +2, maintenance +1, in range
 * 0, over -1), each muscle counted once however many slots hit it, ties going
 * to rotation order, then bonus sessions.
 */
export function rankSessionsByVolume(
  sessions: readonly PlanSession[],
  statusOf: ReadonlyMap<MuscleGroup, VolumeStatus>,
  rotation: readonly string[],
  bonusSessions: readonly string[],
): VolumeSessionScore[] {
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

/**
 * One note per session the recovery rules moved down: compared with the same
 * ranking made with every muscle treated as rested, any session now further
 * down lost its place to recovery and nothing else.
 */
function recoveryNotes(
  ranked: readonly SessionScore[],
  ignoringRecovery: readonly SessionScore[],
  daysSince: ReadonlyMap<MuscleGroup, number>,
  config: RecoveryConfig,
): string[] {
  const ordinal = (n: number) => {
    const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
    return `${n}${suffix}`;
  };
  const dayWord = (n: number) => (n === 1 ? '1 day ago' : n === 0 ? 'today' : `${n} days ago`);

  return ranked.flatMap((session, now) => {
    const before = ignoringRecovery.findIndex((s) => s.id === session.id);
    if (now <= before) return [];
    const unrecovered = Object.keys(session.recovery.daysSinceByMuscle)
      .map((m) => m as MuscleGroup)
      .filter((m) => {
        const days = daysSince.get(m);
        return days !== undefined && days < recoveryDaysFor(m, config);
      })
      .map((m) => `${m} (trained ${dayWord(daysSince.get(m)!)}, needs ${recoveryDaysFor(m, config)})`);
    const why = session.recovery.recoveryBlocked
      ? `recovery-blocked: ${Math.round(session.recovery.unrecoveredSetShare * 100)}% of its planned sets would hit muscles still recovering`
      : unrecovered.length > 0
        ? 'behind muscles that have not recovered do not count toward its score'
        : 'it lost a tie to a more rested session';
    const detail = unrecovered.length > 0 ? ` Not yet recovered: ${unrecovered.join(', ')}.` : '';
    return [`${session.name} moved down from ${ordinal(before + 1)} to ${ordinal(now + 1)} for recovery (${why}).${detail}`];
  });
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
  const config = input.recovery ?? DEFAULT_RECOVERY;
  const daysSince = daysSinceTrained(input.trainingDays, input.today);
  const ranked = rankSessions(input.sessions, statusOf, input.rotation, input.bonusSessions, { daysSince, config });
  const [best, ...alternatives] = ranked;
  const notes: string[] = recoveryNotes(
    ranked,
    rankSessions(input.sessions, statusOf, input.rotation, input.bonusSessions),
    daysSince,
    config,
  );

  const verdict = input.readiness.status === 'ready' ? input.readiness.verdict : null;
  const prescribe = (id: string) => {
    const session = input.sessions.find((s) => s.id === id)!;
    return verdict
      ? [...session.exercises]
          .sort((a, b) => a.order - b.order)
          .map((slot) => prescribeSlot(slot, verdict, statusOf.get(slot.muscle) ?? null))
      : null;
  };

  const [volumeBest, ...volumeAlternatives] = rankSessionsByVolume(
    input.sessions,
    statusOf,
    input.rotation,
    input.bonusSessions,
  );
  const volumeOnly: VolumeOnlyRecommendation = {
    session: volumeBest ?? null,
    alternatives: volumeAlternatives,
    prescription: volumeBest ? prescribe(volumeBest.id) : null,
    restSuggested: verdict === 'easy' && volumeBest !== undefined && volumeBest.score <= 0,
  };

  if (!best) {
    return {
      readiness: input.readiness,
      session: null,
      alternatives: [],
      prescription: null,
      restSuggested: false,
      notes: ['The plan has no sessions.'],
      volumeOnly,
    };
  }

  if (!verdict) {
    notes.push(
      input.readiness.status === 'unavailable'
        ? 'Readiness could not be read, so only the session is recommended; run it as planned or decide intensity by feel.'
        : 'Readiness has no verdict yet (see readiness.status), so only the session is recommended. Ask again once the watch has synced for today\'s intensity.',
    );
  }
  const allBlocked = ranked.every((s) => s.recovery.recoveryBlocked);
  if (allBlocked) {
    notes.push('Every session would put most of its sets on muscles still recovering: rest today. If you train anyway, run the session below.');
  } else if (best.score <= 0) {
    notes.push('Nothing any session trains is both behind its weekly target and recovered; the top session is simply the most rested.');
  }

  const easyAndNothingBehind = verdict === 'easy' && best.score <= 0;
  const restSuggested = allBlocked || easyAndNothingBehind;
  if (easyAndNothingBehind && !allBlocked) {
    notes.push('Easy day with nothing behind: a rest day costs no progress. If you train anyway, run the session below.');
  }

  if (volumeBest && volumeBest.id !== best.id) {
    notes.push(
      `The volume-only ranking, which ignores recovery, would pick ${volumeBest.name} (see volumeOnly).`,
    );
  }

  return {
    readiness: input.readiness,
    session: best,
    alternatives,
    prescription: prescribe(best.id),
    restSuggested,
    notes,
    volumeOnly,
  };
}
