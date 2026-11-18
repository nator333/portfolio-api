import { z } from 'zod';
import { HEALTH_LIST_DEFAULT_DAYS } from './health-log-schema';
import { TOOL_ARGS, inputSchemaOf } from './mcp-args';

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
 * Server-wide guidance, sent once in `initialize` rather than repeated in
 * every tool description: what the write verbs mean, and how to read an error.
 */
export const MCP_INSTRUCTIONS =
  'Write tools: add_* appends and never changes what exists; update_* is a merge patch (omitted ' +
  'fields unchanged, null clears); replace_* swaps a whole document and needs the version you ' +
  'read; revise_* publishes a new version. Every failure, whole (isError) or partial (an `error` ' +
  'inside a successful result), is {code, message, retry, fix?, details?}. Act on `retry`: ' +
  '"now" may retry once; "after_reread" read again, reapply, retry; "after_fix" change the call ' +
  'first (details.issues names the fields); "owner_action" stop and tell the owner `fix`; ' +
  '"never" do not retry, report it. Do not guess around an error or present it as data.';

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
 * the JSON Schema surfaced to clients in `tools/list`, generated from the same
 * zod schema (TOOL_ARGS in mcp-args.ts) that tools/call validates against, so
 * the two cannot drift.
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

export { CONTENT_DOCS } from './mcp-args';

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Publishing a plan version appends rather than replaces, so repeating the call
// is refused rather than absorbed — not idempotent, and not destructive either.
const appendAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// replace_*: the whole stored document is swapped for the one sent. Repeating it
// is harmless, but anything left out of the document is gone.
const replaceAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

/**
 * The write verbs, one meaning each, so a tool's name says what it does to
 * what is already there:
 *
 *   add_*      creates a new item or appends; never changes existing content.
 *   update_*   a partial update with JSON Merge Patch (RFC 7386) semantics:
 *              an omitted field is unchanged, null clears it, objects merge,
 *              arrays and strings are replaced whole. The record must exist.
 *   replace_*  swaps the whole document, only if it is unchanged since the
 *              `version` the caller read.
 *   revise_*   publishes a new version; stored versions are never modified.
 */

/** A weekly set target as the plan stores it; shared by the whole-plan and edit forms. */
const WEEKLY_SET_TARGET_SHAPE =
  '{muscles: [...], sets: {min, max}, bonusWeekSets: {min, max}|null, maintenanceSets: number|null}';

export const TOOL_SPECS: readonly McpToolSpec[] = [
  {
    name: 'get_content',
    title: 'Get site content',
    description:
      'Read one of the site documents, as `{doc, version, document}`. Keep `version`: replace_content ' +
      'needs it. With the admin token the blog includes draft posts.',
    requiresAuth: false,
    inputSchema: inputSchemaOf(TOOL_ARGS.get_content),
    annotations: readAnnotations,
  },
  {
    name: 'get_workout',
    title: 'Get workout summary',
    description:
      'Aggregated training summary: per-day volume, per-muscle sets, top exercises and estimated-1RM progression.',
    requiresAuth: false,
    inputSchema: inputSchemaOf(TOOL_ARGS.get_workout),
    annotations: readAnnotations,
  },
  {
    name: 'get_workout_sets',
    title: 'Get workout sets',
    description:
      'Every logged set for a day or span: exercise, weight, reps, volume, muscle and note. Admin only.',
    requiresAuth: true,
    inputSchema: inputSchemaOf(TOOL_ARGS.get_workout_sets),
    annotations: readAnnotations,
  },
  {
    name: 'list_exercises',
    title: 'List exercises',
    description:
      'Every exercise ever logged, with muscle group, set and session counts, date range and all-time bests. Admin only.',
    requiresAuth: true,
    inputSchema: inputSchemaOf(TOOL_ARGS.list_exercises),
    annotations: readAnnotations,
  },
  {
    name: 'get_exercise_history',
    title: 'Get exercise history',
    description:
      'Every logged set of one exercise in date order, with its all-time bests. Use for progression ' +
      'questions about a single lift. Admin only.',
    requiresAuth: true,
    inputSchema: inputSchemaOf(TOOL_ARGS.get_exercise_history),
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
    inputSchema: inputSchemaOf(TOOL_ARGS.get_workout_plan),
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
    inputSchema: inputSchemaOf(TOOL_ARGS.get_muscle_volume_status),
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
    inputSchema: inputSchemaOf(TOOL_ARGS.get_readiness),
    // Read-only, but unlike every other read it reaches outside this API.
    annotations: { ...readAnnotations, openWorldHint: true },
  },
  {
    name: 'get_training_recommendation',
    title: 'Get today\'s training recommendation',
    description:
      'What to train today and how hard, answered two ways side by side. `volumeOnly` ranks plan ' +
      'sessions by muscles behind on volume; `recoveryAware` also requires those muscles to have ' +
      'recovered since last trained (its sessions carry `recovery`; `recoveryBlocked` ones rank last). ' +
      'Each has `session`, `alternatives`, `prescription` (each slot restated for today\'s readiness, ' +
      'never more than the plan; null when readiness has no verdict, do not fill it in), ' +
      '`restSuggested` and `notes`. Top-level `notes` say when the two picks differ. Admin only.',
    requiresAuth: true,
    inputSchema: inputSchemaOf(TOOL_ARGS.get_training_recommendation),
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
    inputSchema: inputSchemaOf(TOOL_ARGS.get_weight_trend),
    // Read-only, but reaches the Google Health API.
    annotations: { ...readAnnotations, openWorldHint: true },
  },
  {
    name: 'replace_content',
    title: 'Replace site content',
    description:
      'Replace one whole site document: anything left out of `document` is deleted. Call get_content ' +
      'first, change what was asked, and send the full `document` back with the `version` it returned. ' +
      'If the document changed since (an edit on the site, or another write), it is refused with 412: ' +
      'read it again and reapply the change; never retry with an old document. It is validated and an ' +
      'invalid one is rejected unchanged. A home background is {url, caption, alt?, dim?} where dim is the overlay darkness as an integer percentage 0-100 (omitted = site default 55); backgroundsHidden: true keeps the saved photos but shows the plain black background. Admin only.',
    requiresAuth: true,
    inputSchema: inputSchemaOf(TOOL_ARGS.replace_content),
    annotations: replaceAnnotations,
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
    inputSchema: inputSchemaOf(TOOL_ARGS.revise_workout_plan),
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
    inputSchema: inputSchemaOf(TOOL_ARGS.list_reflections),
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
    inputSchema: inputSchemaOf(TOOL_ARGS.add_reflection),
    annotations: appendAnnotations,
  },
  {
    name: 'update_reflection',
    title: 'Correct reflection note',
    description:
      'Correct the body and/or themes of an existing note, by `type` and the `id` from ' +
      'list_reflections. Omitted fields are unchanged; `themes: null` clears the tags. A new thought is a new note, not a correction. Type and date cannot ' +
      'change. The add_reflection rule on workout notes applies. Admin only.',
    requiresAuth: true,
    inputSchema: inputSchemaOf(TOOL_ARGS.update_reflection),
    annotations: writeAnnotations,
  },
  {
    name: 'list_health_log',
    title: 'List health log days',
    description:
      'The owner\'s private daily health log, newest first. Each day has `measured` (last night\'s ' +
      'sleep, HRV, resting heart rate and readiness verdict from Google Health, recorded on the ' +
      'first update of the day or at 10:00, refreshed at 22:00; `settled` once final). ' +
      '`measured.status`: "awaiting" = not asked yet; "not_synced" = Google has no night yet ' +
      'today; "no_data" = the day is over and Google has nothing (watch off or flat; ' +
      '`missing[].latestDate` shows since when); "pending"/"ready" as in get_readiness. A ' +
      '`fetchError` ({at, by, error}) means the last read FAILED and `measured` is ' +
      'the last good answer, not evidence of an empty night. Never call a failed read "no data", ' +
      'or vice versa. Each day also has what the owner said: `notes` (entries keyed by id, oldest ' +
      'first, each {at, text}), `tags`, and 1-5 `energy`, `mood`, `stress`, `soreness`. ' +
      `Defaults to the last ${HEALTH_LIST_DEFAULT_DAYS} days. Admin only.`,
    requiresAuth: true,
    inputSchema: inputSchemaOf(TOOL_ARGS.list_health_log),
    annotations: readAnnotations,
  },
  {
    name: 'add_health_note',
    title: 'Add health note',
    description:
      'Save one thing the owner said about a day\'s health (how they slept or feel, soreness, ' +
      'illness, stress) as a new timestamped entry on that day. It always appends: earlier notes ' +
      'are never touched, so there is no need to read first. Write `text` in the conversation\'s ' +
      'language. `tags` are added to the day\'s tags: lowercase English, e.g. "cold", "lower-back". ' +
      'Only days the scheduler has created exist: today from 00:05 the owner\'s time; there is no ' +
      'way to add a day. If the day has no readiness yet, this also fetches it from Google Health: ' +
      '`readinessFetch` is "recorded" with the `status` Google\'s answer gave (an empty night is ' +
      '"not_synced"/"no_data"), or "failed" with an `error` when Google could not be read; the note ' +
      'is saved either way. Admin only.',
    requiresAuth: true,
    inputSchema: inputSchemaOf(TOOL_ARGS.add_health_note),
    // Reaches Google Health when the day has no readiness yet.
    annotations: { ...appendAnnotations, openWorldHint: true },
  },
  {
    name: 'update_health_log',
    title: 'Correct health log day',
    description:
      'Correct a day\'s notes, tags or ratings. Merge patch: omitted fields are unchanged, null ' +
      'clears one. `notes` is keyed by the entry ids list_health_log returns: {"<id>": {"text": ' +
      '"..."}} rewrites that entry, {"<id>": null} removes it, and entries not named are kept. To ' +
      'add a note use add_health_note, never this. `tags` replaces the day\'s tags. Ratings are 1-5 ' +
      'in their plain sense (energy and mood: 5 is high; stress and soreness: 5 is severe); set one ' +
      'only when the owner said something that clearly maps to it. The measured values cannot be ' +
      'changed. Like add_health_note, it fetches readiness if the day has none (`readinessFetch`). ' +
      'Admin only.',
    requiresAuth: true,
    inputSchema: inputSchemaOf(TOOL_ARGS.update_health_log),
    // Reaches Google Health when the day has no readiness yet.
    annotations: { ...writeAnnotations, openWorldHint: true },
  },
] as const;

export const TOOL_SPECS_BY_NAME: ReadonlyMap<string, McpToolSpec> = new Map(
  TOOL_SPECS.map((spec) => [spec.name, spec]),
);
