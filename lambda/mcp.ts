import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { handler as getCv } from './get-cv';
import { handler as getProjects } from './get-projects';
import { handler as getBlog } from './get-blog';
import { handler as getHome } from './get-home';
import { handler as getWorkout } from './get-workout';
import { handler as getActivity } from './get-activity';
import { handler as listMedia } from './list-media';
import { handler as getWorkoutSets } from './get-workout-sets';
import { handler as updateCv } from './update-cv';
import { handler as updateProjects } from './update-projects';
import { handler as updateBlog } from './update-blog';
import { handler as updateHome } from './update-home';
import { handler as updateMedia } from './update-media';

import {
  JSON_RPC,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  TOOL_SPECS,
  TOOL_SPECS_BY_NAME,
  jsonRpcRequestSchema,
} from './mcp-schema';
import { corsHeaders } from './cors';
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
}): APIGatewayProxyEvent {
  return {
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
    queryStringParameters: opts.query ?? null,
    pathParameters: opts.path ?? null,
    // Empty headers → the delegated handler's corsHeaders() returns {}; we only
    // read its statusCode and body, and re-frame CORS on the MCP response itself.
    headers: {},
  } as unknown as APIGatewayProxyEvent;
}

/**
 * Maps each advertised tool to the underlying handler and the event shape it
 * expects. `args` is the client-supplied `arguments` object from `tools/call`.
 */
const INVOKERS: Record<string, (args: Record<string, unknown>) => Promise<APIGatewayProxyResult>> = {
  get_cv: () => getCv(proxyEvent({})),
  get_projects: () => getProjects(proxyEvent({})),
  get_blog: () => getBlog(proxyEvent({})),
  get_home: () => getHome(proxyEvent({})),
  get_workout: (args) => getWorkout(proxyEvent({ query: dateRange(args) })),
  get_activity: (args) => getActivity(proxyEvent({ query: dateRange(args) })),
  list_media: () => listMedia(proxyEvent({})),
  get_workout_sets: (args) => getWorkoutSets(proxyEvent({ query: setsRange(args) })),
  update_cv: (args) => updateCv(proxyEvent({ body: args })),
  update_projects: (args) => updateProjects(proxyEvent({ body: args })),
  update_blog: (args) => updateBlog(proxyEvent({ body: args })),
  update_home: (args) => updateHome(proxyEvent({ body: args })),
  update_media: (args) => {
    const { assetId, ...rest } = args as { assetId?: string } & Record<string, unknown>;
    return updateMedia(proxyEvent({ path: { id: String(assetId ?? '') }, body: rest }));
  },
};

function setsRange(args: Record<string, unknown>): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  if (typeof args.date === 'string') query.date = args.date;
  if (typeof args.from === 'string') query.from = args.from;
  if (typeof args.to === 'string') query.to = args.to;
  return query;
}

function dateRange(args: Record<string, unknown>): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  if (typeof args.from === 'string') query.from = args.from;
  if (typeof args.to === 'string') query.to = args.to;
  return query;
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

/** MCP tool result content, framing the delegated handler's HTTP outcome. */
function toolResult(handlerResult: APIGatewayProxyResult) {
  const ok = handlerResult.statusCode >= 200 && handlerResult.statusCode < 300;
  const body = handlerResult.body ?? '';
  return {
    content: [{ type: 'text', text: body }],
    isError: !ok,
  };
}

const errorToolResult = (message: string) => ({
  content: [{ type: 'text', text: message }],
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
      const invoke = INVOKERS[name];
      if (!spec || !invoke) {
        return { response: rpcError(id, JSON_RPC.INVALID_PARAMS, `Unknown tool: ${name || '(none)'}`) };
      }

      if (spec.requiresAuth) {
        const auth = await verifyAdmin(headers);
        if (!auth.ok) {
          // Surfaced as a real 401 + WWW-Authenticate by the handler below. A
          // 200 with an error message would leave the client with nothing to
          // discover, so the OAuth flow would never begin.
          return { unauthorized: { error: auth.error, reason: auth.reason } };
        }
      }

      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};

      try {
        const result = await invoke(args);
        return { response: rpcResult(id, toolResult(result)) };
      } catch (error) {
        console.error(`MCP tool ${name} failed`, error);
        return { response: rpcResult(id, errorToolResult('The tool failed to execute, please try again')) };
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
