import { QueryCommand, BatchWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { normalizeExerciseName } from './workout-exercises';
import { isAssignableMuscle, type AssignableMuscle } from './workout-muscles';
import { SUMMARY_PK } from './workout-schema';

/**
 * Muscle groups for exercise names the substring rules in workout-muscles.ts
 * cannot place.
 *
 * `muscleFor` matches on keywords, which is the right shape for a vocabulary
 * where one rule catches a dozen spellings of the same movement. What it cannot
 * do is place a name that shares no keyword with anything — "High low" names a
 * cable path, not a muscle — and those names fall to 'Other', where they quietly
 * stop counting toward the per-muscle rollups that get-muscle-volume-status and
 * the plan-compliance checks are built on.
 *
 * This module is the second, per-name layer under that fallback. Precedence
 * runs rules, then seeds, then the stored table, then 'Other':
 *
 *   - the **rules** stay authoritative. Nothing here is consulted for a name
 *     they already placed, so an override can only fill a gap, never contradict
 *     a keyword match. A name that starts matching a rule later stops consulting
 *     this layer at all, and the rule wins.
 *   - the **seeds** below are hand-classified and live in source, where they are
 *     reviewable and travel with the code, the same way the translation table in
 *     workout-exercises.ts does.
 *   - the **stored table** is the MUSCLEMAP partition of the summary table, for
 *     names resolved at import time rather than by hand.
 *
 * Why stored and not re-derived: the import re-reads the full history and
 * rebuilds every rollup from scratch, and the README's claim that the summaries
 * "cannot drift from the sets [they summarise]" depends on that rebuild being
 * reproducible. Anything non-deterministic in the path breaks it silently — the
 * same CSV imported twice would produce different rollups and nothing would
 * alarm. Writing the decision down once and replaying it keeps the property.
 */

/** Hand-classified names, raw spelling → group. Seeds win over stored entries. */
export const MUSCLE_SEEDS: Readonly<Record<string, AssignableMuscle>> = {
  /**
   * Classified by the lifter as rhomboid-major, trapezius-secondary.
   *
   * There is no Rhomboids group to assign, and adding one is not a rename: the
   * groups are also the vocabulary the weekly targets are written in, so a new
   * one arrives untargeted and reports as such in get-muscle-volume-status until
   * the published plan is revised to cover it. Traps is the lifter's own
   * secondary and the only group of the two that exists, so the sets count
   * there.
   *
   * Worth knowing if this is ever revisited: rhomboid work that is *named* like
   * a row ("ロウ", "row") is placed by the Lats rule instead, since that rule owns
   * the pulling group. This name reaches no rule at all — "High low" describes a
   * cable path — which is why it needs a seed while those do not.
   */
  'High low': 'Traps',
};

/** How a stored group was arrived at, kept so a decision can be re-examined. */
export type MuscleOverrideSource = 'manual' | 'model';

export interface MuscleOverride {
  /** The name as logged, for display; the stored key is its normalized form. */
  readonly rawName: string;
  readonly muscle: AssignableMuscle;
  readonly source: MuscleOverrideSource;
  /** Reported confidence, when a model produced it. */
  readonly confidence?: number;
}

/** Stored item shape. `sk` is the normalized name, so lookups need no scan. */
export const muscleOverrideItem = (
  override: MuscleOverride,
  now: Date = new Date(),
): Record<string, unknown> => ({
  pk: SUMMARY_PK.muscleMap,
  sk: normalizeExerciseName(override.rawName),
  rawName: override.rawName.trim(),
  muscle: override.muscle,
  source: override.source,
  ...(override.confidence === undefined ? {} : { confidence: override.confidence }),
  updatedAt: now.toISOString(),
});

/**
 * Every override in force, keyed by normalized name, ready for parseWorkoutRows.
 *
 * Stored rows are validated on the way in rather than trusted: `isAssignableMuscle`
 * rejects anything that is not a group, and in particular anything claiming
 * 'Cardio'. That check is the reason a bad row cannot do real damage — cardio
 * rows are dropped at ingest, so a stored 'Cardio' would delete a lift's sets on
 * every import instead of merely mislabelling them. A rejected row is logged and
 * skipped, leaving the name to report as unresolved, which is the visible
 * failure rather than the silent one.
 */
export async function loadMuscleOverrides(
  ddb: DynamoDBDocumentClient,
  summaryTable: string,
): Promise<Map<string, AssignableMuscle>> {
  const overrides = new Map<string, AssignableMuscle>();

  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: summaryTable,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': SUMMARY_PK.muscleMap },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const sk = item.sk;
      if (typeof sk !== 'string') continue;
      if (!isAssignableMuscle(item.muscle)) {
        console.warn(
          `Ignoring muscle override for "${sk}": ${JSON.stringify(item.muscle)} is not a group a name may be assigned to`,
        );
        continue;
      }
      overrides.set(sk, item.muscle);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  // Seeds last so a hand-made decision beats a stored one for the same name.
  for (const [rawName, muscle] of Object.entries(MUSCLE_SEEDS)) {
    overrides.set(normalizeExerciseName(rawName), muscle);
  }

  return overrides;
}

/** DynamoDB's hard cap on items per BatchWriteItem request. */
const BATCH_LIMIT = 25;

/**
 * Records resolved names, so the next import replays the decision instead of
 * making it again. Writing nothing is a no-op rather than an empty request,
 * since the common import resolves nothing new.
 */
export async function putMuscleOverrides(
  ddb: DynamoDBDocumentClient,
  summaryTable: string,
  overrides: readonly MuscleOverride[],
): Promise<void> {
  const writable = overrides.filter((o) => isAssignableMuscle(o.muscle));
  for (let i = 0; i < writable.length; i += BATCH_LIMIT) {
    const chunk = writable.slice(i, i + BATCH_LIMIT);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [summaryTable]: chunk.map((o) => ({ PutRequest: { Item: muscleOverrideItem(o) } })),
        },
      }),
    );
  }
}
