import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// The delegated handlers are stubbed so the MCP dispatch and — above all — the
// write gate can be tested without AWS. Only the two tools exercised here are
// mocked; the rest are imported for their module side effects but never called.
const mockGetCv = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
const mockUpdateCv = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
jest.mock('../lambda/get-cv', () => ({ handler: mockGetCv }));
jest.mock('../lambda/update-cv', () => ({ handler: mockUpdateCv }));
const mockPublicBlog = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
const mockAdminBlog = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
jest.mock('../lambda/get-blog', () => ({
  blogReader: (includeDrafts: boolean) => (event: APIGatewayProxyEvent) =>
    includeDrafts ? mockAdminBlog(event) : mockPublicBlog(event),
}));
const mockListReflections = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
jest.mock('../lambda/list-reflections', () => ({ handler: mockListReflections }));
const mockListHealthLog = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
jest.mock('../lambda/list-health-log', () => ({ handler: mockListHealthLog }));
const mockRevisePlan = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
const mockUpdatePlan = jest.fn<Promise<APIGatewayProxyResult>, [APIGatewayProxyEvent]>();
jest.mock('../lambda/revise-workout-plan', () => ({ handler: mockRevisePlan }));
jest.mock('../lambda/update-workout-plan', () => ({ handler: mockUpdatePlan }));

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
  mockPublicBlog.mockReset();
  mockAdminBlog.mockReset();
  mockListReflections.mockReset();
  mockListHealthLog.mockReset();
  mockRevisePlan.mockReset();
  mockUpdatePlan.mockReset();
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
  // The verb and error conventions are stated once, server-wide.
  expect(json.result.instructions).toMatch(/merge patch/);
  expect(json.result.instructions).toMatch(/retry/);
});

test('the initialized notification is acknowledged with 202 and no body', async () => {
  const result = await handler(rpcEvent({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  expect(result.statusCode).toBe(202);
  expect(result.body).toBe('');
});

test('tools/list advertises every tool in the catalogue', async () => {
  const { json } = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  expect(json.result.tools).toHaveLength(18);
  expect(json.result.tools.map((t: { name: string }) => t.name)).toContain('get_content');
});

test('get_content returns the document with the version replace_content needs', async () => {
  mockGetCv.mockResolvedValue({
    statusCode: 200,
    headers: { ETag: '"v1"' },
    body: JSON.stringify({ summary: 'hi' }),
  } as APIGatewayProxyResult);

  const { json } = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_content', arguments: { doc: 'cv' } } });

  expect(mockGetCv).toHaveBeenCalledTimes(1);
  expect(json.result.isError).toBe(false);
  expect(JSON.parse(json.result.content[0].text)).toEqual({ doc: 'cv', version: 'v1', document: { summary: 'hi' } });
});

test('get_content shows the blog drafts to the verified admin only', async () => {
  const blog = { statusCode: 200, headers: { ETag: '"b1"' }, body: '{"posts":[]}' } as APIGatewayProxyResult;
  mockPublicBlog.mockResolvedValue(blog);
  mockAdminBlog.mockResolvedValue(blog);
  const args = { name: 'get_content', arguments: { doc: 'blog' } };

  await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: args });
  expect(mockPublicBlog).toHaveBeenCalledTimes(1);
  expect(mockAdminBlog).not.toHaveBeenCalled();

  // A token that fails verification is simply not admin; the read still works.
  mockVerify.mockRejectedValueOnce(new Error('bad'));
  const { json } = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: args }, { Authorization: 'Bearer bad' });
  expect(json.result.isError).toBe(false);
  expect(mockAdminBlog).not.toHaveBeenCalled();

  mockVerify.mockResolvedValue(adminPayload());
  await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: args }, { Authorization: 'Bearer good' });
  expect(mockAdminBlog).toHaveBeenCalledTimes(1);
});

test('an admin tool with no bearer token returns 401 with a discovery challenge', async () => {
  const result = await handler(
    rpcEvent({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'replace_content', arguments: { doc: 'cv', version: 'v1', document: { summary: 'new' } } } }),
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

test('reflection notes are private: reading them without a token is refused', async () => {
  // The first private read of personal writing rather than training data; the
  // gate must cover the read, not just the writes.
  const result = await handler(
    rpcEvent({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'list_reflections', arguments: {} } }),
  );

  expect(mockListReflections).not.toHaveBeenCalled();
  expect(result.statusCode).toBe(401);
});

test('list_reflections forwards its arguments as the query strings the handler reads', async () => {
  mockVerify.mockResolvedValue(adminPayload());
  mockListReflections.mockResolvedValue({ statusCode: 200, body: '{"count":0,"reflections":[]}' } as APIGatewayProxyResult);

  const { json } = await call(
    {
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'list_reflections', arguments: { type: 'life', from: '2026-09-01', theme: 'sleep', limit: 5 } },
    },
    { Authorization: 'Bearer good' },
  );

  expect(json.result.isError).toBe(false);
  expect(mockListReflections.mock.calls[0][0].queryStringParameters).toEqual({
    type: 'life',
    from: '2026-09-01',
    theme: 'sleep',
    limit: '5',
  });
});

test('an admin tool is refused with 401 when the token fails verification', async () => {
  mockVerify.mockRejectedValue(new Error('bad token'));

  const result = await handler(
    rpcEvent(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'replace_content', arguments: { doc: 'cv', version: 'v1', document: { summary: 'new' } } } },
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
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'replace_content', arguments: { doc: 'cv', version: 'v1', document: { summary: 'new' } } } },
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
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'replace_content', arguments: { doc: 'cv', version: 'v1', document: { summary: 'new' } } } },
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
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'replace_content', arguments: { doc: 'cv', version: 'v1', document: { summary: 'new' } } } },
    { Authorization: 'Bearer resource-bound' },
  );

  expect(statusCode).toBe(200);
  expect(mockUpdateCv).toHaveBeenCalledTimes(1);
});

test('an admin tool runs for a verified admin and passes the document through as the body', async () => {
  mockVerify.mockResolvedValue(adminPayload());
  mockUpdateCv.mockResolvedValue({
    statusCode: 200,
    headers: { ETag: '"v2"' },
    body: JSON.stringify({ summary: 'new' }),
  } as APIGatewayProxyResult);

  const { json } = await call(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'replace_content', arguments: { doc: 'cv', version: 'v1', document: { summary: 'new' } } } },
    { Authorization: 'Bearer good' },
  );

  expect(mockUpdateCv).toHaveBeenCalledTimes(1);
  const passedEvent = mockUpdateCv.mock.calls[0][0];
  expect(JSON.parse(passedEvent.body ?? '')).toEqual({ summary: 'new' });
  // The version read goes to the writer as If-Match; the new one comes back.
  expect(passedEvent.headers['If-Match']).toBe('"v1"');
  expect(json.result.isError).toBe(false);
  expect(JSON.parse(json.result.content[0].text)).toEqual({ doc: 'cv', version: 'v2', document: { summary: 'new' } });
});

test('replace_content refuses to write without the version it read', async () => {
  mockVerify.mockResolvedValue(adminPayload());

  const { json } = await call(
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'replace_content', arguments: { doc: 'cv', document: { summary: 'new' } } } },
    { Authorization: 'Bearer good' },
  );

  expect(json.result.isError).toBe(true);
  expect(json.result.content[0].text).toMatch(/version/);
  expect(mockUpdateCv).not.toHaveBeenCalled();
});

test('replace_content surfaces a stale version as a tool error', async () => {
  mockVerify.mockResolvedValue(adminPayload());
  mockUpdateCv.mockResolvedValue({ statusCode: 412, body: JSON.stringify({ message: 'The cv document changed since it was read.' }) } as APIGatewayProxyResult);

  const { json } = await call(
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'replace_content', arguments: { doc: 'cv', version: 'old', document: { summary: 'new' } } } },
    { Authorization: 'Bearer good' },
  );

  expect(json.result.isError).toBe(true);
  expect(json.result.content[0].text).toMatch(/changed since it was read/);
});

test('get_content refuses a doc it does not know, including prototype names', async () => {
  for (const doc of ['resume', 'constructor']) {
    const { json } = await call({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_content', arguments: { doc } } });
    expect(json.result.isError).toBe(true);
    // Refused by the tool's own schema, before any handler is looked up.
    expect(json.result.structuredContent.error).toMatchObject({
      code: 'invalid_input',
      details: { issues: [{ path: 'doc', message: expect.stringContaining('"cv"') }] },
    });
  }
  expect(mockGetCv).not.toHaveBeenCalled();
});

describe('revise_workout_plan', () => {
  const ok = { statusCode: 201, body: '{}' } as APIGatewayProxyResult;
  /** The smallest plan version the tool's schema accepts. */
  const PLAN = {
    planId: 'upper-lower',
    version: 4,
    name: 'Upper/Lower',
    sessionsPerWeek: 1,
    rotation: ['upper-a'],
    bonusSessions: [],
    sessions: [
      {
        id: 'upper-a',
        name: 'Upper A',
        notes: '',
        exercises: [
          { order: 1, options: ['Bench Press'], muscle: 'Chest', sets: { min: 3, max: 3 }, reps: { min: 8, max: 10 }, rpe: null, notes: '' },
        ],
      },
    ],
    effectiveFrom: null,
    effectiveTo: null,
    notes: '',
  };
  const revise = (args: Record<string, unknown>) =>
    call(
      { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'revise_workout_plan', arguments: args } },
      { Authorization: 'Bearer good' },
    );

  beforeEach(() => {
    mockVerify.mockResolvedValue(adminPayload());
    mockRevisePlan.mockResolvedValue(ok);
    mockUpdatePlan.mockResolvedValue(ok);
  });

  test('edits go to the revise handler unchanged', async () => {
    const args = { changeNote: 'swap', baseVersion: 2, edits: [{ op: 'remove', session: 'upper-a', order: 3 }] };
    await revise(args);

    expect(mockUpdatePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mockRevisePlan.mock.calls[0][0].body ?? '')).toEqual(args);
  });

  test('a whole plan is published as a new version, carrying the changeNote into it', async () => {
    await revise({ changeNote: 'new block', plan: PLAN });

    expect(mockRevisePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mockUpdatePlan.mock.calls[0][0].body ?? '')).toEqual({
      ...PLAN,
      changeNote: 'new block',
    });
  });

  test("the plan's own changeNote wins over the tool's", async () => {
    await revise({ changeNote: 'outer', plan: { ...PLAN, changeNote: 'inner' } });
    expect(JSON.parse(mockUpdatePlan.mock.calls[0][0].body ?? '').changeNote).toBe('inner');
  });

  test('a plan sent with edits is refused and nothing is written', async () => {
    const { json } = await revise({
      changeNote: 'both',
      plan: PLAN,
      edits: [{ op: 'remove', session: 'upper-a', order: 1 }],
    });

    expect(json.result.isError).toBe(true);
    expect(json.result.structuredContent.error).toMatchObject({
      code: 'invalid_input',
      details: { issues: [{ path: 'edits', message: expect.stringMatching(/Only with `edits`/) }] },
    });
    expect(mockRevisePlan).not.toHaveBeenCalled();
    expect(mockUpdatePlan).not.toHaveBeenCalled();
  });
});

test('a delegated handler error surfaces as an MCP tool error, not a crash', async () => {
  mockGetCv.mockResolvedValue({ statusCode: 404, body: JSON.stringify({ message: 'CV data not found' }) } as APIGatewayProxyResult);

  const { json } = await call({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_content', arguments: { doc: 'cv' } } });

  expect(json.result.isError).toBe(true);
  const error = { code: 'not_found', message: 'CV data not found', retry: 'after_fix' };
  // The same object for clients that read structured results and for those
  // that read text: the HTTP status itself never reaches either.
  expect(json.result.structuredContent).toEqual({ error });
  expect(JSON.parse(json.result.content[0].text)).toEqual({ error });
});

test('a stale replace_content reads as stale_version: re-read, then retry', async () => {
  mockVerify.mockResolvedValue(adminPayload());
  mockUpdateCv.mockResolvedValue({ statusCode: 412, body: JSON.stringify({ message: 'The cv document changed since it was read.' }) } as APIGatewayProxyResult);

  const { json } = await call(
    { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'replace_content', arguments: { doc: 'cv', version: 'old', document: {} } } },
    { Authorization: 'Bearer good' },
  );

  expect(json.result.structuredContent.error).toMatchObject({ code: 'stale_version', retry: 'after_reread' });
});

test('a handler that throws is an internal error with an incident id, not "try again"', async () => {
  mockGetCv.mockRejectedValue(new Error('DynamoDB is down'));
  const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

  const { json } = await call({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'get_content', arguments: { doc: 'cv' } } });

  const { error } = json.result.structuredContent;
  expect(error).toMatchObject({ code: 'internal', retry: 'never' });
  const incident = /incident ([0-9a-f-]{36})/.exec(error.message)?.[1];
  expect(incident).toBeDefined();
  // The same id is in the log line, and the cause is not leaked to the caller.
  expect(JSON.stringify(logged.mock.calls)).toContain(incident);
  expect(error.message).not.toContain('DynamoDB');
  logged.mockRestore();
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

describe('arguments are checked once, against the schema tools/list advertises', () => {
  const list = (args: Record<string, unknown>) =>
    call(
      { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'list_reflections', arguments: args } },
      { Authorization: 'Bearer good' },
    );

  beforeEach(() => {
    mockVerify.mockResolvedValue(adminPayload());
    mockListReflections.mockResolvedValue({ statusCode: 200, body: '{"count":0,"reflections":[]}' } as APIGatewayProxyResult);
  });

  it('should hand the handler the parsed arguments as query strings', async () => {
    await list({ limit: 5, theme: ' Sleep ', from: '2026-11-01' });

    // Numbers stringified as a URL would; the theme normalised by its schema.
    expect(mockListReflections.mock.calls[0][0].queryStringParameters).toEqual({
      limit: '5',
      theme: 'sleep',
      from: '2026-11-01',
    });
  });

  it.each([
    ['an argument the tool does not take', { limt: 5 }, '(root)'],
    ['a number out of range', { limit: 1000 }, 'limit'],
    ['a wrong type', { limit: '5' }, 'limit'],
    ['a malformed date', { from: '1 Nov' }, 'from'],
  ])('should refuse %s before the handler runs', async (_label, args, path) => {
    const { json } = await list(args);

    expect(json.result.isError).toBe(true);
    expect(json.result.structuredContent.error.code).toBe('invalid_input');
    expect(json.result.structuredContent.error.details.issues[0].path).toBe(path);
    expect(mockListReflections).not.toHaveBeenCalled();
  });

  it('should treat missing arguments as an empty object', async () => {
    const { json } = await call(
      { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'list_reflections' } },
      { Authorization: 'Bearer good' },
    );

    expect(json.result.isError).toBe(false);
    expect(mockListReflections.mock.calls[0][0].queryStringParameters).toEqual({});
  });
});

describe('structured results for the tools with an outputSchema', () => {
  it('should advertise outputSchema on exactly the two tools whose results carry the costliest rules', async () => {
    const { json } = await call({ jsonrpc: '2.0', id: 30, method: 'tools/list' });
    const withOutput = json.result.tools.filter((t: { outputSchema?: unknown }) => t.outputSchema).map((t: { name: string }) => t.name);
    expect(withOutput.sort()).toEqual(['get_readiness', 'list_health_log']);
  });

  it('should return structuredContent beside the text, and log a mismatch without failing the read', async () => {
    mockVerify.mockResolvedValue(adminPayload());
    // A result the schema does not expect: `count` should be a number.
    const body = { from: '2026-11-05', to: '2026-11-18', count: 'one', days: [] };
    mockListHealthLog.mockResolvedValue({ statusCode: 200, body: JSON.stringify(body) } as APIGatewayProxyResult);
    const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { json } = await call(
      { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'list_health_log', arguments: {} } },
      { Authorization: 'Bearer good' },
    );

    expect(json.result.isError).toBe(false);
    expect(json.result.structuredContent).toEqual(body);
    expect(JSON.parse(json.result.content[0].text)).toEqual(body);
    expect(warned).toHaveBeenCalledWith(
      'MCP output does not match its outputSchema',
      expect.objectContaining({ tool: 'list_health_log', issues: [expect.objectContaining({ path: 'count' })] }),
    );
    warned.mockRestore();
  });

  it('should not add structuredContent to the other tools', async () => {
    mockGetCv.mockResolvedValue({ statusCode: 200, headers: { ETag: '"v1"' }, body: '{"summary":"hi"}' } as APIGatewayProxyResult);

    const { json } = await call({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'get_content', arguments: { doc: 'cv' } } });

    expect(json.result).not.toHaveProperty('structuredContent');
  });
});
