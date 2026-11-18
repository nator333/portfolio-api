import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { handler as getCv } from './get-cv';
import { handler as getProjects } from './get-projects';
import { blogReader } from './get-blog';
import { handler as getHome } from './get-home';
import { handler as getWorkout } from './get-workout';
import { handler as getWorkoutSets } from './get-workout-sets';
import { handler as getExerciseHistory } from './get-exercise-history';
import { handler as listExercises } from './list-exercises';
import { handler as getWorkoutPlan } from './get-workout-plan';
import { handler as getMuscleVolumeStatus } from './get-muscle-volume-status';
import { handler as getReadiness } from './get-readiness';
import { handler as getTrainingRecommendation } from './get-training-recommendation';
import { handler as getWeightTrend } from './get-weight-trend';
import { handler as updateCv } from './update-cv';
import { handler as updateProjects } from './update-projects';
import { handler as updateBlog } from './update-blog';
import { handler as updateHome } from './update-home';
import { handler as updateWorkoutPlan } from './update-workout-plan';
import { handler as reviseWorkoutPlan } from './revise-workout-plan';
import { handler as listReflections } from './list-reflections';
import { handler as addReflection } from './add-reflection';
import { handler as updateReflection } from './update-reflection';
import { handler as listHealthLog } from './list-health-log';
import { handler as updateHealthLog } from './update-health-log';
import { handler as addHealthNote } from './add-health-note';

import {
  JSON_RPC,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  MCP_INSTRUCTIONS,
  TOOL_SPECS,
  TOOL_SPECS_BY_NAME,
  CONTENT_DOCS,
  jsonRpcRequestSchema,
} from './mcp-schema';
import { corsHeaders } from './cors';
import { etag, versionOf } from './content-version';
import { compactIssues, toolError, toolErrorFromResponse, type ToolError } from './tool-error';
import { TOOL_ARGS, type ToolArgs, type ToolName } from './mcp-args';
import { randomUUID } from 'crypto';
import { challengeHeader } from './mcp-oauth';

/**
 * Model Context Protocol server for the portfolio API.
 *
 * One public `POST /mcp` speaking stateless Streamable HTTP (JSON responses, no
 * SSE — a Lambda behind a REST API has no long-lived connection to stream over).
 * It re-exposes the site's own handlers as MCP tools so any agent can read the
 * portfolio, and — with an admin token — edit it.
 *
 * ## Why this Lambda holds write grants when /chat and /agent deliberately don't
 *
 * The unauthenticated public endpoints (/chat, /agent) are kept write-incapable
 * at the IAM layer precisely because they are reachable without credentials: no
 * grant means no prompt-injection can ever mutate the tables. This endpoint is
 * different in kind. It is *also* publicly reachable, but every admin tool is
 * refused here in code unless the caller presents an OAuth 2.1 **access token**
 * that verifies against the admin user pool and was issued for this resource.
 * The anonymous path can only ever reach the public read tools, which touch no
 * write action. So the write grants this role carries are only ever exercised
 * behind a verified admin, and the authorization boundary is `verifyAdmin`
 * below, not the absence of a grant.
 *
 * The pool's pre-signup trigger admits only the owner's Google account, so any
 * token this pool mints is the owner's — which is what makes a pre-registered
 * client sufficient here and dynamic client registration unnecessary.
 */

type ProxyHandler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

/** Build the minimal proxy event each delegated handler actually reads. */
function proxyEvent(opts: {
  body?: unknown;
  query?: Record<string, string | undefined>;
  path?: Record<string, string>;
  headers?: Record<string, string>;
}): APIGatewayProxyEvent {
  return {
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
    queryStringParameters: opts.query ?? null,
    pathParameters: opts.path ?? null,
    // No Origin → the delegated handler's corsHeaders() returns {}; we only
    // read its statusCode, body and ETag, and re-frame CORS on the MCP response.
    headers: opts.headers ?? {},
  } as unknown as APIGatewayProxyEvent;
}

/** Who is calling: `admin` is a verified admin token, on any tool. */
interface CallContext {
  admin: boolean;
}

/**
 * Maps each advertised tool to the underlying handler and the event shape it
 * expects. `args` has already been validated against the tool's schema in
 * TOOL_ARGS (mcp-args.ts) and arrives parsed and typed.
 */
const INVOKERS: { [N in ToolName]: (args: ToolArgs<N>, ctx: CallContext) => Promise<APIGatewayProxyResult> } = {
  get_content: async (args, ctx) => {
    const read = contentReader(args.doc, ctx);
    if (!read) return unknownDoc(args.doc);
    return withVersion(args.doc, await read(proxyEvent({})));
  },
  get_workout: (args) => getWorkout(proxyEvent({ query: toQuery(args) })),
  get_workout_sets: (args) => getWorkoutSets(proxyEvent({ query: toQuery(args) })),
  list_exercises: (args) => listExercises(proxyEvent({ query: toQuery(args) })),
  get_exercise_history: (args) => getExerciseHistory(proxyEvent({ query: toQuery(args) })),
  get_workout_plan: (args) => getWorkoutPlan(proxyEvent({ query: toQuery(args) })),
  get_muscle_volume_status: (args) => getMuscleVolumeStatus(proxyEvent({ query: toQuery(args) })),
  get_readiness: (args) => getReadiness(proxyEvent({ query: toQuery(args) })),
  get_training_recommendation: (args) => getTrainingRecommendation(proxyEvent({ query: toQuery(args) })),
  get_weight_trend: (args) => getWeightTrend(proxyEvent({ query: toQuery(args) })),
  replace_content: async (args) => {
    const write = CONTENT_WRITERS.get(args.doc);
    if (!write) return unknownDoc(args.doc);
    // If-Match makes the writer refuse (412) a document changed since then.
    const result = await write(proxyEvent({ body: args.document, headers: { 'If-Match': etag(args.version) } }));
    return withVersion(args.doc, result);
  },
  revise_workout_plan: (args) => revisePlan(args),
  list_reflections: (args) => listReflections(proxyEvent({ query: toQuery(args) })),
  add_reflection: (args) => addReflection(proxyEvent({ body: args })),
  update_reflection: (args) => updateReflection(proxyEvent({ body: args })),
  list_health_log: (args) => listHealthLog(proxyEvent({ query: toQuery(args) })),
  add_health_note: (args) => addHealthNote(proxyEvent({ body: args })),
  update_health_log: (args) => updateHealthLog(proxyEvent({ body: args })),
};

/**
 * Parsed read arguments as the query string a REST request would carry: the
 * delegated handlers only ever see strings. An omitted argument stays absent,
 * so each default (today, a 7-day window, …) is the handler's alone, not a
 * second opinion from this layer.
 */
function toQuery(args: Record<string, unknown>): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') query[key] = String(value);
  }
  return query;
}

/**
 * get_content and replace_content route on `doc` to the handler each document
 * always had. A Map rather than an object literal, so a `doc` such as
 * "constructor" finds nothing instead of a prototype member.
 */
const CONTENT_READERS = new Map<string, ProxyHandler>([
  ['cv', getCv],
  ['projects', getProjects],
  ['home', getHome],
]);

/**
 * The blog is read with its drafts for the verified admin and without them for
 * anyone else. That is what makes replace_content safe on the blog: a document
 * read without drafts and written back would delete every draft.
 */
const publicBlog = blogReader(false);
const adminBlog = blogReader(true);

function contentReader(doc: string, ctx: CallContext): ProxyHandler | undefined {
  if (doc === 'blog') return ctx.admin ? adminBlog : publicBlog;
  return CONTENT_READERS.get(doc);
}

/**
 * A content handler's answer, reframed as `{doc, version, document}`: the
 * version (its ETag) is what replace_content must send back. Errors pass
 * through unchanged.
 */
function withVersion(doc: string, result: APIGatewayProxyResult): APIGatewayProxyResult {
  if (result.statusCode < 200 || result.statusCode >= 300) return result;
  return {
    ...result,
    body: JSON.stringify({ doc, version: versionOf(result) ?? null, document: JSON.parse(result.body || 'null') }),
  };
}

const CONTENT_WRITERS = new Map<string, ProxyHandler>([
  ['cv', updateCv],
  ['projects', updateProjects],
  ['blog', updateBlog],
  ['home', updateHome],
]);

const badRequest = (message: string): APIGatewayProxyResult => ({
  statusCode: 400,
  body: JSON.stringify({ message }),
});

const unknownDoc = (doc: unknown) =>
  badRequest(`Unknown doc ${JSON.stringify(doc)}; expected one of ${CONTENT_DOCS.join(', ')}`);

/**
 * revise_workout_plan publishes either edits or a whole `plan` (its schema in
 * mcp-args.ts refuses both, or neither). The whole-plan form goes to the
 * handler that used to back update_workout_plan, with the tool's `changeNote`
 * carried into the document unless it already has one.
 */
function revisePlan(args: ToolArgs<'revise_workout_plan'>): Promise<APIGatewayProxyResult> {
  const { plan, changeNote } = args;
  if (plan === undefined) return reviseWorkoutPlan(proxyEvent({ body: args }));
  return updateWorkoutPlan(proxyEvent({ body: { ...plan, changeNote: plan.changeNote ?? changeNote } }));
}

// --- Admin authorization (the write gate) -----------------------------------

/**
 * Verifies the OAuth 2.1 access token the MCP authorization spec requires.
 *
 * Three things changed from the original ID-token gate, and each is load-bearing:
 *
 * 1. **Access tokens, not ID tokens.** An ID token asserts who the user is to
 *    the client that requested it; an access token is the credential a resource
 *    server is meant to accept. MCP clients obtain and send the latter.
 * 2. **The audience is checked against this resource.** A token minted for some
 *    other relying party must not open this one, so `verifyAudience` requires
 *    the `aud` (or, on a pool without resource binding, the `client_id`) to name
 *    a client this deployment issued.
 * 3. **Failures surface as HTTP 401 with `WWW-Authenticate`**, handled by the
 *    caller. A 200 carrying an error message tells an MCP client nothing about
 *    where to authenticate, so the OAuth flow never starts.
 */

type Verifier = ReturnType<typeof CognitoJwtVerifier.create>;
let verifier: Verifier | null | undefined;

/** App client IDs this deployment issued; a token from any other is refused. */
function allowedClientIds(): string[] {
  return (process.env.MCP_CLIENT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Lazily build the access-token verifier; null when the pool env is absent.
 *
 * `clientId: null` disables aws-jwt-verify's own single-client check — this
 * server legitimately accepts more than one app client (the SPA's and Claude's),
 * so the check is done against the allowlist below instead of being pinned to
 * one value at construction time.
 */
function getVerifier(): Verifier | null {
  if (verifier !== undefined) return verifier;
  const userPoolId = process.env.USER_POOL_ID;
  verifier = userPoolId
    ? CognitoJwtVerifier.create({ userPoolId, tokenUse: 'access', clientId: null })
    : null;
  return verifier;
}

function bearerToken(headers: APIGatewayProxyEvent['headers']): string | undefined {
  const raw = headers?.['authorization'] ?? headers?.['Authorization'];
  const match = raw ? /^Bearer\s+(.+)$/i.exec(raw.trim()) : null;
  return match?.[1];
}

/**
 * The token must be intended for *this* resource. With Cognito resource binding
 * the requested resource URI lands in `aud`; without it (the tier this pool is
 * on) an access token carries only `client_id`, so an issuing client we
 * provisioned is the strongest available binding. Either way a token minted for
 * an unrelated client is rejected rather than honoured.
 */
function verifyAudience(payload: Record<string, unknown>): boolean {
  const allowed = allowedClientIds();
  if (allowed.length === 0) return false;

  const resource = process.env.MCP_RESOURCE_URL;
  const aud = payload.aud;
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud.map(String) : [];
  if (resource && audiences.includes(resource)) return true;

  const clientId = typeof payload.client_id === 'string' ? payload.client_id : undefined;
  return !!clientId && allowed.includes(clientId);
}

export type AuthOutcome =
  | { ok: true; subject: string }
  | { ok: false; error: 'invalid_token' | 'insufficient_scope'; reason: string };

/** Verify the caller may exercise the admin tools. Any failure denies the write. */
export async function verifyAdmin(
  headers: APIGatewayProxyEvent['headers'],
): Promise<AuthOutcome> {
  const token = bearerToken(headers);
  if (!token) {
    return { ok: false, error: 'invalid_token', reason: 'no bearer token' };
  }
  const v = getVerifier();
  if (!v) {
    return { ok: false, error: 'invalid_token', reason: 'admin auth is not configured on this endpoint' };
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await v.verify(token)) as unknown as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'invalid_token', reason: 'invalid or expired token' };
  }

  if (!verifyAudience(payload)) {
    return { ok: false, error: 'invalid_token', reason: 'token was not issued for this resource' };
  }

  // The pool's pre-signup trigger already restricts sign-in to the admin
  // address, so any token this pool minted belongs to the owner. The scope
  // check is what separates a read-only grant from an editing one.
  const required = process.env.MCP_ADMIN_SCOPE;
  if (required) {
    const granted = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : [];
    if (!granted.includes(required)) {
      return { ok: false, error: 'insufficient_scope', reason: `token lacks the ${required} scope` };
    }
  }

  const subject = typeof payload.sub === 'string' ? payload.sub : 'unknown';
  return { ok: true, subject };
}

// --- JSON-RPC plumbing -------------------------------------------------------

type Id = string | number | null | undefined;

const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: '2.0' as const, id: id ?? null, result });
const rpcError = (id: Id, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0' as const,
  id: id ?? null,
  error: data === undefined ? { code, message } : { code, message, data },
});

/**
 * MCP tool result content, framing the delegated handler's HTTP outcome. A
 * success is the handler's body. A failure is one ToolError (tool-error.ts),
 * both as `structuredContent` for clients that read it and as the text, since
 * the HTTP status itself never reaches the client.
 */
function toolResult(handlerResult: APIGatewayProxyResult) {
  const ok = handlerResult.statusCode >= 200 && handlerResult.statusCode < 300;
  if (ok) return { content: [{ type: 'text', text: handlerResult.body ?? '' }], isError: false };
  return errorToolResult(toolErrorFromResponse(handlerResult.statusCode, handlerResult.body));
}

const errorToolResult = (error: ToolError) => ({
  content: [{ type: 'text', text: JSON.stringify({ error }) }],
  structuredContent: { error },
  isError: true,
});

async function handleRpc(
  request: unknown,
  headers: APIGatewayProxyEvent['headers'],
): Promise<{ response?: unknown; unauthorized?: { error: string; reason: string } }> {
  const parsed = jsonRpcRequestSchema.safeParse(request);
  if (!parsed.success) {
    return { response: rpcError(null, JSON_RPC.INVALID_REQUEST, 'Invalid JSON-RPC request') };
  }
  const { id, method, params = {} } = parsed.data;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return {
        response: rpcResult(id, {
          protocolVersion: typeof requested === 'string' ? requested : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        }),
      };
    }

    case 'ping':
      return { response: rpcResult(id, {}) };

    case 'notifications/initialized':
    case 'notifications/cancelled':
      // Notifications are acknowledged at the HTTP layer with 202; no body.
      return {};

    case 'tools/list':
      return {
        response: rpcResult(id, {
          tools: TOOL_SPECS.map((spec) => ({
            name: spec.name,
            title: spec.title,
            description: spec.description,
            inputSchema: spec.inputSchema,
            annotations: spec.annotations,
          })),
        }),
      };

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const spec = TOOL_SPECS_BY_NAME.get(name);
      // Own keys only: `'constructor' in INVOKERS` is true.
      const invoke = Object.hasOwn(INVOKERS, name) ? INVOKERS[name as ToolName] : undefined;
      if (!spec || !invoke) {
        return { response: rpcError(id, JSON_RPC.INVALID_PARAMS, `Unknown tool: ${name || '(none)'}`) };
      }

      let admin = false;
      if (spec.requiresAuth) {
        const auth = await verifyAdmin(headers);
        if (!auth.ok) {
          // Surfaced as a real 401 + WWW-Authenticate by the handler below. A
          // 200 with an error message would leave the client with nothing to
          // discover, so the OAuth flow would never begin.
          return { unauthorized: { error: auth.error, reason: auth.reason } };
        }
        admin = true;
      } else if (bearerToken(headers)) {
        // A public tool still answers anyone, but a verified admin may see more
        // (the blog's drafts). An invalid token here just means "not admin".
        admin = (await verifyAdmin(headers)).ok;
      }

      // One schema per tool (mcp-args.ts) is both what tools/list advertises
      // and what is enforced here, before any handler runs.
      const parsed = TOOL_ARGS[name as ToolName].safeParse(params.arguments ?? {});
      if (!parsed.success) {
        return {
          response: rpcResult(
            id,
            errorToolResult(
              toolError('invalid_input', `Invalid arguments for ${name}`, {
                details: { issues: compactIssues(parsed.error.issues) },
              }),
            ),
          ),
        };
      }

      try {
        const result = await (invoke as (args: unknown, ctx: CallContext) => Promise<APIGatewayProxyResult>)(
          parsed.data,
          { admin },
        );
        return { response: rpcResult(id, toolResult(result)) };
      } catch (error) {
        // An exception is a bug or an outage, not something the caller can fix
        // by retrying the same call; the id ties the answer to the log line.
        const incident = randomUUID();
        console.error(`MCP tool ${name} failed`, { incident }, error);
        return {
          response: rpcResult(
            id,
            errorToolResult(
              toolError('internal', `The ${name} tool failed unexpectedly (incident ${incident}); nothing to fix in the call.`, {
                fix: 'Tell the owner, quoting the incident id; it is in the server logs.',
              }),
            ),
          ),
        };
      }
    }

    default:
      if (isNotification) return {};
      return { response: rpcError(id, JSON_RPC.METHOD_NOT_FOUND, `Unknown method: ${method}`) };
  }
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(rpcError(null, JSON_RPC.PARSE_ERROR, 'Request body must be valid JSON')),
    };
  }

  // 2025-06-18 dropped JSON-RPC batching; accept a single request object only.
  if (Array.isArray(body)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(rpcError(null, JSON_RPC.INVALID_REQUEST, 'JSON-RPC batches are not supported')),
    };
  }

  const { response, unauthorized } = await handleRpc(body, event.headers);

  if (unauthorized) {
    return {
      statusCode: 401,
      headers: {
        ...headers,
        'WWW-Authenticate': challengeHeader(unauthorized.error, unauthorized.reason),
      },
      body: JSON.stringify({ error: unauthorized.error, error_description: unauthorized.reason }),
    };
  }

  // A notification (or initialized handshake) owes no body: 202 Accepted.
  if (response === undefined) {
    return { statusCode: 202, headers, body: '' };
  }

  return { statusCode: 200, headers, body: JSON.stringify(response) };
};
