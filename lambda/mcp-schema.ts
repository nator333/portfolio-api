import { z } from 'zod';
import {
  REFLECTION_BODY_MAX,
  REFLECTION_LIST_DEFAULT_LIMIT,
  REFLECTION_LIST_MAX_LIMIT,
  REFLECTION_THEMES_MAX,
  REFLECTION_TYPES,
} from './reflection-schema';

/**
 * Declarative side of the Model Context Protocol server that fronts this API.
 *
 * The transport, dispatch and (crucially) the write-authorization gate live in
 * mcp.ts; this module is the part with no AWS or handler dependencies, so the
 * tool catalogue and the JSON-RPC envelope can be asserted in isolation.
 */

/**
 * Protocol revision we implement. `initialize` echoes the client's requested
 * version when it sends one (maximising interop), and falls back to this.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const MCP_SERVER_INFO = {
  name: 'portfolio-api',
  version: '0.1.0',
} as const;

/**
 * JSON-RPC 2.0 request envelope. A request carries an `id`; a notification
 * (e.g. `notifications/initialized`) omits it, which is how the handler decides
 * whether a response body is owed. `params` is left loose here — each method
 * validates its own shape.
 */
export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

/** JSON-RPC error codes we return; -32000 onwards is the reserved server range. */
export const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * A tool the MCP server advertises. `requiresAuth` is the single source of
 * truth for the write gate: any tool marked true is refused unless the caller
 * presents a verified admin Cognito ID token (see mcp.ts). The `inputSchema` is
 * the JSON Schema surfaced to clients in `tools/list`; the real validation is
 * the zod schema inside the delegated handler, so the update tools keep a loose
 * object schema rather than restating the full document shape here — the same
 * trade-off the /agent Lambda already makes.
 */
export interface McpToolSpec {
  name: string;
  title: string;
  description: string;
  requiresAuth: boolean;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const DATE_RANGE_ARGS: Record<string, unknown> = {
  type: 'object',
  properties: {
    from: { type: 'string', description: 'Inclusive start date, ISO YYYY-MM-DD. Optional.' },
    to: { type: 'string', description: 'Inclusive end date, ISO YYYY-MM-DD. Optional.' },
  },
  additionalProperties: false,
};

/**
 * The sets table is partitioned by date, so a span costs one query per day in
 * it. The tool advertises the single-day shorthand first for that reason.
 */
const SETS_RANGE_ARGS: Record<string, unknown> = {
  type: 'object',
  properties: {
    date: { type: 'string', description: 'A single day, ISO YYYY-MM-DD. Cheapest form.' },
    from: { type: 'string', description: 'Inclusive start date, ISO YYYY-MM-DD.' },
    to: { type: 'string', description: 'Inclusive end date, ISO YYYY-MM-DD. At most 31 days from `from`.' },
  },
  additionalProperties: false,
};

/**
 * The lift-scoped counterpart to SETS_RANGE_ARGS. There is no span cap here:
 * the exercise-date index makes one lift's history a single query however wide
 * the window, so the only ceiling is on how much comes back at once.
 */
const EXERCISE_HISTORY_ARGS: Record<string, unknown> = {
  type: 'object',
  properties: {
    exercise: {
      type: 'string',
      description:
        'e.g. "Bench Press". Partial or Japanese names resolve; an unknown name returns candidates.',
    },
    from: { type: 'string', description: 'Inclusive start date, ISO YYYY-MM-DD. Optional.' },
    to: { type: 'string', description: 'Inclusive end date, ISO YYYY-MM-DD. Optional.' },
  },
  required: ['exercise'],
  additionalProperties: false,
};

const EXERCISE_LIST_ARGS: Record<string, unknown> = {
  type: 'object',
  properties: {
    muscle: { type: 'string', description: 'Restrict to one muscle group, e.g. "Chest". Optional.' },
  },
  additionalProperties: false,
};

const PLAN_ID_ARG = { type: 'string', description: 'Which program. Optional; defaults to "upper-lower".' };

/**
 * The plan read is four lookups behind one tool: the arguments are mutually
 * exclusive, and omitting them all asks for the program in force today.
 */
const PLAN_READ_ARGS: Record<string, unknown> = {
  type: 'object',
  properties: {
    planId: PLAN_ID_ARG,
    version: { type: 'integer', description: 'A specific version. Optional.' },
    date: { type: 'string', description: 'ISO YYYY-MM-DD: the version in force that day. Optional.' },
    history: { type: 'boolean', description: 'True to list every version as metadata only. Optional.' },
  },
  additionalProperties: false,
};

const MUSCLE_VOLUME_ARGS: Record<string, unknown> = {
  type: 'object',
  properties: {
    window: {
      type: 'integer',
      description: 'Trailing window in days, ending now. Optional; defaults to 7. Targets are scaled to it.',
    },
    planId: PLAN_ID_ARG,
  },
  additionalProperties: false,
};

/**
 * The four site documents share one read and one write tool, keyed by `doc`.
 * Each was its own pair of tools once; eight near-identical entries in
 * tools/list cost every conversation context for no extra capability. mcp.ts
 * maps each name to its own handler, so validation is unchanged.
 */
export const CONTENT_DOCS = ['cv', 'projects', 'blog', 'home'] as const;

const CONTENT_DOC_ARG = {
  type: 'string',
  enum: [...CONTENT_DOCS],
  description:
    'cv: personal info, summary, skills, experience, education. projects: the project list. ' +
    'blog: every post with its markdown. home: hero mottoes and background photos.',
};

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Publishing a plan version appends rather than replaces, so repeating the call
// is refused rather than absorbed — not idempotent, and not destructive either.
const appendAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** A weekly set target as the plan stores it; shared by the whole-plan and edit forms. */
const WEEKLY_SET_TARGET_SHAPE =
  '{muscles: [...], sets: {min, max}, bonusWeekSets: {min, max}|null, maintenanceSets: number|null}';

export const TOOL_SPECS: readonly McpToolSpec[] = [
  {
    name: 'get_content',
    title: 'Get site content',
    description: 'Read one of the public site documents.',
    requiresAuth: false,
    inputSchema: {
      type: 'object',
      properties: { doc: CONTENT_DOC_ARG },
      required: ['doc'],
      additionalProperties: false,
    },
    annotations: readAnnotations,
  },
  {
    name: 'get_workout',
    title: 'Get workout summary',
    description:
      'Aggregated training summary: per-day volume, per-muscle sets, top exercises and estimated-1RM progression.',
    requiresAuth: false,
    inputSchema: DATE_RANGE_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_workout_sets',
    title: 'Get workout sets',
    description:
      'Every logged set for a day or span: exercise, weight, reps, volume, muscle and note. Admin only.',
    requiresAuth: true,
    inputSchema: SETS_RANGE_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'list_exercises',
    title: 'List exercises',
    description:
      'Every exercise ever logged, with muscle group, set and session counts, date range and all-time bests. Admin only.',
    requiresAuth: true,
    inputSchema: EXERCISE_LIST_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_exercise_history',
    title: 'Get exercise history',
    description:
      'Every logged set of one exercise in date order, with its all-time bests. Use for progression ' +
      'questions about a single lift. Admin only.',
    requiresAuth: true,
    inputSchema: EXERCISE_HISTORY_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_workout_plan',
    title: 'Get training plan',
    description:
      'The training program (the plan, not the log): sessions, exercise slots, set/rep/RPE ranges and ' +
      `weekly set targets, each ${WEEKLY_SET_TARGET_SHAPE}. \`sets\` is the hypertrophy range; ` +
      '`maintenanceSets` is the floor below it (null when none). The menu and targets are versioned ' +
      'separately; `targetsVersion` names the target set used. Admin only.',
    requiresAuth: true,
    inputSchema: PLAN_READ_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_muscle_volume_status',
    title: 'Get muscle volume status',
    description:
      'Whether each muscle is under, maintenance, in range or over its weekly set target, over a ' +
      'trailing window ending now and against the current plan\'s targets. Use this rather than ' +
      'comparing get_workout with get_workout_plan yourself. `asOf` is when the window ended. Admin only.',
    requiresAuth: true,
    inputSchema: MUSCLE_VOLUME_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_readiness',
    title: 'Get training readiness',
    description:
      'Whether today is a "push", "normal" or "easy" day, from last night\'s sleep, HRV and resting ' +
      'heart rate against a 28-day baseline, read live from Google Health. An older night is never ' +
      'substituted: `status` "not_synced" means ask the owner to sync the Fitbit app, "pending" means ' +
      'try again in a few minutes, and "insufficient_baseline" means under 7 days of HRV. In those ' +
      'cases `verdict` is null; do not make one up. Admin only.',
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'The owner\'s local day, ISO YYYY-MM-DD. Optional; defaults to today.' },
      },
      additionalProperties: false,
    },
    // Read-only, but unlike every other read it reaches outside this API.
    annotations: { ...readAnnotations, openWorldHint: true },
  },
  {
    name: 'get_training_recommendation',
    title: 'Get today\'s training recommendation',
    description:
      'What to train today and how hard: the plan session that best covers muscles behind on volume ' +
      '(`alternatives` ranks the rest), with each slot restated for today\'s readiness. It never ' +
      'prescribes more than the plan. When readiness has no verdict, `prescription` is null; do not ' +
      'fill it in. `restSuggested` is true on an easy day with nothing behind. Admin only.',
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: { planId: PLAN_ID_ARG },
      additionalProperties: false,
    },
    // Reaches the Google Health API through its readiness half.
    annotations: { ...readAnnotations, openWorldHint: true },
  },
  {
    name: 'get_weight_trend',
    title: 'Get bodyweight trend',
    description:
      'Bodyweight from the smart scale, read live from Google Health. Daily readings swing 1-2 kg, so ' +
      'report `latest.trendKg`/`trendLb` (7-day mean) and `rate` (28-day fit per week, with `pace`), ' +
      'not a single reading. If `latest.stale` is true, say the data is old. `bodyFat` is included ' +
      'when measured. Pass `exercise` for `relativeStrength` (estimated 1RM over bodyweight). Admin only.',
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 14,
          maximum: 365,
          description: 'Window in days, ending today. Optional; defaults to 90.',
        },
        exercise: { type: 'string', description: 'A lift to compare against bodyweight, e.g. "Bench Press". Optional.' },
      },
      additionalProperties: false,
    },
    // Read-only, but reaches the Google Health API.
    annotations: { ...readAnnotations, openWorldHint: true },
  },
  {
    name: 'update_content',
    title: 'Update site content',
    description:
      'Replace one site document. Send the whole document, as get_content returns it; it is validated ' +
      'and an invalid one is rejected unchanged. A home background is {url, caption, alt?}. Admin only.',
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: {
        doc: CONTENT_DOC_ARG,
        document: { type: 'object', description: 'The complete document.', additionalProperties: true },
      },
      required: ['doc', 'document'],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
  },
  /**
   * One tool for both ways of publishing a plan version: `edits` against the
   * current version, or a whole `plan` document. They were two tools, and the
   * whole-document one was rarely right; keeping it as an argument here halves
   * the plan-writing surface in tools/list. mcp.ts routes `plan` to the
   * whole-version handler, so both paths keep their own validation.
   *
   * The `plan` schema still names its fields and types: a plan version is
   * strongly typed server-side, and a client told only "an object" once guessed
   * strings and had its publish rejected field by field.
   */
  {
    name: 'revise_workout_plan',
    title: 'Revise training plan',
    description:
      'Publish the next version of the training program; stored versions are never modified. Send ' +
      '`edits` to change slots or weekly set targets in the current version, or `plan` to publish a ' +
      'whole new program, not both. A version is refused if its menu prescribes more volume than ' +
      'the targets allow. Admin only.',
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: {
        changeNote: { type: 'string', description: 'What changed and why. This is the version history.' },
        edits: {
          type: 'array',
          minItems: 1,
          description: 'Applied in order; if any edit does not resolve, nothing is written.',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['patch', 'add', 'remove', 'set-target', 'remove-target'] },
              session: { type: 'string', description: 'Session id, e.g. "upper-a". For patch, add and remove.' },
              order: { type: 'integer', description: 'Slot position. For patch and remove.' },
              changes: { type: 'object', description: 'patch: only the slot fields to change (sets, reps, rpe, options, muscle, notes).' },
              exercise: { type: 'object', description: 'add: the complete new slot, including its order. Later slots shift down.' },
              target: {
                type: 'object',
                description:
                  `set-target: ${WEEKLY_SET_TARGET_SHAPE}. Replaces the entry for exactly those muscles, or adds one. ` +
                  '`maintenanceSets` must be below `sets.min`.',
                properties: {
                  muscles: { type: 'array', items: { type: 'string' }, minItems: 1 },
                  sets: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } }, required: ['min', 'max'] },
                  bonusWeekSets: { type: ['object', 'null'], properties: { min: { type: 'number' }, max: { type: 'number' } } },
                  maintenanceSets: { type: ['number', 'null'] },
                },
                required: ['muscles', 'sets'],
              },
              muscles: {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
                description: 'remove-target: the exact muscle set of the entry to drop.',
              },
            },
            required: ['op'],
          },
        },
        planId: PLAN_ID_ARG,
        baseVersion: {
          type: 'integer',
          description: 'With edits: the menu version they were written against; refused if the plan has moved.',
        },
        baseTargetsVersion: {
          type: 'integer',
          description: 'With edits: the `targetsVersion` they were written against (0 if none yet). Same guard.',
        },
        name: { type: 'string', description: 'With edits: rename the program.' },
        effectiveFrom: { type: ['string', 'null'], description: 'With edits: ISO YYYY-MM-DD or null. Carried over when omitted.' },
        effectiveTo: { type: ['string', 'null'], description: 'With edits: ISO YYYY-MM-DD or null. Carried over when omitted.' },
        plan: {
          type: 'object',
          description:
            'A complete plan version, as get_workout_plan returns it, with `version` set to the next ' +
            'number and no `createdAt`. This publishes the menu only: its `weeklySetTargets` are ' +
            'ignored, so change targets with set-target edits.',
          properties: {
            planId: { type: 'string' },
            version: { type: 'integer' },
            name: { type: 'string' },
            sessionsPerWeek: { type: 'integer', description: 'Excluding bonus sessions.' },
            rotation: { type: 'array', items: { type: 'string' }, description: 'Session ids in performed order.' },
            bonusSessions: { type: 'array', items: { type: 'string' } },
            sessions: { type: 'array', items: { type: 'object' } },
            effectiveFrom: { type: ['string', 'null'] },
            effectiveTo: { type: ['string', 'null'] },
            notes: { type: 'string' },
          },
          required: ['planId', 'version', 'name', 'sessionsPerWeek', 'rotation', 'bonusSessions', 'sessions'],
          additionalProperties: true,
        },
      },
      required: ['changeNote'],
      additionalProperties: false,
    },
    annotations: appendAnnotations,
  },
  {
    name: 'list_reflections',
    title: 'List reflection notes',
    description:
      'The owner\'s private reflection notes, newest first: "workout" (a session) or "life" (how ' +
      'things are going). Read the last few of the same type before add_reflection so the new note ' +
      'builds on them. A workout note\'s `date` is the session day. Admin only.',
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...REFLECTION_TYPES], description: 'Optional; omit for both.' },
        from: { type: 'string', description: 'Inclusive start date, ISO YYYY-MM-DD. Optional.' },
        to: { type: 'string', description: 'Inclusive end date, ISO YYYY-MM-DD. Optional.' },
        theme: { type: 'string', description: 'Only notes with this theme tag, e.g. "sleep". Optional.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: REFLECTION_LIST_MAX_LIMIT,
          description: `Optional; defaults to ${REFLECTION_LIST_DEFAULT_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
    annotations: readAnnotations,
  },
  {
    name: 'add_reflection',
    title: 'Add reflection note',
    description:
      'Save a new reflection note from this conversation; it always appends. Write `body` as a concise ' +
      'summary in the conversation\'s language, keeping one or two of the owner\'s own phrases ' +
      'verbatim. `themes` are short lowercase ENGLISH tags whatever the language (e.g. "sleep", ' +
      '"work-stress"); reuse earlier tags where they fit. Non-English tags are refused. `date` is ' +
      'the day the note is about, in the owner\'s calendar. A "workout" note is summarised in one ' +
      'line on the PUBLIC site, so keep it to the training itself; health, injuries, mood, work and ' +
      'personal life go in a "life" note, which is never published. Admin only.',
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...REFLECTION_TYPES] },
        date: { type: 'string', description: 'ISO YYYY-MM-DD.' },
        body: { type: 'string', maxLength: REFLECTION_BODY_MAX },
        themes: { type: 'array', items: { type: 'string' }, maxItems: REFLECTION_THEMES_MAX },
      },
      required: ['type', 'date', 'body'],
      additionalProperties: false,
    },
    annotations: appendAnnotations,
  },
  {
    name: 'update_reflection',
    title: 'Correct reflection note',
    description:
      'Correct the body and/or themes of an existing note, by `type` and the `id` from ' +
      'list_reflections. A new thought is a new note, not a correction. Type and date cannot ' +
      'change. The add_reflection rule on workout notes applies. Admin only.',
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...REFLECTION_TYPES] },
        id: { type: 'string' },
        body: { type: 'string', maxLength: REFLECTION_BODY_MAX, description: 'Replacement body. Optional.' },
        themes: {
          type: 'array',
          items: { type: 'string' },
          maxItems: REFLECTION_THEMES_MAX,
          description: 'Replacement list of tags. Optional.',
        },
      },
      required: ['type', 'id'],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
  },
] as const;

export const TOOL_SPECS_BY_NAME: ReadonlyMap<string, McpToolSpec> = new Map(
  TOOL_SPECS.map((spec) => [spec.name, spec]),
);
