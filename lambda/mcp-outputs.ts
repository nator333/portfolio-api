import { z } from 'zod';
import type { ReadinessResult } from './readiness';
import type { toHealthLogEntry } from './health-log-schema';
import type { ToolError } from './tool-error';
import { TOOL_ERROR_CODES } from './tool-error';

/**
 * Output schemas for the tools whose results need explaining: what used to be
 * prose in their descriptions ("`latest.trendKg` is the 7-day mean…") is stated
 * here once, advertised as `outputSchema` in tools/list, and returned as
 * `structuredContent` beside the text.
 *
 * Only two tools have one: the two whose results carry the rules most costly to
 * get wrong (a failed read is not an empty night; never invent a verdict). The
 * others' descriptions cover their results; full output schemas for
 * get_training_recommendation and get_weight_trend were tried and cost about
 * 11k characters of tools/list for little the prose did not already say.
 *
 * Kept honest two ways, since the results are built as plain objects typed by
 * TypeScript interfaces rather than parsed through these:
 *
 *   - at compile time, each domain type must be assignable to its schema's
 *     input type (the `Fits` checks at the bottom), so changing an interface
 *     without the schema fails `tsc`;
 *   - at run time, mcp.ts checks every result and logs a mismatch, without
 *     failing the call; tests check real handler output.
 *
 * Objects are not strict: a field added to a result before its schema is a
 * logged mismatch to fix, not a broken read.
 */

// Dates and instants carry no description each: the field names say which they
// are, and the same sentence repeated on 30 fields is 1k characters of tools/list.
const isoDate = z.string();
const instant = z.string();
const baseline = z.object({ mean: z.number(), sd: z.number(), days: z.number() });
const fetchedCounts = z.object({ points: z.number(), usable: z.number() });
const signal = z.enum(['sleep', 'hrv', 'restingHeartRate']);

const toolErrorSchema = z
  .object({
    code: z.enum(TOOL_ERROR_CODES),
    message: z.string(),
    retry: z.enum(['now', 'after_reread', 'after_fix', 'owner_action', 'never']),
    fix: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ description: 'The shared error shape; see the server instructions.' });

// --- get_readiness -------------------------------------------------------------

const readinessResult = z.object({
  date: isoDate,
  status: z.enum(['ready', 'not_synced', 'pending', 'insufficient_baseline']).meta({
    description:
      '"not_synced": ask the owner to sync the Fitbit app. "pending": try again in a few minutes. ' +
      '"insufficient_baseline": under 7 days of HRV.',
  }),
  verdict: z.enum(['push', 'normal', 'easy']).nullable().meta({
    description: 'Null unless status is "ready". Never fill it in.',
  }),
  reasons: z.array(z.string()),
  signals: z.object({
    sleep: z
      .object({
        endDate: isoDate,
        endTime: instant,
        minutesAsleep: z.number().nullable(),
        mainSleep: z.boolean(),
        nap: z.boolean(),
        processed: z.boolean(),
        flag: z.enum(['very_short', 'short', 'normal']).nullable(),
      })
      .nullable(),
    hrv: z
      .object({
        date: isoDate,
        milliseconds: z.number(),
        baseline: baseline.nullable(),
        z: z.number().nullable().meta({ description: 'Standard deviations from the baseline, on the log scale.' }),
        flag: z.enum(['low', 'slightly_low', 'normal']).nullable(),
      })
      .nullable(),
    restingHeartRate: z
      .object({
        date: isoDate,
        beatsPerMinute: z.number(),
        baseline: baseline.nullable(),
        deltaBpm: z.number().nullable(),
        flag: z.enum(['elevated', 'slightly_elevated', 'normal']).nullable(),
      })
      .nullable(),
  }),
  missing: z.array(
    z.object({
      signal,
      latestDate: isoDate.nullable().meta({ description: 'Newest date the signal does have a value for.' }),
    }),
  ),
});

const getReadinessOutput = readinessResult.extend({
  asOf: instant,
  timeZone: z.string(),
  fetched: z.object({ sleep: fetchedCounts, hrv: fetchedCounts, restingHeartRate: fetchedCounts }),
});

// --- list_health_log -------------------------------------------------------------

const measuredDay = z.object({
  status: z.enum(['awaiting', 'not_synced', 'no_data', 'pending', 'ready', 'insufficient_baseline']).meta({
    description:
      '"awaiting": Google not asked yet. "not_synced": no night yet today. "no_data": the day is over and ' +
      'Google has nothing (watch off or flat). "pending"/"ready" as in get_readiness.',
  }),
  verdict: z.enum(['push', 'normal', 'easy']).nullable(),
  reasons: z.array(z.string()),
  missing: z.array(z.object({ signal, latestDate: isoDate.nullable() })).meta({
    description: 'Signals Google had nothing for, each with the newest date it does have: the same date across days is a gap.',
  }),
  sleep: z.object({ minutesAsleep: z.number().nullable(), endTime: instant, processed: z.boolean() }).nullable(),
  hrv: z
    .object({ milliseconds: z.number(), baselineMean: z.number().nullable(), z: z.number().nullable(), flag: z.string().nullable() })
    .nullable(),
  restingHeartRate: z
    .object({
      beatsPerMinute: z.number(),
      baselineMean: z.number().nullable(),
      deltaBpm: z.number().nullable(),
      flag: z.string().nullable(),
    })
    .nullable(),
  settled: z.boolean().meta({ description: 'True once final; never rewritten after.' }),
});

const healthLogEntry = z.object({
  date: isoDate,
  measured: measuredDay,
  measuredAt: instant.optional().meta({ description: 'When Google was last read successfully for this day.' }),
  createdAt: instant,
  fetchError: z
    .object({ at: instant, by: z.enum(['chat', 'morning', 'nightly']), error: toolErrorSchema })
    .optional()
    .meta({
      description:
        'The last read FAILED; `measured` is the last good answer, not evidence of an empty night. Never call ' +
        'a failed read "no data", or vice versa.',
    }),
  notes: z.record(z.string(), z.object({ at: instant, text: z.string(), editedAt: instant.optional() })).meta({
    description: 'What the owner said, keyed by entry id, oldest first.',
  }),
  tags: z.array(z.string()),
  energy: z.number().optional(),
  mood: z.number().optional(),
  stress: z.number().optional(),
  soreness: z.number().optional(),
  notesUpdatedAt: instant.optional(),
});

const listHealthLogOutput = z.object({
  from: isoDate,
  to: isoDate,
  count: z.number(),
  days: z.array(healthLogEntry).meta({ description: 'Newest first.' }),
});

export const TOOL_OUTPUTS = {
  get_readiness: getReadinessOutput,
  list_health_log: listHealthLogOutput,
} satisfies Record<string, z.ZodType>;

export type OutputToolName = keyof typeof TOOL_OUTPUTS;

/**
 * The JSON Schema `tools/list` advertises as `outputSchema`, `$schema` key
 * dropped. Sub-schemas used more than once (a session score appears in four
 * places in a recommendation) are moved to `$defs` and referenced, but only
 * where that comes out smaller: for small repeated pieces the references cost
 * more than they save. Either form describes the same values.
 */
export function outputSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const strip = (json: Record<string, unknown>) => {
    const { $schema: _drop, ...rest } = json;
    return rest;
  };
  const inline = strip(z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>);
  const referenced = strip(z.toJSONSchema(schema, { io: 'input', reused: 'ref' }) as Record<string, unknown>);
  return JSON.stringify(referenced).length < JSON.stringify(inline).length ? referenced : inline;
}

// --- Compile-time ties to the domain types ---------------------------------------
//
// Each line fails `tsc` if the type a handler builds stops fitting its schema.
// Readonly is stripped first: the schemas describe JSON, which has no readonly.

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
type Fits<Actual, Schema extends z.ZodType> = Mutable<Actual> extends z.input<Schema> ? true : never;

export const COMPILE_TIME_CHECKS: [
  Fits<ReadinessResult, typeof readinessResult>,
  Fits<ReturnType<typeof toHealthLogEntry>, typeof healthLogEntry>,
  Fits<ToolError, typeof toolErrorSchema>,
] = [true, true, true];
