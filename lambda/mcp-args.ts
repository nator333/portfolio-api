import { z } from 'zod';
import {
  REFLECTION_LIST_DEFAULT_LIMIT,
  REFLECTION_LIST_MAX_LIMIT,
  REFLECTION_TYPES,
  addReflectionSchema,
  isoDate,
  themeTag,
  updateReflectionSchema,
} from './reflection-schema';
import { addHealthNoteSchema, listHealthLogSchema, updateHealthLogSchema } from './health-log-schema';
import { DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS } from './muscle-volume-status';
import { DEFAULT_DAYS as WEIGHT_DEFAULT_DAYS, MAX_DAYS as WEIGHT_MAX_DAYS, MIN_DAYS as WEIGHT_MIN_DAYS } from './weight-trend';
import { planEditSchema, revisionMetaSchema } from './workout-plan-edits';
import { planVersionObjectSchema } from './workout-plan-schema';

/**
 * Every MCP tool's arguments, as one zod schema each: the single source of
 * truth for what a tool accepts.
 *
 *   - `tools/list` advertises `inputSchema`, generated from these (mcp-schema.ts),
 *     so what Claude is shown cannot drift from what is enforced.
 *   - `tools/call` validates against them before any handler runs (mcp.ts), so
 *     a bad call is one `invalid_input` naming the fields, from one place.
 *
 * Where a domain schema already describes a tool's input (reflections, the
 * health log, plan edits), it is used as is. Read tools, whose handlers parse
 * query strings by hand for the REST API, get a schema here instead; those
 * handlers keep their own checks, so this layer must be at least as strict.
 *
 * Cross-field rules (from <= to, a span cap, either-or arguments) cannot be
 * stated in JSON Schema. They are enforced here or in the handler, and the
 * description says them in words.
 */

const date = (description: string) => isoDate.meta({ description });
const fromDate = date('Inclusive start date, ISO YYYY-MM-DD. Optional.').optional();
const toDate = date('Inclusive end date, ISO YYYY-MM-DD. Optional.').optional();
const planId = z.string().min(1).meta({ description: 'Which program. Optional; defaults to "upper-lower".' }).optional();

/**
 * The four site documents share one read and one write tool, keyed by `doc`.
 * Each was its own pair of tools once; eight near-identical entries in
 * tools/list cost every conversation context for no extra capability.
 */
export const CONTENT_DOCS = ['cv', 'projects', 'blog', 'home'] as const;

const doc = z.enum(CONTENT_DOCS).meta({
  description:
    'cv: personal info, summary, skills, experience, education. projects: the project list. ' +
    'blog: every post with its markdown. home: hero mottoes and background photos.',
});

/**
 * revise_workout_plan publishes either `edits` against the current version or
 * a whole `plan`. They were two tools; one tool with either argument halves
 * the plan-writing surface in tools/list. The plan is typed in full: a client
 * told only "an object" once guessed strings and had its publish rejected
 * field by field. `createdAt` is stamped on publish; `changeNote` defaults to
 * the tool's own.
 */
const EDIT_ONLY_ARGS = ['edits', 'planId', 'baseVersion', 'baseTargetsVersion', 'name', 'effectiveFrom', 'effectiveTo'] as const;

const revisePlanArgs = revisionMetaSchema
  .extend({
    changeNote: revisionMetaSchema.shape.changeNote.meta({ description: 'What changed and why. This is the version history.' }),
    edits: z
      .array(planEditSchema)
      .min(1)
      .meta({ description: 'Applied in order; if any edit does not resolve, nothing is written.' })
      .optional(),
    planId,
    baseVersion: z
      .number()
      .int()
      .min(1)
      .meta({ description: 'With edits: the menu version they were written against; refused if the plan has moved.' })
      .optional(),
    baseTargetsVersion: z
      .number()
      .int()
      .min(0)
      .meta({ description: 'With edits: the `targetsVersion` they were written against (0 if none yet). Same guard.' })
      .optional(),
    plan: planVersionObjectSchema
      .omit({ createdAt: true })
      .extend({ changeNote: z.string().optional() })
      .meta({
        description:
          'A complete plan version, as get_workout_plan returns it, with `version` set to the next ' +
          'number. This publishes the menu only: its `weeklySetTargets` are ignored, so change ' +
          'targets with set-target edits.',
      })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Sending both forms is refused rather than guessed at: dropping either
    // half silently would publish something the caller did not ask for.
    if (value.plan === undefined) {
      if (value.edits === undefined) {
        ctx.addIssue({ code: 'custom', path: ['edits'], message: 'Send `edits`, or a whole `plan`' });
      }
      return;
    }
    for (const key of EDIT_ONLY_ARGS) {
      if (value[key] !== undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'Only with `edits`: drop it when sending a whole `plan`' });
      }
    }
  });

export const TOOL_ARGS = {
  get_content: z.object({ doc }).strict(),
  get_workout: z.object({ from: fromDate, to: toDate }).strict(),
  get_workout_sets: z
    .object({
      date: date('A single day, ISO YYYY-MM-DD. Cheapest form.').optional(),
      from: date('Inclusive start date, ISO YYYY-MM-DD.').optional(),
      to: date('Inclusive end date, ISO YYYY-MM-DD. At most 31 days from `from`.').optional(),
    })
    .strict(),
  list_exercises: z
    .object({ muscle: z.string().min(1).meta({ description: 'Restrict to one muscle group, e.g. "Chest". Optional.' }).optional() })
    .strict(),
  get_exercise_history: z
    .object({
      exercise: z.string().trim().min(1).meta({
        description: 'e.g. "Bench Press". Partial or Japanese names resolve; an unknown name returns candidates.',
      }),
      from: fromDate,
      to: toDate,
    })
    .strict(),
  get_workout_plan: z
    .object({
      planId,
      version: z.number().int().min(1).meta({ description: 'A specific version. Optional.' }).optional(),
      date: date('The version in force that day, ISO YYYY-MM-DD. Optional.').optional(),
      history: z.boolean().meta({ description: 'True to list every version as metadata only. Optional.' }).optional(),
    })
    .strict(),
  get_muscle_volume_status: z
    .object({
      window: z
        .number()
        .int()
        .min(1)
        .max(MAX_WINDOW_DAYS)
        .meta({
          description: `Trailing window in days, ending now. Optional; defaults to ${DEFAULT_WINDOW_DAYS}. Targets are scaled to it.`,
        })
        .optional(),
      planId,
    })
    .strict(),
  get_readiness: z
    .object({ date: date('The owner\'s local day, ISO YYYY-MM-DD. Optional; defaults to today.').optional() })
    .strict(),
  get_training_recommendation: z.object({ planId }).strict(),
  get_weight_trend: z
    .object({
      days: z
        .number()
        .int()
        .min(WEIGHT_MIN_DAYS)
        .max(WEIGHT_MAX_DAYS)
        .meta({ description: `Window in days, ending today. Optional; defaults to ${WEIGHT_DEFAULT_DAYS}.` })
        .optional(),
      exercise: z
        .string()
        .trim()
        .min(1)
        .meta({ description: 'A lift to compare against bodyweight, e.g. "Bench Press". Optional.' })
        .optional(),
    })
    .strict(),
  replace_content: z
    .object({
      doc,
      version: z.string().min(1).meta({ description: 'The `version` get_content returned with the document.' }),
      // Deliberately loose: each document's full schema would cost thousands of
      // characters in tools/list for a rarely used tool. The handler validates.
      document: z.looseObject({}).meta({ description: 'The complete document.' }),
    })
    .strict(),
  revise_workout_plan: revisePlanArgs,
  list_reflections: z
    .object({
      type: z.enum(REFLECTION_TYPES).meta({ description: 'Optional; omit for both.' }).optional(),
      from: fromDate,
      to: toDate,
      theme: themeTag.meta({ description: 'Only notes with this theme tag, e.g. "sleep". Optional.' }).optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(REFLECTION_LIST_MAX_LIMIT)
        .meta({ description: `Optional; defaults to ${REFLECTION_LIST_DEFAULT_LIMIT}.` })
        .optional(),
    })
    .strict(),
  add_reflection: addReflectionSchema,
  update_reflection: updateReflectionSchema,
  list_health_log: listHealthLogSchema,
  add_health_note: addHealthNoteSchema,
  update_health_log: updateHealthLogSchema,
} satisfies Record<string, z.ZodType>;

export type ToolName = keyof typeof TOOL_ARGS;
export type ToolArgs<N extends ToolName> = z.output<(typeof TOOL_ARGS)[N]>;

/**
 * The JSON Schema `tools/list` advertises for one tool. Input-side (`io:
 * 'input'`), since it describes what a caller sends, before any transform; the
 * `$schema` key is dropped, as it is the same on every tool and costs tokens.
 */
export function inputSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return json;
}
