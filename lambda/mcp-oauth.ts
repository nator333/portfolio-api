import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

/**
 * OAuth discovery documents for the MCP server.
 *
 * The MCP authorization spec makes the resource server responsible for telling
 * a client where to authenticate: RFC 9728 protected-resource metadata, plus a
 * pointer to the authorization server's own metadata. Cognito publishes OIDC
 * discovery, but at its *issuer* host (`cognito-idp.<region>.amazonaws.com/
 * <poolId>`) while the authorize/token endpoints live on the hosted-domain host
 * (`<prefix>.auth.<region>.amazoncognito.com`). Clients that fetch one document
 * and expect every endpoint in it trip over that split, so this module serves a
 * single coherent metadata document naming the hosted-domain endpoints.
 *
 * These documents MUST sit at the domain root, which the default execute-api
 * URL cannot do — its stage is always the first path segment. That is why the
 * MCP API is fronted by its own custom domain; see lib/portfolio-api-stack.ts.
 *
 * There is deliberately no `registration_endpoint`: Cognito has no RFC 7591
 * dynamic client registration, and this server is single-user, so the app
 * client is pre-provisioned at deploy time instead.
 */

/** Cache for a day: these documents only change when the stack is redeployed. */
const CACHE_CONTROL = 'public, max-age=86400';

const json = (body: unknown): APIGatewayProxyResult => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': CACHE_CONTROL },
  body: JSON.stringify(body),
});

const configError = (message: string): APIGatewayProxyResult => ({
  statusCode: 500,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message }),
});

interface OAuthEnv {
  /** Canonical resource identifier, e.g. https://mcp.example.com/mcp */
  resource: string;
  /** Cognito hosted-domain base URL, e.g. https://prefix.auth.us-west-1.amazoncognito.com */
  authDomain: string;
  /** Cognito issuer, e.g. https://cognito-idp.us-west-1.amazonaws.com/<poolId> */
  issuer: string;
  /** Scopes this resource accepts. */
  scopes: string[];
}

function readEnv(): OAuthEnv | null {
  const resource = process.env.MCP_RESOURCE_URL;
  const authDomain = process.env.COGNITO_AUTH_DOMAIN;
  const issuer = process.env.COGNITO_ISSUER;
  if (!resource || !authDomain || !issuer) return null;
  return {
    resource,
    authDomain: authDomain.replace(/\/$/, ''),
    issuer: issuer.replace(/\/$/, ''),
    scopes: (process.env.MCP_SCOPES ?? '').split(/\s+/).filter(Boolean),
  };
}

/**
 * RFC 9728 protected-resource metadata. `authorization_servers` is the field a
 * client follows to find where to send the user; `resource` is what it must
 * then request a token *for*, and what this server checks the token's audience
 * against.
 */
export const protectedResourceHandler = async (
  _event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const env = readEnv();
  if (!env) return configError('MCP OAuth metadata is not configured on this deployment');

  return json({
    resource: env.resource,
    authorization_servers: [env.issuer],
    scopes_supported: env.scopes,
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/nator333/portfolio-api',
  });
};

/**
 * RFC 8414 authorization-server metadata, mirrored from Cognito.
 *
 * Served here rather than pointing straight at Cognito's own
 * /.well-known/openid-configuration because that document advertises the
 * issuer host for every endpoint, whereas the authorize/token endpoints a
 * browser must actually reach are on the hosted domain.
 */
export const authorizationServerHandler = async (
  _event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const env = readEnv();
  if (!env) return configError('MCP OAuth metadata is not configured on this deployment');

  return json({
    issuer: env.issuer,
    authorization_endpoint: `${env.authDomain}/oauth2/authorize`,
    token_endpoint: `${env.authDomain}/oauth2/token`,
    userinfo_endpoint: `${env.authDomain}/oauth2/userInfo`,
    revocation_endpoint: `${env.authDomain}/oauth2/revoke`,
    jwks_uri: `${env.issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only. A client that finds no code_challenge_methods_supported must
    // refuse to proceed, so advertising this is not optional.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: env.scopes,
  });
};

/**
 * The `WWW-Authenticate` value for an unauthenticated request, pointing at the
 * metadata document above. Without this header a client has no way to discover
 * that an OAuth flow is available — it just sees a failure — so every 401 from
 * the MCP endpoint carries it.
 */
export function challengeHeader(error?: string, description?: string): string {
  const prmUrl = process.env.MCP_PRM_URL ?? '';
  const parts = [`Bearer resource_metadata="${prmUrl}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description}"`);
  return parts.join(', ');
}
