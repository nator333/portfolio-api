import {
  MCP_PROTOCOL_VERSION,
  TOOL_SPECS,
  TOOL_SPECS_BY_NAME,
  jsonRpcRequestSchema,
} from '../lambda/mcp-schema';

test('every read tool is public and every write tool requires auth', () => {
  const publicTools = TOOL_SPECS.filter((t) => !t.requiresAuth).map((t) => t.name).sort();
  const authTools = TOOL_SPECS.filter((t) => t.requiresAuth).map((t) => t.name).sort();

  // The get_ tools are anonymous; list_media and every update_ tool are admin-only.
  expect(publicTools).toEqual([
    'get_activity',
    'get_blog',
    'get_cv',
    'get_home',
    'get_projects',
    'get_workout',
  ]);
  expect(authTools).toEqual([
    'list_media',
    'update_blog',
    'update_cv',
    'update_home',
    'update_media',
    'update_projects',
  ]);
});

test('read tools are annotated read-only and write tools are not', () => {
  for (const tool of TOOL_SPECS) {
    expect(tool.annotations.readOnlyHint).toBe(!tool.name.startsWith('update_'));
  }
});

test('tool names are unique and every spec is indexed by name', () => {
  const names = TOOL_SPECS.map((t) => t.name);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) {
    expect(TOOL_SPECS_BY_NAME.get(name)?.name).toBe(name);
  }
});

test('every tool exposes an object input schema', () => {
  for (const tool of TOOL_SPECS) {
    expect(tool.inputSchema.type).toBe('object');
  }
});

test('the JSON-RPC schema accepts requests and notifications but rejects junk', () => {
  expect(jsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).success).toBe(true);
  // A notification omits id.
  expect(jsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', method: 'notifications/initialized' }).success).toBe(true);
  // Wrong protocol tag and missing method are rejected.
  expect(jsonRpcRequestSchema.safeParse({ jsonrpc: '1.0', id: 1, method: 'x' }).success).toBe(false);
  expect(jsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: 1 }).success).toBe(false);
});

test('protocol version is a dated revision string', () => {
  expect(MCP_PROTOCOL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
