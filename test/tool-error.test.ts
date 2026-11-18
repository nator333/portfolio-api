import { TOOL_ERROR_CODES, toolError, toolErrorFromResponse } from '../lambda/tool-error';

const res = (status: number, body: unknown) => toolErrorFromResponse(status, JSON.stringify(body));

describe('reading a REST failure as a tool error', () => {
  it.each([
    [400, {}, 'invalid_input', 'after_fix'],
    [404, {}, 'not_found', 'after_fix'],
    [409, {}, 'stale_version', 'after_reread'],
    [412, {}, 'stale_version', 'after_reread'],
    [502, { kind: 'api' }, 'upstream_unavailable', 'now'],
    [503, { kind: 'auth' }, 'upstream_auth', 'owner_action'],
    [500, {}, 'internal', 'never'],
  ])('should read a %i %j as %s, retry %s', (status, body, code, retry) => {
    expect(res(status, { message: 'x', ...body })).toMatchObject({ code, retry });
  });

  it('should let the handler name the code where the status is ambiguous', () => {
    // A 409 is a stale version unless the handler says otherwise.
    expect(res(409, { code: 'rule_violation', message: 'too much volume', breaches: ['chest'] })).toEqual({
      code: 'rule_violation',
      message: 'too much volume',
      retry: 'after_fix',
      details: { breaches: ['chest'] },
    });
    expect(res(409, { code: 'limit_reached', message: 'full', fix: 'Edit an entry instead.' })).toEqual({
      code: 'limit_reached',
      message: 'full',
      retry: 'never',
      fix: 'Edit an entry instead.',
    });
  });

  it('should ignore a code the handler made up', () => {
    expect(res(404, { code: 'nope', message: 'x' }).code).toBe('not_found');
  });

  it('should reduce zod issues to the path and the reason', () => {
    const error = res(400, {
      message: 'Invalid health note',
      errors: [
        { code: 'too_small', minimum: 1, origin: 'string', path: ['text'], message: 'Too small' },
        { code: 'invalid_type', expected: 'object', path: [], message: 'Expected object' },
        { code: 'custom', path: ['notes', '20261118T130000Z-a1b2', 'text'], message: 'Required' },
      ],
    });

    expect(error.details).toEqual({
      issues: [
        { path: 'text', message: 'Too small' },
        { path: '(root)', message: 'Expected object' },
        { path: 'notes.20261118T130000Z-a1b2.text', message: 'Required' },
      ],
    });
  });

  it('should keep extra body fields, like candidates, as details', () => {
    expect(res(404, { message: 'No exercise matching "bench"', requested: 'bench', candidates: ['Bench Press'] })).toEqual({
      code: 'not_found',
      message: 'No exercise matching "bench"',
      retry: 'after_fix',
      details: { requested: 'bench', candidates: ['Bench Press'] },
    });
  });

  it('should not echo the Google client\'s `kind` once it has become the code', () => {
    expect(res(503, { message: 'refused', kind: 'auth' }).details).toBeUndefined();
  });

  it('should cope with a body that is not JSON, or no body', () => {
    expect(toolErrorFromResponse(502, 'Bad Gateway')).toMatchObject({ code: 'upstream_unavailable', message: 'Bad Gateway' });
    expect(toolErrorFromResponse(500, undefined)).toMatchObject({ code: 'internal', message: 'Request failed with status 500' });
  });

  it('should state the next step for the codes that have an obvious one', () => {
    expect(toolError('stale_version', 'x').fix).toMatch(/Read it again/);
    expect(toolError('upstream_auth', 'x').fix).toMatch(/npm run health:auth/);
    expect(toolError('invalid_input', 'x').fix).toBeUndefined();
  });

  it('should give every code a retry rule', () => {
    for (const code of TOOL_ERROR_CODES) expect(toolError(code, 'x').retry).toBeDefined();
  });
});
