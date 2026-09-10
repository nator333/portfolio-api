import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// The delegated handlers are stubbed so the MCP dispatch and — above all — the
// write gate can be tested without AWS. Only the two tools exercised here are
// mocked; the rest are imported for their module side effects but never called.
const mockGetCv = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
const mockUpdateCv = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
jest.mock('../lambda/get-cv', () => ({ handler: mockGetCv }));
jest.mock('../lambda/update-cv', () => ({ handler: mockUpdateCv }));

// Stub the Cognito access-token verifier: create() hands back an object whose
// verify each test drives to accept or reject.
const mockVerify = jest.fn();
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: mockVerify }) },
}));

import { handler } from '../lambda/mcp';

function rpcEvent(body: unknown, headers: Record<string, string> = {}): APIGatewayProxyEvent {
  return { body: JSON.stringify(body), headers } as unknown as APIGatewayProxyEvent;
}

async function call(body: unknown, headers?: Record<string, string>) {
  const result = await handler(rpcEvent(body, headers));
  return { statusCode: result.statusCode, json: result.body ? JSON.parse(result.body) : undefined };
}

const MCP_CLIENT = 'mcpclient123';
const RESOURCE = 'https://mcp.example.com/mcp';

beforeAll(() => {
  process.env.USER_POOL_ID = 'us-west-1_pool';
  process.env.MCP_CLIENT_IDS = `${MCP_CLIENT},spaclient456`;
  process.env.MCP_RESOURCE_URL = RESOURCE;
  process.env.MCP_PRM_URL = 'https://mcp.example.com/.well-known/oauth-protected-resource';
  process.env.MCP_ADMIN_SCOPE = 'mcp/admin';
});

/** A verified access-token payload for the admin, as Cognito would mint it. */
const adminPayload = (over: Record<string, unknown> = {}) => ({
  sub: 'user-1',
  client_id: MCP_CLIENT,
  scope: 'openid email mcp/admin',
  ...over,
});

beforeEach(() => {
  mockGetCv.mockReset();
  mockUpdateCv.mockReset();
  mockVerify.mockReset();
});

test('initialize returns the server info and echoes the requested protocol version', async () => {
  const { statusCode, json } = await call({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  });

  expect(statusCode).toBe(200);
  expect(json.result.serverInfo.name).toBe('portfolio-api');
  expect(json.result.protocolVersion).toBe('2024-11-05');
  expect(json.result.capabilities.tools).toBeDefined();
});

test('the initialized notification is acknowledged with 202 and no body', async () => {
  const result = await handler(rpcEvent({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  expect(result.statusCode).toBe(202);
  expect(result.body).toBe('');
});

test('tools/list advertises all sixteen tools', async () => {
  const { json } = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  expect(json.result.tools).toHaveLength(18);
  expect(json.result.tools.map((t: { name: string }) => t.name)).toContain('get_cv');
});

test('a public read tool delegates to its handler and returns the body verbatim', async () => {
  mockGetCv.mockResolvedValue({ statusCode: 200, body: JSON.stringify({ summary: 'hi' }) } as APIGatewayProxyResult);

  const { json } = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_cv' } });

  expect(mockGetCv).toHaveBeenCalledTimes(1);
  expect(json.result.isError).toBe(false);
  expect(JSON.parse(json.result.content[0].text)).toEqual({ summary: 'hi' });
});

test('an admin tool with no bearer token returns 401 with a discovery challenge', async () => {
  const result = await handler(
    rpcEvent({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'update_cv', arguments: { summary: 'new' } } }),
  );

  expect(mockUpdateCv).not.toHaveBeenCalled();
  // A 200 carrying an error message would leave an MCP client with nothing to
  // discover, so the OAuth flow would never start. The challenge is the point.
  expect(result.statusCode).toBe(401);
  expect(result.headers?.['WWW-Authenticate']).toContain('Bearer');
  expect(result.headers?.['WWW-Authenticate']).toContain(
    'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
  );
});

test('an admin tool is refused with 401 when the token fails verification', async () => {
  mockVerify.mockRejectedValue(new Error('bad token'));

  const result = await handler(
    rpcEvent(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'update_cv', arguments: { summary: 'new' } } },
      { Authorization: 'Bearer nonsense' },
    ),
  );

  expect(mockUpdateCv).not.toHaveBeenCalled();
  expect(result.statusCode).toBe(401);
  expect(result.headers?.['WWW-Authenticate']).toContain('error="invalid_token"');
});

test('a token minted for another client is refused even though it verifies', async () => {
  // Signature and issuer are fine; the audience is not this resource. Without
  // this check any token from the pool would open the admin tools.
  mockVerify.mockResolvedValue(adminPayload({ client_id: 'someone-elses-client' }));

  const result = await handler(
    rpcEvent(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'update_cv', arguments: { summary: 'new' } } },
      { Authorization: 'Bearer valid-but-foreign' },
    ),
  );

  expect(mockUpdateCv).not.toHaveBeenCalled();
  expect(result.statusCode).toBe(401);
  expect(JSON.parse(result.body).error_description).toMatch(/not issued for this resource/);
});

test('a token without the admin scope is refused as insufficient_scope', async () => {
  mockVerify.mockResolvedValue(adminPayload({ scope: 'openid email' }));

  const result = await handler(
    rpcEvent(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'update_cv', arguments: { summary: 'new' } } },
      { Authorization: 'Bearer no-scope' },
    ),
  );

  expect(mockUpdateCv).not.toHaveBeenCalled();
  expect(result.statusCode).toBe(401);
  expect(result.headers?.['WWW-Authenticate']).toContain('error="insufficient_scope"');
});

test('an aud claim naming this resource is accepted even without a known client_id', async () => {
  // Cognito resource binding puts the requested resource in `aud`; a pool on a
  // tier without it falls back to client_id. Both must open the gate.
  mockVerify.mockResolvedValue(adminPayload({ client_id: 'unknown', aud: RESOURCE }));
  mockUpdateCv.mockResolvedValue({ statusCode: 200, body: JSON.stringify({ summary: 'new' }) } as APIGatewayProxyResult);

  const { statusCode } = await call(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'update_cv', arguments: { summary: 'new' } } },
    { Authorization: 'Bearer resource-bound' },
  );

  expect(statusCode).toBe(200);
  expect(mockUpdateCv).toHaveBeenCalledTimes(1);
});

test('an admin tool runs for a verified admin and passes the arguments through as the body', async () => {
  mockVerify.mockResolvedValue(adminPayload());
  mockUpdateCv.mockResolvedValue({ statusCode: 200, body: JSON.stringify({ summary: 'new' }) } as APIGatewayProxyResult);

  const { json } = await call(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'update_cv', arguments: { summary: 'new' } } },
    { Authorization: 'Bearer good' },
  );

  expect(mockUpdateCv).toHaveBeenCalledTimes(1);
  const passedEvent = mockUpdateCv.mock.calls[0][0];
  expect(JSON.parse(passedEvent.body ?? '')).toEqual({ summary: 'new' });
  expect(json.result.isError).toBe(false);
});

test('a delegated handler error surfaces as an MCP tool error, not a crash', async () => {
  mockGetCv.mockResolvedValue({ statusCode: 404, body: JSON.stringify({ message: 'CV data not found' }) } as APIGatewayProxyResult);

  const { json } = await call({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_cv' } });

  expect(json.result.isError).toBe(true);
  expect(json.result.content[0].text).toMatch(/not found/);
});

test('an unknown tool is an invalid-params JSON-RPC error', async () => {
  const { json } = await call({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } });
  expect(json.error.code).toBe(-32602);
});

test('an unknown method is a method-not-found JSON-RPC error', async () => {
  const { json } = await call({ jsonrpc: '2.0', id: 10, method: 'resources/list' });
  expect(json.error.code).toBe(-32601);
});

test('a non-JSON body is a parse error', async () => {
  const result = await handler({ body: 'not json', headers: {} } as unknown as APIGatewayProxyEvent);
  const json = JSON.parse(result.body);
  expect(json.error.code).toBe(-32700);
});

test('JSON-RPC batches are rejected as invalid requests', async () => {
  const result = await handler({ body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]), headers: {} } as unknown as APIGatewayProxyEvent);
  const json = JSON.parse(result.body);
  expect(json.error.code).toBe(-32600);
});
