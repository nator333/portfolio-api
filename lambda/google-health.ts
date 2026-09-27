import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Minimal read client for the Google Health API (health.googleapis.com/v4),
 * the successor to the Fitbit Web API.
 *
 * Only what get_readiness needs: exchange the stored refresh token for an
 * access token, and page through `users/me/dataTypes/{type}/dataPoints`.
 *
 * ## Credentials
 *
 * One Secrets Manager secret (GOOGLE_HEALTH_SECRET_NAME) holds
 * `{client_id, client_secret, refresh_token}` for the owner's own Google
 * account, written once by scripts/google-health-auth.ts. There is exactly one
 * user, so there is no per-user token table — the same single-owner premise
 * the MCP server's admin gate rests on.
 *
 * Both the secret and the short-lived access token are kept for the life of a
 * warm Lambda. A refused refresh (`invalid_grant`: revoked, or expired — which
 * an OAuth app still in "Testing" does to refresh tokens after 7 days) drops
 * the cached secret too, so re-running the consent script takes effect on the
 * very next call rather than after the container recycles.
 */

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_HEALTH_BASE_URL = 'https://health.googleapis.com/v4';

/**
 * Read-only scopes the readiness signals need: sleep for `sleep`, and health
 * metrics for `daily-heart-rate-variability` and `daily-resting-heart-rate`.
 */
export const GOOGLE_HEALTH_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
] as const;

/** Per-request ceiling, well inside the MCP Lambda's own timeout. */
const REQUEST_TIMEOUT_MS = 8000;
/** Guard against a pagination loop; the readiness reads fit on one page. */
const MAX_PAGES = 10;
/** Refresh this long before the access token actually expires. */
const EXPIRY_MARGIN_MS = 60_000;

export interface GoogleHealthCredentials {
  readonly client_id: string;
  readonly client_secret: string;
  readonly refresh_token: string;
}

/**
 * `auth`: the stored grant no longer works; the fix is re-running the consent
 * script. `api`: the Health API itself refused or failed.
 */
export class GoogleHealthError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'api',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GoogleHealthError';
  }
}

const secrets = new SecretsManagerClient({});

let cachedCredentials: { name: string; value: GoogleHealthCredentials } | null = null;
let cachedToken: { value: string; expiresAt: number } | null = null;

/** Test hook: forget the warm-container caches. */
export function resetGoogleHealthCache(): void {
  cachedCredentials = null;
  cachedToken = null;
}

async function credentials(secretName: string): Promise<GoogleHealthCredentials> {
  if (cachedCredentials?.name === secretName) return cachedCredentials.value;

  let raw: string | undefined;
  try {
    raw = (await secrets.send(new GetSecretValueCommand({ SecretId: secretName }))).SecretString;
  } catch (error) {
    if ((error as { name?: string }).name === 'ResourceNotFoundException') {
      throw new GoogleHealthError(
        `Secret "${secretName}" does not exist. Run scripts/google-health-auth.ts to connect Google Health.`,
        'auth',
      );
    }
    throw error;
  }

  let parsed: Partial<GoogleHealthCredentials>;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    parsed = {};
  }
  if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) {
    throw new GoogleHealthError(
      `Secret "${secretName}" must hold client_id, client_secret and refresh_token. Re-run scripts/google-health-auth.ts.`,
      'auth',
    );
  }
  const value = parsed as GoogleHealthCredentials;
  cachedCredentials = { name: secretName, value };
  return value;
}

async function accessToken(secretName: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cachedToken.value;

  const creds = await credentials(secretName);
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    if (body.error === 'invalid_grant') {
      // The secret is stale; make the next call read it afresh.
      resetGoogleHealthCache();
      throw new GoogleHealthError(
        'The stored Google Health grant was refused (revoked, or expired — an OAuth app in "Testing" ' +
          'issues refresh tokens that last 7 days). Re-run scripts/google-health-auth.ts.',
        'auth',
        response.status,
      );
    }
    throw new GoogleHealthError(
      `Google token refresh failed: ${response.status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim(),
      'api',
      response.status,
    );
  }

  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

/**
 * Every data point of `dataType` matching `filter`, across pages. `filter`
 * follows the API's AIP-160 subset (only `>=`, `<` and `AND`), e.g.
 * `daily_resting_heart_rate.date >= "2026-09-01"`.
 */
export async function listDataPoints(
  secretName: string,
  dataType: string,
  filter: string,
  pageSize?: number,
): Promise<unknown[]> {
  const token = await accessToken(secretName);
  const points: unknown[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${GOOGLE_HEALTH_BASE_URL}/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints`);
    url.searchParams.set('filter', filter);
    if (pageSize) url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (response.status === 401 || response.status === 403) {
        // A token that stopped working mid-life, or a grant missing a scope.
        cachedToken = null;
        throw new GoogleHealthError(
          `Google Health refused ${dataType} (${response.status}). If scopes changed, re-run scripts/google-health-auth.ts. ${detail}`.trim(),
          'auth',
          response.status,
        );
      }
      throw new GoogleHealthError(
        `Google Health ${dataType} request failed: ${response.status} ${detail}`.trim(),
        'api',
        response.status,
      );
    }

    const body = (await response.json()) as { dataPoints?: unknown[]; nextPageToken?: string };
    points.push(...(body.dataPoints ?? []));
    pageToken = body.nextPageToken || undefined;
    if (!pageToken) break;
  }

  return points;
}
