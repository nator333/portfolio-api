import { z } from 'zod';
import {
  muscleGroupSchema,
  planExerciseSchema,
  weeklySetTargetSchema,
  type PlanExercise,
  type PlanVersion,
  type WeeklySetTarget,
} from './workout-plan-schema';
import type { MuscleGroup } from './workout-muscles';

/**
 * The edit vocabulary for revising a training program in place — "change the
 * sets on Upper A's second slot", or "chest is 8-10 a week now", rather than
 * resending the whole document.
 *
 * Applying edits still *publishes a new version*: this module only computes the
 * next document, it never mutates the stored one. Versions stay immutable, so
 * the difference from a full republish is ergonomic, not structural — the caller
 * is spared round-tripping ~10KB of JSON to change two numbers, and the diff
 * between consecutive versions stays small enough to read.
 *
 * Kept free of AWS imports so the whole transform is unit-testable; the handler
 * in revise-workout-plan.ts supplies the I/O.
 */

/** Fields of a slot a patch may change; the merged result is validated in full. */
const exerciseChangesSchema = planExerciseSchema.partial();

export const planEditSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('patch'),
    session: z.string(),
    /** Identifies the slot within the session by its 1-based position. */
    order: z.number().int().min(1),
    changes: exerciseChangesSchema,
  }),
  z.object({
    op: z.literal('remove'),
    session: z.string(),
    order: z.number().int().min(1),
  }),
  z.object({
    op: z.literal('add'),
    session: z.string(),
    exercise: planExerciseSchema,
  }),
  /**
   * Set (or replace) a weekly set target. Unlike the three above this touches no
   * session: a target is declared guidance, not a slot, and the two deliberately
   * do not have to agree — see WeeklySetTarget.
   *
   * The targets were editable only by republishing the whole document, which is
   * why they drifted: a consumer that wanted a range the plan did not state kept
   * its own copy instead, and the plan and the progress page ended up disagreeing
   * about chest, lats, and whether traps had a target at all. Making the field
   * as cheap to revise as a set count is what keeps it the single source.
   */
  z.object({
    op: z.literal('set-target'),
    target: weeklySetTargetSchema.partial({ bonusWeekSets: true }),
  }),
  z.object({
    op: z.literal('remove-target'),
    muscles: z.array(muscleGroupSchema).min(1),
  }),
]);

export type PlanEdit = z.infer<typeof planEditSchema>;

/** Version-level fields a revision may also set, beyond the required changeNote. */
export const revisionMetaSchema = z.object({
  changeNote: z.string().trim().min(1, 'a revision must say what changed and why'),
  name: z.string().trim().min(1).optional(),
  effectiveFrom: z.string().nullable().optional(),
  effectiveTo: z.string().nullable().optional(),
});

export type RevisionMeta = z.infer<typeof revisionMetaSchema>;

export type EditResult =
  | { readonly ok: true; readonly plan: PlanVersion }
  | { readonly ok: false; readonly error: string };

/**
 * Applies `edits` to `base`, returning the *next* version document.
 *
 * Edits apply in order, each against the result of the last, so a patch may
 * target a slot an earlier edit added. Anything that does not resolve — an
 * unknown session, no slot at that position — fails the whole revision rather
 * than being skipped: a partially-applied program is worse than a rejected one,
 * because the caller would have no way to tell which half landed.
 *
 * `createdAt` is left as the base's; the handler stamps it at write time.
 */
export function applyPlanEdits(
  base: PlanVersion,
  edits: readonly PlanEdit[],
  meta: RevisionMeta,
): EditResult {
  if (edits.length === 0) {
    return { ok: false, error: 'No edits were supplied' };
  }

  let sessions = base.sessions;

  for (const edit of edits) {
    // Target ops never reach here: they address a different document entirely
    // and are routed to applyTargetEdits by the handler.
    if (edit.op === 'set-target' || edit.op === 'remove-target') {
      return { ok: false, error: `"${edit.op}" edits the targets, not the menu` };
    }

    const index = sessions.findIndex((s) => s.id === edit.session);
    if (index === -1) {
      const known = sessions.map((s) => s.id).join(', ');
      return { ok: false, error: `Unknown session "${edit.session}"; this plan has: ${known}` };
    }
    const session = sessions[index];

    const applied = applyToSession(session.exercises, edit);
    if (!applied.ok) return applied;

    sessions = sessions.map((s, i) => (i === index ? { ...s, exercises: applied.exercises } : s));
  }

  return {
    ok: true,
    plan: {
      ...base,
      version: base.version + 1,
      sessions,
      changeNote: meta.changeNote,
      name: meta.name ?? base.name,
      effectiveFrom: meta.effectiveFrom === undefined ? base.effectiveFrom : meta.effectiveFrom,
      effectiveTo: meta.effectiveTo === undefined ? base.effectiveTo : meta.effectiveTo,
    },
  };
}

type SessionEditResult =
  | { readonly ok: true; readonly exercises: readonly PlanExercise[] }
  | { readonly ok: false; readonly error: string };

function applyToSession(
  exercises: readonly PlanExercise[],
  edit: Extract<PlanEdit, { op: 'patch' | 'remove' | 'add' }>,
): SessionEditResult {
  if (edit.op === 'add') {
    // Insert, don't just append: "add this as the second exercise" means the
    // rest of the session moves down, which is what a lifter means and what the
    // unique-position rule would otherwise force the caller to hand-renumber.
    // A position past the end simply lands at the end with nothing to shift.
    const at = edit.exercise.order;
    const shifted = exercises.map((e) => (e.order >= at ? { ...e, order: e.order + 1 } : e));
    return {
      ok: true,
      // Kept in performed order, so a reader never has to sort it.
      exercises: [...shifted, edit.exercise].sort((a, b) => a.order - b.order),
    };
  }

  const target = exercises.findIndex((e) => e.order === edit.order);
  if (target === -1) {
    const positions = exercises.map((e) => e.order).join(', ');
    return {
      ok: false,
      error: `Session "${edit.session}" has no exercise at position ${edit.order}; it has: ${positions}`,
    };
  }

  if (edit.op === 'remove') {
    return { ok: true, exercises: exercises.filter((_, i) => i !== target) };
  }

  const merged = { ...exercises[target], ...edit.changes };
  return {
    ok: true,
    exercises: exercises
      .map((e, i) => (i === target ? merged : e))
      .sort((a, b) => a.order - b.order),
  };
}

export type TargetEditResult =
  | { readonly ok: true; readonly targets: readonly WeeklySetTarget[] }
  | { readonly ok: false; readonly error: string };

/** The muscles an entry covers, order-independent, for matching one entry to another. */
const muscleKey = (muscles: readonly MuscleGroup[]): string => [...muscles].sort().join('+');

/**
 * Sets or removes one weekly set target.
 *
 * An entry is identified by the exact set of muscles it covers, so revising the
 * combined glutes+hamstrings target means naming both — the same way it is
 * stated. A partial overlap is refused rather than resolved: if one entry
 * already covers glutes and hamstrings together, "glutes is 6-8" leaves two
 * entries claiming glutes with no single answer for the group's status, and
 * guessing which one a reader meant is how these numbers drift in the first
 * place. The caller is told to remove the combined entry first.
 */
/**
 * Applies target edits to a target set, returning the next set's entries.
 *
 * The counterpart to applyPlanEdits on the other half of a program. Edits apply
 * in order, and any that does not resolve fails the whole revision rather than
 * being skipped — a half-applied set of targets is worse than a rejected one,
 * since the caller cannot tell which half landed.
 */
export function applyTargetEdits(
  targets: readonly WeeklySetTarget[],
  edits: readonly Extract<PlanEdit, { op: 'set-target' | 'remove-target' }>[],
): TargetEditResult {
  let next = targets;
  for (const edit of edits) {
    const applied = applyOneTarget(next, edit);
    if (!applied.ok) return applied;
    next = applied.targets;
  }
  return { ok: true, targets: next };
}

function applyOneTarget(
  targets: readonly WeeklySetTarget[],
  edit: Extract<PlanEdit, { op: 'set-target' | 'remove-target' }>,
): TargetEditResult {
  const muscles = edit.op === 'set-target' ? edit.target.muscles : edit.muscles;
  const key = muscleKey(muscles);
  const at = targets.findIndex((t) => muscleKey(t.muscles) === key);

  if (edit.op === 'remove-target') {
    if (at === -1) {
      const known = targets.map((t) => muscleKey(t.muscles)).join(', ') || 'none';
      return {
        ok: false,
        error: `No weekly set target covers exactly ${key}; this plan targets: ${known}`,
      };
    }
    return { ok: true, targets: targets.filter((_, i) => i !== at) };
  }

  // `bonusWeekSets` is optional on the wire but stored explicitly, so a target
  // set without one reads as "unchanged on a bonus week" rather than absent.
  const next: WeeklySetTarget = {
    muscles: edit.target.muscles,
    sets: edit.target.sets,
    bonusWeekSets: edit.target.bonusWeekSets ?? null,
  };

  if (at !== -1) {
    return { ok: true, targets: targets.map((t, i) => (i === at ? next : t)) };
  }

  const overlapping = targets.find((t) => t.muscles.some((m) => muscles.includes(m)));
  if (overlapping) {
    return {
      ok: false,
      error:
        `A weekly set target already covers ${muscleKey(overlapping.muscles)}, which overlaps ` +
        `${key}; remove that entry before adding this one`,
    };
  }

  return { ok: true, targets: [...targets, next] };
}
