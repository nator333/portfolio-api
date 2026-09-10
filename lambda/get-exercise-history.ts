import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SETS_BY_EXERCISE_INDEX, SOURCE_WEIGHT_UNIT, estimate1rm, toKg } from './workout-schema';
import { queryExerciseCatalog, resolveExercise, type CatalogEntry } from './workout-catalog';
import { corsHeaders } from './cors';

/**
 * Admin-only read of one exercise's whole history: every logged set of a single
 * movement, in date order, with the all-time bests alongside.
 *
 * This is the lift-scoped counterpart to get-workout-sets.ts, which is
 * day-scoped because the table is partitioned by date. Asking "how has my bench
 * pressed moved this year" of *that* endpoint means 12 calls of 31 days each,
 * every one returning every other exercise trained on those days for the caller
 * to filter. Here the exercise-date index answers it in a single Query that
 * returns only the sets asked about — which matters far more for an MCP client,
 * where the discarded 95% would have been paid for in context, than it does for
 * DynamoDB's bill.
 */

const region = process.env.WORKOUT_REGION;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Ceiling on sets returned in one call. A decade of a favourite lift is well
 * over a thousand sets; serialised, that is a large fraction of a model's
 * context spent on one tool result. Past the cap the *most recent* sets are
 * kept — a progression question is about where the lift is now — and the
 * response says so, so the caller can page backwards with `to` rather than
 * silently reading a truncated history as the whole of it.
 */
export const MAX_SETS = 750;

interface HistorySet {
  readonly date: string;
  readonly sk: string;
  readonly setNo: number;
  readonly weight: number;
  readonly weightKg: number;
  readonly reps: number;
  readonly volume: number;
  readonly volumeKg: number;
  readonly notes: string;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const setsTable = process.env.WORKOUT_SETS_TABLE_NAME;
  const summaryTable = process.env.WORKOUT_SUMMARY_TABLE_NAME;
  if (!setsTable || !summaryTable) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        message: 'WORKOUT_SETS_TABLE_NAME and WORKOUT_SUMMARY_TABLE_NAME must both be configured',
      }),
    };
  }

  const params = event.queryStringParameters ?? {};
  const requested = (params.exercise ?? '').trim();
  if (!requested) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Provide exercise=<name>' }),
    };
  }

  const from = params.from;
  const to = params.to;
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: '`from` and `to` must be ISO YYYY-MM-DD' }),
    };
  }
  if (from && to && from > to) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: '`from` must not be after `to`' }),
    };
  }

  // Resolve the name against the catalogue *before* querying: a miss should
  // come back as "did you mean" rather than an empty history, which an agent
  // would otherwise report as "you have never trained this".
  const catalog = await queryExerciseCatalog(ddb, summaryTable);
  const { match, candidates } = resolveExercise(catalog, requested);
  if (!match) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({
        message: `No exercise matching "${requested}" in the training log`,
        requested,
        candidates: candidates.map((c) => c.name),
      }),
    };
  }

  const sets = await querySets(setsTable, match.name, from, to);
  const truncated = sets.length > MAX_SETS;
  const kept = truncated ? sets.slice(-MAX_SETS) : sets;

  const days = groupByDay(kept);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      exercise: match.name,
      // Echoed only when resolution changed the string, so the caller can see
      // that "bench" was answered with "Bench Press".
      ...(match.name === requested ? {} : { requested }),
      muscle: match.muscle,
      range: { from: from ?? null, to: to ?? null },
      unit: SOURCE_WEIGHT_UNIT,
      // All-time figures come from the rollup, not from `days`, so they stay
      // true even when the range or the cap trims what is returned below.
      allTime: allTimeOf(match),
      setCount: kept.length,
      sessionCount: days.length,
      ...(truncated
        ? {
            truncated: true,
            truncationNote:
              `More than ${MAX_SETS} sets matched; the most recent ${MAX_SETS} are returned. ` +
              'Pass `to` to read further back.',
          }
        : {}),
      best: bestOf(kept),
      days,
    }),
  };
};

/** The all-time bests as the import already computed them. */
function allTimeOf(entry: CatalogEntry) {
  return {
    sets: entry.sets,
    sessions: entry.sessions,
    firstDate: entry.firstDate,
    lastDate: entry.lastDate,
    maxWeight: entry.maxWeight,
    maxWeightKg: entry.maxWeightKg,
    bestE1rm: entry.bestE1rm,
    bestE1rmKg: entry.bestE1rmKg,
    bestE1rmDate: entry.bestE1rmDate,
  };
}

/**
 * The two bests *within what was returned*, which is what a range query is
 * actually asking about ("my best squat this block"). Heaviest is ranked on
 * weight with reps as the tie-break, because the heavier-for-more-reps set is
 * unambiguously the better one; the estimated-1RM best is tracked separately
 * since a heavy single and a lighter triple can disagree about which is
 * stronger.
 */
function bestOf(sets: readonly HistorySet[]) {
  if (sets.length === 0) return null;

  let heaviest = sets[0];
  let bestE1rm = sets[0];
  let bestE1rmValue = estimate1rm(sets[0].weight, sets[0].reps);

  for (const s of sets) {
    if (s.weight > heaviest.weight || (s.weight === heaviest.weight && s.reps > heaviest.reps)) {
      heaviest = s;
    }
    const e1rm = estimate1rm(s.weight, s.reps);
    if (e1rm > bestE1rmValue) {
      bestE1rmValue = e1rm;
      bestE1rm = s;
    }
  }

  return {
    heaviestSet: {
      date: heaviest.date,
      weight: heaviest.weight,
      weightKg: heaviest.weightKg,
      reps: heaviest.reps,
    },
    bestE1rm: {
      date: bestE1rm.date,
      weight: bestE1rm.weight,
      weightKg: bestE1rm.weightKg,
      reps: bestE1rm.reps,
      e1rm: bestE1rmValue,
      e1rmKg: toKg(bestE1rmValue),
    },
  };
}

/**
 * One entry per training day, each carrying that day's sets and its volume —
 * the shape a progression reader wants, and the same day-grouped framing
 * get-workout-sets.ts returns.
 */
function groupByDay(sets: readonly HistorySet[]) {
  const byDate = new Map<string, HistorySet[]>();
  for (const s of sets) {
    const day = byDate.get(s.date) ?? [];
    day.push(s);
    byDate.set(s.date, day);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, daySets]) => {
      // Within a day the index returns base-table-key order, which sorts
      // "Bench#10" before "Bench#2"; order by the recorded set number instead.
      const ordered = [...daySets].sort((a, b) => a.setNo - b.setNo);
      return {
        date,
        sets: ordered.map(({ date: _date, sk: _sk, ...rest }) => rest),
        volume: round2(ordered.reduce((total, s) => total + s.volume, 0)),
        volumeKg: round2(ordered.reduce((total, s) => total + s.volumeKg, 0)),
      };
    });
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Every set of one exercise, oldest first, over the optional date window. */
async function querySets(
  setsTable: string,
  exercise: string,
  from?: string,
  to?: string,
): Promise<HistorySet[]> {
  const values: Record<string, unknown> = { ':ex': exercise };
  let condition = '#e = :ex';
  if (from && to) {
    condition += ' AND #d BETWEEN :from AND :to';
    values[':from'] = from;
    values[':to'] = to;
  } else if (from) {
    condition += ' AND #d >= :from';
    values[':from'] = from;
  } else if (to) {
    condition += ' AND #d <= :to';
    values[':to'] = to;
  }

  const items: HistorySet[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: setsTable,
        IndexName: SETS_BY_EXERCISE_INDEX,
        KeyConditionExpression: condition,
        ExpressionAttributeNames: { '#e': 'exercise', '#d': 'date' },
        ExpressionAttributeValues: values,
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of page.Items ?? []) {
      items.push({
        date: String(item.date ?? ''),
        sk: String(item.sk ?? ''),
        setNo: Number(item.setNo ?? 0),
        weight: Number(item.weight ?? 0),
        weightKg: Number(item.weightKg ?? 0),
        reps: Number(item.reps ?? 0),
        volume: Number(item.volume ?? 0),
        volumeKg: Number(item.volumeKg ?? 0),
        notes: String(item.notes ?? ''),
      });
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return items;
}
