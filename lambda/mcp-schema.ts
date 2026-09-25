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

const NO_ARGS: Record<string, unknown> = { type: 'object', properties: {}, additionalProperties: false };

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
    date: { type: 'string', description: 'A single day, ISO YYYY-MM-DD. Simplest and cheapest form.' },
    from: { type: 'string', description: 'Inclusive start date, ISO YYYY-MM-DD. Use with `to` for a range.' },
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
        'The exercise, e.g. "Bench Press". Matched leniently — a partial or ' +
        'Japanese name resolves to the canonical one, and an unrecognised name ' +
        'comes back with candidates rather than an empty history. Call ' +
        'list_exercises for the exact vocabulary.',
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
    muscle: {
      type: 'string',
      description: 'Restrict to one muscle group, e.g. "Chest". Optional; omit for every exercise.',
    },
  },
  additionalProperties: false,
};

/**
 * The plan read is four lookups behind one tool: the arguments are mutually
 * exclusive, and omitting them all asks for the program in force today.
 */
const PLAN_READ_ARGS: Record<string, unknown> = {
  type: 'object',
  properties: {
    planId: { type: 'string', description: 'Which program. Optional; defaults to the only one, "upper-lower".' },
    version: { type: 'integer', description: 'A specific version number. Optional; omit for the current one.' },
    date: {
      type: 'string',
      description: 'ISO YYYY-MM-DD — return the version that was in force that day. Optional.',
    },
    history: {
      type: 'boolean',
      description: 'True to list every version as metadata only (no session detail). Optional.',
    },
  },
  additionalProperties: false,
};

const MUSCLE_VOLUME_ARGS: Record<string, unknown> = {
  type: 'object',
  properties: {
    window: {
      type: 'integer',
      description:
        'Length of the trailing window in days, ending now. Optional; defaults to 7. The weekly ' +
        'targets are scaled to it, so a 14-day window is judged against a fortnight\'s worth.',
    },
    planId: { type: 'string', description: 'Which program. Optional; defaults to "upper-lower".' },
  },
  additionalProperties: false,
};

/** A full-document write tool input: the document itself, validated server-side. */
const documentArgs = (label: string): Record<string, unknown> => ({
  type: 'object',
  description:
    `The complete ${label} document, same shape returned by the matching get_ tool. ` +
    'Send the whole document, never a partial diff — it replaces the stored one.',
  additionalProperties: true,
});

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Publishing a plan version appends rather than replaces, so repeating the call
// is refused rather than absorbed — not idempotent, and not destructive either.
const appendAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export const TOOL_SPECS: readonly McpToolSpec[] = [
  {
    name: 'get_cv',
    title: 'Get CV',
    description: "Read the portfolio owner's CV document (personal info, summary, skills, experience, qualifications, education).",
    requiresAuth: false,
    inputSchema: NO_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_projects',
    title: 'Get projects',
    description: 'Read the projects document (the portfolio project list).',
    requiresAuth: false,
    inputSchema: NO_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_blog',
    title: 'Get blog',
    description: 'Read the blog document (all blog posts with their markdown content).',
    requiresAuth: false,
    inputSchema: NO_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_home',
    title: 'Get home',
    description: 'Read the home-page document (the hero mottoes and background photos).',
    requiresAuth: false,
    inputSchema: NO_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_workout',
    title: 'Get workout summary',
    description:
      'Read the aggregated workout/strength summary: per-day volume, per-muscle sets, top exercises and estimated-1RM progression over an optional date range.',
    requiresAuth: false,
    inputSchema: DATE_RANGE_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_activity',
    title: 'Get activity feed',
    description:
      'Read the merged activity feed (GitHub contributions, blog posts and gym sessions) for the home-page calendar, over an optional date range.',
    requiresAuth: false,
    inputSchema: DATE_RANGE_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'list_media',
    title: 'List media',
    description: 'List the media asset catalogue (uploaded images and their metadata). Admin only.',
    requiresAuth: true,
    inputSchema: NO_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_workout_sets',
    title: 'Get workout sets',
    description:
      'The individual logged sets for a day (or a span of at most 31 days): per-set exercise, ' +
      'weight, reps, volume, muscle group and free-text note. This is the raw training detail ' +
      'behind the aggregates get_workout returns. Admin only.',
    requiresAuth: true,
    inputSchema: SETS_RANGE_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'list_exercises',
    title: 'List exercises',
    description:
      'The training log\'s exercise vocabulary: every movement ever logged, with its muscle group, ' +
      'set and session counts, date range and all-time bests, most-trained first. Call this to ' +
      'learn the exact names get_exercise_history expects. Admin only.',
    requiresAuth: true,
    inputSchema: EXERCISE_LIST_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_exercise_history',
    title: 'Get exercise history',
    description:
      'Every logged set of a single exercise, in date order, with that lift\'s all-time bests. ' +
      'This is the tool for progression questions about one movement ("how has my bench moved ' +
      'this year") — get_workout_sets answers the same question only by returning every ' +
      'exercise on every day in the span. Admin only.',
    requiresAuth: true,
    inputSchema: EXERCISE_HISTORY_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_workout_plan',
    title: 'Get training plan',
    description:
      'Read the training program: the prescribed sessions, exercise slots, set/rep/RPE ranges and ' +
      'weekly set targets. This is the plan, not the log — get_workout_sets returns what was ' +
      'actually lifted. Returns the current version by default; pass `version` for a specific one, ' +
      '`date` for whichever was in force that day, or `history: true` to list all versions. ' +
      'The menu and the weekly set targets are versioned separately and composed here into one ' +
      'document; `targetsVersion` says which target set was used. Each weekly set target is ' +
      '{muscles, sets: {min, max}, bonusWeekSets, maintenanceSets}: `sets` is the hypertrophy range, ' +
      'and `maintenanceSets` is the maintenance floor, which runs up to `sets.min`; it is null, or ' +
      'absent on target sets stored before it existed, where no floor is declared. Admin only.',
    requiresAuth: true,
    inputSchema: PLAN_READ_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'get_muscle_volume_status',
    title: 'Get muscle volume status',
    description:
      'Whether each muscle is under, maintaining, in range or over its target training volume right now. ' +
      '"maintenance" means at or above the target\'s maintenance floor but below its hypertrophy range; ' +
      'targets without a floor report "under" there instead. This ' +
      'is the one place that judgement is computed: it rolls the logged sets up over a trailing ' +
      'window (7 days by default, ending at the moment of the call) and compares them against the ' +
      'CURRENT plan version\'s weekly set targets, read fresh on every call. Prefer it to working ' +
      'the answer out from get_workout and get_workout_plan — done by hand those two disagree ' +
      'about the window and, historically, about the targets themselves. The response carries ' +
      '`asOf` because a trailing window moves: two calls an hour apart legitimately differ, and ' +
      '`asOf` is how they are reconciled. Admin only.',
    requiresAuth: true,
    inputSchema: MUSCLE_VOLUME_ARGS,
    annotations: readAnnotations,
  },
  {
    name: 'update_cv',
    title: 'Update CV',
    description: 'Replace the CV document. Admin only. Validated server-side; an invalid document is rejected unchanged.',
    requiresAuth: true,
    inputSchema: documentArgs('CV'),
    annotations: writeAnnotations,
  },
  {
    name: 'update_projects',
    title: 'Update projects',
    description: 'Replace the projects document. Admin only. Validated server-side.',
    requiresAuth: true,
    inputSchema: documentArgs('projects'),
    annotations: writeAnnotations,
  },
  {
    name: 'update_blog',
    title: 'Update blog',
    description: 'Replace the blog document. Admin only. Validated server-side.',
    requiresAuth: true,
    inputSchema: documentArgs('blog'),
    annotations: writeAnnotations,
  },
  {
    name: 'update_home',
    title: 'Update home',
    description: 'Replace the home-page document (hero mottoes and background photos). Admin only. Validated server-side. ' +
      'Each background is { url, caption, alt? }: url is a media asset URL (prefer its w2560 variant, from list_media), ' +
      'caption is shown on the hero (usually where the photo was taken), alt describes the image.',
    requiresAuth: true,
    inputSchema: documentArgs('home'),
    annotations: writeAnnotations,
  },
  {
    name: 'update_media',
    title: 'Update media metadata',
    description:
      'Edit the alt text, title and/or category of an existing media asset. Admin only. Requires assetId plus at least one field to change.',
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'The assetId of the media row to edit.' },
        alt: { type: 'string', description: 'Alt text. Optional.' },
        title: { type: 'string', description: 'Display title. Optional.' },
        category: { type: 'string', enum: ['blog', 'project', 'general'], description: 'Asset category. Optional.' },
      },
      required: ['assetId'],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
  },
  {
    name: 'update_workout_plan',
    title: 'Publish training plan version',
    description:
      'Publish a NEW version of the training program. Versions are immutable: this appends, it ' +
      'never edits or replaces an existing one, so the plan a past session was run under stays ' +
      'readable. Call get_workout_plan first, send the whole document back with `version` set to ' +
      'the next number, and omit `createdAt` (the server stamps it). Re-sending an existing ' +
      'version is refused with the next free number. Admin only; validated server-side.',
    requiresAuth: true,
    /**
     * Unlike the other document writes, this one names its fields and their
     * types. Those writes take free-form documents whose shape only the server
     * knows, so a loose schema costs nothing. A plan version does not: it is
     * strongly typed server-side, and a client that has only been told "an
     * object" has no way to know `version` is a number and `sessions` an array.
     * A client that guessed strings had its publish rejected field by field with
     * nothing written — a round trip wasted on a shape we could simply state.
     */
    inputSchema: {
      type: 'object',
      description:
        'A complete plan-version document, same shape get_workout_plan returns, with `version` ' +
        'incremented. Partial documents are rejected — this is a whole-version publish. This ' +
        'publishes the MENU only: any `weeklySetTargets` sent is ignored (the response says so), ' +
        'because targets are versioned separately — use revise_workout_plan with a set-target ' +
        'edit. The menu is refused if its sessions would prescribe more weekly volume than the ' +
        'current targets allow.',
      properties: {
        planId: { type: 'string', description: 'Lower-kebab slug, e.g. "upper-lower".' },
        version: { type: 'integer', description: 'The next version number; publishing an existing one is refused.' },
        name: { type: 'string' },
        sessionsPerWeek: { type: 'integer', description: 'Sessions the rotation assumes per week, excluding bonus sessions.' },
        rotation: { type: 'array', items: { type: 'string' }, description: 'Session ids in performed order.' },
        bonusSessions: { type: 'array', items: { type: 'string' }, description: 'Session ids added only on weeks allowing an extra visit.' },
        sessions: { type: 'array', items: { type: 'object' }, description: 'The prescribed sessions, each with its exercise slots.' },
        weeklySetTargets: {
          type: 'array',
          description:
            'Declared sets per muscle per week: [{muscles: [...], sets: {min, max}, bonusWeekSets: {min, max}|null, maintenanceSets: number|null}]. ' +
            'These are what get_muscle_volume_status judges actual volume against, so they are the ' +
            'canonical target ranges — no consumer should keep its own copy. IGNORED on this ' +
            'tool: change them with revise_workout_plan instead.',
          items: { type: 'object' },
        },
        effectiveFrom: { type: ['string', 'null'], description: 'ISO YYYY-MM-DD, or null for open-ended.' },
        effectiveTo: { type: ['string', 'null'], description: 'ISO YYYY-MM-DD, or null while current.' },
        notes: { type: 'string' },
        changeNote: { type: 'string', description: 'Why this version differs from the one before it.' },
      },
      required: ['planId', 'version', 'name', 'sessionsPerWeek', 'rotation', 'bonusSessions', 'sessions'],
      additionalProperties: true,
    },
    annotations: appendAnnotations,
  },
  {
    name: 'revise_workout_plan',
    title: 'Revise training plan',
    description:
      'Change specific exercise slots, or the weekly set targets, in the current training program without resending the whole ' +
      'document. Reads the current version, applies the edits, and publishes the result as the next ' +
      'version — nothing already stored is modified. Each edit is {op: "patch"|"add"|"remove", ' +
      'session, order} where `session` is a session id (e.g. "upper-a") and `order` is the slot\'s ' +
      'position; a patch carries only the fields to change. Use {op: "set-target", target: {...}} to ' +
      'set a weekly set target and {op: "remove-target", muscles: [...]} to drop one — the targets are ' +
      'what get_muscle_volume_status judges against, so changing one here is how that judgement changes ' +
      'everywhere at once. The two op families write two separately-versioned documents (the menu and ' +
      'the targets) and a revision carrying both is applied as one transaction; the response reports ' +
      '`version` and `targetsVersion` for whichever halves changed. A revision is refused if it would ' +
      'leave the menu prescribing more volume than the targets allow. `changeNote` is required. Pass ' +
      '`baseVersion` (from get_workout_plan) so the edits are refused if the plan moved underneath ' +
      'them. Use update_workout_plan instead to publish a whole new program. Admin only.',
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Which program. Optional; defaults to "upper-lower".' },
        baseVersion: {
          type: 'integer',
          description: 'The menu version these edits were written against. Optional but recommended: the revision is refused if the current version differs.',
        },
        baseTargetsVersion: {
          type: 'integer',
          description: 'The targets version these edits were written against, from get_workout_plan\'s `targetsVersion`. Optional; 0 means "no target set published yet". Same guard as baseVersion, on the targets\' own sequence.',
        },
        changeNote: { type: 'string', description: 'Required. What changed and why — this is the version history.' },
        name: { type: 'string', description: 'Rename the program. Optional.' },
        effectiveFrom: { type: ['string', 'null'], description: 'ISO YYYY-MM-DD, or null. Optional; carried over when omitted.' },
        effectiveTo: { type: ['string', 'null'], description: 'ISO YYYY-MM-DD, or null. Optional; carried over when omitted.' },
        edits: {
          type: 'array',
          minItems: 1,
          description: 'Applied in order; any edit that does not resolve rejects the whole revision.',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['patch', 'add', 'remove', 'set-target', 'remove-target'] },
              session: { type: 'string', description: 'Session id, e.g. "upper-a". Required for patch, add and remove; not used by the target ops.' },
              order: { type: 'integer', description: 'Slot position. Required for patch and remove.' },
              changes: { type: 'object', description: 'For patch: only the slot fields to change (sets, reps, rpe, options, muscle, notes).' },
              exercise: { type: 'object', description: 'For add: the complete new slot, including the order to insert it at. Slots at or after that position shift down.' },
              target: {
                type: 'object',
                description:
                  'For set-target: a weekly set target, {muscles: [...], sets: {min, max}, bonusWeekSets: {min, max}|null, maintenanceSets: number|null}. ' +
                  '`sets` is the hypertrophy range; `maintenanceSets` is the maintenance floor, which must be below `sets.min` ' +
                  '(maintenance runs from it up to where hypertrophy begins). ' +
                  'Replaces the entry covering exactly those muscles, or adds one. `bonusWeekSets` and `maintenanceSets` may be omitted for null. ' +
                  'An entry spanning several muscles (e.g. glutes + hamstrings) is addressed by naming all of them.',
                properties: {
                  muscles: { type: 'array', items: { type: 'string' }, minItems: 1 },
                  sets: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } }, required: ['min', 'max'] },
                  bonusWeekSets: { type: ['object', 'null'], properties: { min: { type: 'number' }, max: { type: 'number' } } },
                  maintenanceSets: { type: ['number', 'null'], description: 'Weekly maintenance floor; must be below sets.min.' },
                },
                required: ['muscles', 'sets'],
              },
              muscles: {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
                description: 'For remove-target: the exact muscle set of the entry to drop.',
              },
            },
            required: ['op'],
          },
        },
      },
      required: ['changeNote', 'edits'],
      additionalProperties: false,
    },
    annotations: appendAnnotations,
  },
  {
    name: 'list_reflections',
    title: 'List reflection notes',
    description:
      'Read the owner\'s private reflection notes, newest first. `type` is "workout" (how a ' +
      'training session went) or "life" (higher-level notes on how things are going generally); ' +
      'omit it to read both. Call this BEFORE add_reflection — read the last few notes of the ' +
      'same type so the new one can build on them (recurring themes, what changed since) rather ' +
      'than starting cold. Also the tool for "what patterns keep coming up?": read a window and ' +
      'look across the notes. A workout note\'s `date` is the session day, so it lines up with ' +
      'get_workout_sets for that date. Admin only.',
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...REFLECTION_TYPES], description: 'Which kind. Optional; omit for all.' },
        from: { type: 'string', description: 'Inclusive start date, ISO YYYY-MM-DD. Optional.' },
        to: { type: 'string', description: 'Inclusive end date, ISO YYYY-MM-DD. Optional.' },
        theme: { type: 'string', description: 'Only notes tagged with this theme, an English tag such as "sleep". Optional.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: REFLECTION_LIST_MAX_LIMIT,
          description: `Most notes to return. Optional; defaults to ${REFLECTION_LIST_DEFAULT_LIMIT}.`,
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
      'Save a reflection note from the current conversation. Always appends a new note; it never ' +
      'replaces one, so call it once per reflection. Write `body` as a concise summary in the ' +
      'owner\'s own framing, in the language the conversation was held in — keep one or two of ' +
      'their actual phrases verbatim and untranslated, since a summary cannot be un-summarised ' +
      'later. Put the recurring threads in `themes` as short lowercase ENGLISH tags whatever the ' +
      'body\'s language (e.g. "sleep", "shoulder", "work-stress"; never "睡眠"), reusing tags from ' +
      'earlier notes where they fit so they can be followed over time — a non-English tag is ' +
      'refused. `date` is the day the note is about, in ' +
      'the owner\'s local calendar (for a workout, the session day). Call list_reflections first. ' +
      'Admin only.',
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...REFLECTION_TYPES], description: '"workout" or "life".' },
        date: { type: 'string', description: 'ISO YYYY-MM-DD, the day the note is about.' },
        body: { type: 'string', maxLength: REFLECTION_BODY_MAX, description: 'The reflection itself.' },
        themes: {
          type: 'array',
          items: { type: 'string' },
          maxItems: REFLECTION_THEMES_MAX,
          description: 'Short lowercase English tags for the recurring threads, e.g. "sleep", "lower-back". Optional.',
        },
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
      'Correct the body and/or themes of an existing reflection, addressed by `type` and the `id` ' +
      'list_reflections returned. For fixing a note, not for adding to it — a new thought is a ' +
      'new note via add_reflection. The type and date cannot change. Admin only.',
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...REFLECTION_TYPES] },
        id: { type: 'string', description: 'The note\'s id, exactly as list_reflections returned it.' },
        body: { type: 'string', maxLength: REFLECTION_BODY_MAX, description: 'Replacement body. Optional.' },
        themes: {
          type: 'array',
          items: { type: 'string' },
          maxItems: REFLECTION_THEMES_MAX,
          description: 'Replacement themes (the whole list), lowercase English tags. Optional.',
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
