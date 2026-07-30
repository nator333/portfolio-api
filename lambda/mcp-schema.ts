import { z } from 'zod';

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
    description: 'Read the home-page document (the hero mottoes).',
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
    description: 'Replace the home-page document (hero mottoes). Admin only. Validated server-side.',
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
] as const;

export const TOOL_SPECS_BY_NAME: ReadonlyMap<string, McpToolSpec> = new Map(
  TOOL_SPECS.map((spec) => [spec.name, spec]),
);
