/**
 * One error shape for everything the MCP tools report, whether the whole call
 * failed or one part of a successful call did.
 *
 *   failed call     { isError: true, structuredContent: { error }, content: [text of the same] }
 *   partial failure the same `error` object nested where it happened, e.g.
 *                   readinessFetch.error, readiness.error, a health day's
 *                   fetchError.error
 *
 * `code` says what went wrong and `retry` says what to do about it, so a
 * client never has to infer either from the English `message`:
 *
 *   now           transient; the same call may work again
 *   after_reread  something changed underneath; read again, reapply, retry
 *   after_fix     the call itself was wrong; change it first
 *   owner_action  only the owner can fix it (e.g. reconnect Google)
 *   never         retrying cannot help
 *
 * The REST API keeps its HTTP statuses and bodies. The MCP layer builds this
 * object from them (toolErrorFromResponse), and a handler can name the code
 * outright in its body (`code`, plus optional `fix`) where the status alone is
 * ambiguous: a 409 may be a stale version, a broken rule, or a full day.
 */

export const TOOL_ERROR_CODES = [
  'invalid_input',
  'rule_violation',
  'not_found',
  'stale_version',
  'limit_reached',
  'upstream_auth',
  'upstream_unavailable',
  'internal',
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export type ToolErrorRetry = 'now' | 'after_reread' | 'after_fix' | 'owner_action' | 'never';

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retry: ToolErrorRetry;
  /** The next step, when there is one worth stating. */
  fix?: string;
  /** Anything else useful: field issues, candidates, the current version. */
  details?: Record<string, unknown>;
}

const RETRY: Record<ToolErrorCode, ToolErrorRetry> = {
  invalid_input: 'after_fix',
  rule_violation: 'after_fix',
  not_found: 'after_fix',
  stale_version: 'after_reread',
  limit_reached: 'never',
  upstream_auth: 'owner_action',
  upstream_unavailable: 'now',
  internal: 'never',
};

const DEFAULT_FIX: Partial<Record<ToolErrorCode, string>> = {
  stale_version: 'Read it again, reapply the change, and retry with what the read returned.',
  upstream_auth: 'The owner must reconnect Google Health: run `npm run health:auth` in portfolio-api.',
};

export function toolError(
  code: ToolErrorCode,
  message: string,
  extra: { fix?: string; details?: Record<string, unknown> } = {},
): ToolError {
  const fix = extra.fix ?? DEFAULT_FIX[code];
  const details = extra.details && Object.keys(extra.details).length > 0 ? extra.details : undefined;
  return {
    code,
    message,
    retry: RETRY[code],
    ...(fix ? { fix } : {}),
    ...(details ? { details } : {}),
  };
}

const isCode = (value: unknown): value is ToolErrorCode =>
  typeof value === 'string' && (TOOL_ERROR_CODES as readonly string[]).includes(value);

/** The code an HTTP status means when the body does not say. */
function codeForStatus(status: number, body: Record<string, unknown>): ToolErrorCode {
  if (status === 400) return 'invalid_input';
  if (status === 404) return 'not_found';
  if (status === 409 || status === 412) return 'stale_version';
  // Google Health failures carry the kind the client recorded.
  if (status === 502 || status === 503) return body.kind === 'auth' ? 'upstream_auth' : 'upstream_unavailable';
  return 'internal';
}

/**
 * zod issues reduced to what a caller acts on: where, and why. The full issue
 * objects (code, expected, received, …) cost tokens and bury those two.
 */
export function compactIssues(issues: unknown): { path: string; message: string }[] | undefined {
  if (!Array.isArray(issues)) return undefined;
  return issues.map((issue) => {
    const i = issue as { path?: unknown[]; message?: unknown };
    return {
      path: Array.isArray(i.path) && i.path.length > 0 ? i.path.join('.') : '(root)',
      message: String(i.message ?? 'invalid'),
    };
  });
}

/** A non-2xx REST answer as a ToolError. */
export function toolErrorFromResponse(statusCode: number, rawBody: string | undefined): ToolError {
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawBody || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
  } catch {
    body = { message: rawBody };
  }
  const { message, code, fix, errors, kind: _kind, ...rest } = body;
  const issues = compactIssues(errors);
  return toolError(
    isCode(code) ? code : codeForStatus(statusCode, body),
    typeof message === 'string' && message ? message : `Request failed with status ${statusCode}`,
    {
      fix: typeof fix === 'string' ? fix : undefined,
      details: { ...rest, ...(issues ? { issues } : {}) },
    },
  );
}
