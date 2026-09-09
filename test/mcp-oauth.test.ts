import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  protectedResourceHandler,
  authorizationServerHandler,
  challengeHeader,
} from '../lambda/mcp-oauth';

const RESOURCE = 'https://mcp.example.com/mcp';
const PRM = 'https://mcp.example.com/.well-known/oauth-protected-resource';
const AUTH_DOMAIN = 'https://nakamata-cv-test.auth.us-west-1.amazoncognito.com';
const ISSUER = 'https://cognito-idp.us-west-1.amazonaws.com/us-west-1_pool';

const event = {} as APIGatewayProxyEvent;

const setEnv = () => {
  process.env.MCP_RESOURCE_URL = RESOURCE;
  process.env.MCP_PRM_URL = PRM;
  process.env.COGNITO_AUTH_DOMAIN = AUTH_DOMAIN;
  process.env.COGNITO_ISSUER = ISSUER;
  process.env.MCP_SCOPES = 'openid email profile mcp/admin';
};

beforeEach(setEnv);

test('protected-resource metadata names this resource and its authorization server', async () => {
  const result = await protectedResourceHandler(event);
  const body = JSON.parse(result.body);

  expect(result.statusCode).toBe(200);
  // `resource` is what the client must request a token for, and what the server
  // then checks the token's audience against; the two must agree exactly.
  expect(body.resource).toBe(RESOURCE);
  expect(body.authorization_servers).toEqual([ISSUER]);
  expect(body.scopes_supported).toContain('mcp/admin');
  expect(body.bearer_methods_supported).toEqual(['header']);
});

test('authorization-server metadata points at the hosted domain, not the issuer host', async () => {
  const result = await authorizationServerHandler(event);
  const body = JSON.parse(result.body);

  expect(result.statusCode).toBe(200);
  expect(body.issuer).toBe(ISSUER);
  // The split matters: Cognito's own discovery document advertises the issuer
  // host for every endpoint, but the browser must reach authorize/token on the
  // hosted domain. Serving our own document is the whole point of this handler.
  expect(body.authorization_endpoint).toBe(`${AUTH_DOMAIN}/oauth2/authorize`);
  expect(body.token_endpoint).toBe(`${AUTH_DOMAIN}/oauth2/token`);
  expect(body.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
});

test('S256 PKCE is advertised, since a client finding none must refuse to proceed', async () => {
  const body = JSON.parse((await authorizationServerHandler(event)).body);
  expect(body.code_challenge_methods_supported).toEqual(['S256']);
  expect(body.response_types_supported).toEqual(['code']);
});

test('no registration endpoint is advertised, because Cognito has no DCR', async () => {
  const prm = JSON.parse((await protectedResourceHandler(event)).body);
  const as = JSON.parse((await authorizationServerHandler(event)).body);

  // Advertising one Cognito cannot honour would send clients into a flow that
  // always fails; this server is single-user and pre-registers its client.
  expect(as.registration_endpoint).toBeUndefined();
  expect(prm.registration_endpoint).toBeUndefined();
});

test('a trailing slash on the configured URLs does not produce a doubled path', async () => {
  process.env.COGNITO_AUTH_DOMAIN = `${AUTH_DOMAIN}/`;
  process.env.COGNITO_ISSUER = `${ISSUER}/`;

  const body = JSON.parse((await authorizationServerHandler(event)).body);

  expect(body.token_endpoint).toBe(`${AUTH_DOMAIN}/oauth2/token`);
  expect(body.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
});

test('missing configuration fails loudly rather than serving a half-built document', async () => {
  delete process.env.COGNITO_AUTH_DOMAIN;

  expect((await protectedResourceHandler(event)).statusCode).toBe(500);
  expect((await authorizationServerHandler(event)).statusCode).toBe(500);
});

test('the challenge carries the metadata URL a client needs to begin the flow', () => {
  const header = challengeHeader('invalid_token', 'expired');

  expect(header).toMatch(/^Bearer /);
  expect(header).toContain(`resource_metadata="${PRM}"`);
  expect(header).toContain('error="invalid_token"');
  expect(header).toContain('error_description="expired"');
});

test('the challenge is still well-formed with no error detail', () => {
  expect(challengeHeader()).toBe(`Bearer resource_metadata="${PRM}"`);
});
