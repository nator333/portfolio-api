import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { handler as getCv } from './get-cv';
import { handler as getProjects } from './get-projects';
import { handler as getBlog } from './get-blog';
import { handler as getHome } from './get-home';
import { handler as getWorkout } from './get-workout';
import { handler as getActivity } from './get-activity';
import { handler as listMedia } from './list-media';
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
 * different in kind. It is *also* publicly reachable, but every write tool is
 * refused here in code unless the caller presents a Cognito **ID token** that
 * verifies against the admin user pool AND whose email is on the allowlist —
 * the same identity that guards the PUT endpoints. The anonymous path can only
 * ever reach the read tools, which touch no write action. So the write grants
 * this role carries are only ever exercised behind a verified admin, and the
 * authorization boundary is `verifyAdmin` below, not the absence of a grant.
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
  update_cv: (args) => updateCv(proxyEvent({ body: args })),
  update_projects: (args) => updateProjects(proxyEvent({ body: args })),
  update_blog: (args) => updateBlog(proxyEvent({ body: args })),
  update_home: (args) => updateHome(proxyEvent({ body: args })),
  update_media: (args) => {
    const { assetId, ...rest } = args as { assetId?: string } & Record<string, unknown>;
    return updateMedia(proxyEvent({ path: { id: String(assetId ?? '') }, body: rest }));
  },
};

function dateRange(args: Record<string, unknown>): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  if (typeof args.from === 'string') query.from = args.from;
  if (typeof args.to === 'string') query.to = args.to;
  return query;
}

// --- Admin authorization (the write gate) -----------------------------------

type Verifier = ReturnType<typeof CognitoJwtVerifier.create>;
let verifier: Verifier | null | undefined;

/** Lazily build the ID-token verifier; null when the pool env is not configured. */
function getVerifier(): Verifier | null {
  if (verifier !== undefined) return verifier;
  const userPoolId = process.env.USER_POOL_ID;
  const clientId = process.env.USER_POOL_CLIENT_ID;
  verifier =
    userPoolId && clientId
      ? CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId })
      : null;
  return verifier;
}

function bearerToken(headers: APIGatewayProxyEvent['headers']): string | undefined {
  const raw = headers?.['authorization'] ?? headers?.['Authorization'];
  const match = raw ? /^Bearer\s+(.+)$/i.exec(raw.trim()) : null;
  return match?.[1];
}

/** Verify the caller is the allowlisted admin. Any failure denies the write. */
async function verifyAdmin(
  headers: APIGatewayProxyEvent['headers'],
): Promise<{ ok: true; email: string } | { ok: false; reason: string }> {
  const token = bearerToken(headers);
  if (!token) {
    return { ok: false, reason: 'no bearer token; send Authorization: Bearer <Cognito ID token>' };
  }
  const v = getVerifier();
  if (!v) return { ok: false, reason: 'admin auth is not configured on this endpoint' };

  let email: string | undefined;
  try {
    const payload = await v.verify(token);
    email = typeof payload.email === 'string' ? payload.email : undefined;
  } catch {
    return { ok: false, reason: 'invalid or expired token' };
  }

  const admins = (process.env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  if (!email || !admins.includes(email)) {
    return { ok: false, reason: 'token is valid but not an allowlisted admin' };
  }
  return { ok: true, email };
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
): Promise<{ response?: unknown }> {
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
          return { response: rpcResult(id, errorToolResult(`Authentication required: ${auth.reason}`)) };
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

  const { response } = await handleRpc(body, event.headers);

  // A notification (or initialized handshake) owes no body: 202 Accepted.
  if (response === undefined) {
    return { statusCode: 202, headers, body: '' };
  }

  return { statusCode: 200, headers, body: JSON.stringify(response) };
};
