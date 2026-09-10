import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SUMMARY_PK } from './workout-schema';
import { exerciseName } from './workout-exercises';

/**
 * The exercise catalogue: which movements exist in the training log, and what
 * each one's all-time shape is.
 *
 * There is deliberately no separate "exercise master" table. The `EXERCISE`
 * partition of the summary table already *is* one — the import rebuilds it from
 * scratch on every ingest and prunes rows the new rollup no longer produces
 * (see deleteStaleRows in workout-ingest.ts), so it cannot drift from the sets
 * it summarises the way a hand-maintained table would. A second table holding
 * the same ~130 names would add a table, a cross-region ARN, a grant and a
 * write path, and buy nothing the query below does not already answer.
 *
 * Nor is an alias column written at ingest: the raw-spelling → canonical-name
 * mapping is workout-exercises.ts, which is compiled into every Lambda that
 * needs it. Storing it would duplicate source into data.
 */

/** One catalogue entry — the fields a caller needs to pick an exercise. */
export interface CatalogEntry {
  readonly name: string;
  readonly muscle: string;
  readonly sets: number;
  readonly sessions: number;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly maxWeight: number;
  readonly maxWeightKg: number;
  readonly bestE1rm: number;
  readonly bestE1rmKg: number;
  readonly bestE1rmDate: string;
}

/** Reads every exercise in the log, most-trained first. */
export async function queryExerciseCatalog(
  ddb: DynamoDBDocumentClient,
  summaryTable: string,
): Promise<CatalogEntry[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: summaryTable,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': SUMMARY_PK.exercise },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return items
    .map((e) => ({
      name: String(e.sk ?? ''),
      muscle: String(e.muscle ?? ''),
      sets: Number(e.sets ?? 0),
      sessions: Number(e.sessions ?? 0),
      firstDate: String(e.firstDate ?? ''),
      lastDate: String(e.lastDate ?? ''),
      maxWeight: Number(e.maxWeight ?? 0),
      maxWeightKg: Number(e.maxWeightKg ?? 0),
      bestE1rm: Number(e.bestE1rm ?? 0),
      bestE1rmKg: Number(e.bestE1rmKg ?? 0),
      bestE1rmDate: String(e.bestE1rmDate ?? ''),
    }))
    .sort((a, b) => b.sets - a.sets);
}

/** Collapse whitespace (incl. full-width spaces) and lowercase, for matching only. */
const fold = (s: string): string => s.trim().replace(/[\s　]+/g, ' ').toLowerCase();

/** Enough to choose from without turning a miss into a wall of text. */
export const MAX_CANDIDATES = 10;

/**
 * Best-effort name resolution, in descending order of confidence.
 *
 * An agent will not reliably produce the exact stored string: the log's
 * canonical names come from workout-exercises.ts ("Bench Press"), while a
 * caller is as likely to send "bench", "bench press (barbell)" or the Japanese
 * spelling. `exerciseName` handles every spelling that has a mapping; this
 * handles the rest, and — crucially — hands back candidates instead of an empty
 * result, so a near miss is a question rather than a silent "you have never
 * trained this".
 */
export function resolveExercise(
  catalog: readonly CatalogEntry[],
  requested: string,
): { match?: CatalogEntry; candidates: CatalogEntry[] } {
  const canonical = exerciseName(requested);
  const exact = catalog.find((e) => e.name === canonical);
  if (exact) return { match: exact, candidates: [] };

  const folded = fold(canonical);
  const caseInsensitive = catalog.find((e) => fold(e.name) === folded);
  if (caseInsensitive) return { match: caseInsensitive, candidates: [] };

  // Substring both ways: "bench" finds "Bench Press", and "barbell bench press"
  // finds "Bench Press" too. Ranked by set count, so the lift actually trained
  // leads rather than an incidental variation.
  const partial = catalog.filter(
    (e) => fold(e.name).includes(folded) || folded.includes(fold(e.name)),
  );
  if (partial.length === 1) return { match: partial[0], candidates: [] };

  // Nothing, or several equally plausible — let the caller choose. Falling back
  // to word overlap keeps a typo ("bench pres") from returning nothing at all.
  if (partial.length > 1) return { candidates: partial.slice(0, MAX_CANDIDATES) };

  const words = folded.split(' ').filter((w) => w.length > 2);
  const overlapping = catalog
    .map((e) => ({ e, hits: words.filter((w) => fold(e.name).includes(w)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.e.sets - a.e.sets)
    .slice(0, MAX_CANDIDATES)
    .map((x) => x.e);

  return { candidates: overlapping };
}
