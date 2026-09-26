import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import {
  CreateSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { GOOGLE_HEALTH_SCOPES, GOOGLE_TOKEN_URL } from '../lambda/google-health';

/**
 * Connects the owner's Google Health data to get_readiness, once.
 *
 * Runs Google's installed-app OAuth flow (loopback redirect + PKCE) in the
 * owner's own browser, and stores the resulting refresh token in Secrets
 * Manager, where the MCP Lambda reads it. The token is never printed.
 *
 *   npx ts-node --prefer-ts-exts scripts/google-health-auth.ts \
 *     --client-secret=path/to/client_secret.json [--region=us-west-1]
 *
 * Prerequisites, in the Google Cloud console:
 *   1. Enable the Google Health API (health.googleapis.com).
 *   2. Configure the OAuth consent screen and add the owner as a test user.
 *   3. Create an OAuth client of type "Desktop app" and download its JSON.
 *
 * While the consent screen stays in "Testing", Google expires the refresh
 * token after 7 days; get_readiness then says so, and re-running this script
 * fixes it. Publishing the app (or otherwise getting a long-lived grant) is
 * what removes the weekly re-run.
 *
 * Re-running is always safe: it overwrites the stored grant with a fresh one.
 */

/** Must match GOOGLE_HEALTH_SECRET_NAME in lib/portfolio-api-stack.ts. */
const DEFAULT_SECRET_NAME = 'google-health-oauth';
/** The stack's default region (bin/portfolio-api.ts). */
const DEFAULT_REGION = 'us-west-1';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const argOf = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const base64url = (buf: Buffer) => buf.toString('base64url');

function readClient(path: string): { clientId: string; clientSecret: string } {
  const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { client_id?: string; client_secret?: string }>;
  // Google wraps a Desktop client in "installed" (a Web client in "web").
  const client = json.installed ?? json.web;
  if (!client?.client_id || !client.client_secret) {
    throw new Error(`${path} is not a Google OAuth client JSON (expected an "installed" client)`);
  }
  return { clientId: client.client_id, clientSecret: client.client_secret };
}

/**
 * Start the loopback listener Google redirects the browser back to. Resolves
 * once it is listening (the redirect URI needs its port); `code` resolves when
 * the redirect arrives.
 */
function listen(state: string): Promise<{ redirectUri: string; code: Promise<string> }> {
  return new Promise((resolveListening) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const code = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const error = url.searchParams.get('error');
      const received = url.searchParams.get('code');
      // Ignore stray requests (a browser's favicon fetch, say).
      if (!error && !received) {
        res.writeHead(404).end();
        return;
      }
      const failure = error ?? (url.searchParams.get('state') === state ? null : 'state mismatch');
      res.writeHead(failure ? 400 : 200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(failure ? `Authorization failed: ${failure}` : 'Google Health connected. You can close this tab.');
      server.close();
      if (failure) rejectCode(new Error(`Authorization failed: ${failure}`));
      else resolveCode(received!);
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolveListening({ redirectUri: `http://127.0.0.1:${port}`, code });
    });
  });
}

async function main(): Promise<void> {
  const clientSecretPath = argOf('client-secret');
  if (!clientSecretPath) {
    console.error('Usage: scripts/google-health-auth.ts --client-secret=path/to/client_secret.json [--secret-name=...] [--region=...]');
    process.exitCode = 1;
    return;
  }
  const secretName = argOf('secret-name') ?? DEFAULT_SECRET_NAME;
  const region = argOf('region') ?? DEFAULT_REGION;
  const { clientId, clientSecret } = readClient(clientSecretPath);

  const state = base64url(randomBytes(16));
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());

  const listener = await listen(state);
  const authUrl = new URL(AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: listener.redirectUri,
    response_type: 'code',
    scope: GOOGLE_HEALTH_SCOPES.join(' '),
    // offline + consent: without both, Google may omit the refresh token on a
    // second run, leaving nothing to store.
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  console.log('Open this URL in a browser signed in to the Google account your watch syncs to:\n');
  console.log(authUrl.toString());
  console.log('\nWaiting for the redirect…');

  const code = await listener.code;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: listener.redirectUri,
      code_verifier: verifier,
    }),
  });
  const token = (await response.json()) as { refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${token.error ?? response.status} ${token.error_description ?? ''}`);
  }
  if (!token.refresh_token) {
    throw new Error(
      'Google returned no refresh token. Remove this app at https://myaccount.google.com/permissions and run again.',
    );
  }

  // Unticked boxes on the consent screen grant a subset; catch that here
  // rather than as a 403 on the first readiness call.
  const granted = new Set((token.scope ?? '').split(/\s+/));
  const denied = GOOGLE_HEALTH_SCOPES.filter((s) => !granted.has(s));
  if (denied.length > 0) {
    throw new Error(`These scopes were not granted, so readiness cannot be judged: ${denied.join(', ')}. Run again and allow them.`);
  }

  const secretString = JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: token.refresh_token,
  });
  const sm = new SecretsManagerClient({ region });
  try {
    await sm.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: secretString }));
  } catch (error) {
    if ((error as { name?: string }).name !== 'ResourceNotFoundException') throw error;
    await sm.send(
      new CreateSecretCommand({
        Name: secretName,
        Description: 'Google Health API grant for the portfolio MCP get_readiness tool',
        SecretString: secretString,
      }),
    );
  }

  console.log(`\nStored the Google Health grant in Secrets Manager: ${secretName} (${region}).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
