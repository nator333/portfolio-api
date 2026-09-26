const mockSend = jest.fn();
const mockCreate = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: (command: unknown) => mockSend(command) }) },
  };
});

jest.mock('@anthropic-ai/bedrock-sdk', () => ({
  AnthropicBedrock: jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}));

import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../lambda/github-summary';

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, statusText: '', json: async () => body }) as Response;

describe('github-summary handler', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-26T00:20:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    mockSend.mockReset();
    mockCreate.mockReset();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    Object.assign(process.env, {
      GITHUB_SUMMARY_TABLE_NAME: 'summaries',
      GITHUB_USER: 'octocat',
      BEDROCK_REGION: 'us-west-2',
      SUMMARY_MODEL_ID: 'us.anthropic.test',
    });
  });

  afterEach(() => jest.useRealTimers());

  test('summarises finished days lacking a summary from their commits', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/events/public')) {
        return json([
          // Today: unfinished, never summarised.
          { type: 'PushEvent', created_at: '2026-09-26T00:05:00Z', repo: { name: 'octo/repo' }, payload: { ref: 'refs/heads/main', head: 'today' } },
          { type: 'PushEvent', created_at: '2026-09-25T10:00:00Z', repo: { name: 'octo/repo' }, payload: { ref: 'refs/heads/main', head: 'h25' } },
          // Already summarised.
          { type: 'PushEvent', created_at: '2026-09-24T10:00:00Z', repo: { name: 'octo/repo' }, payload: { ref: 'refs/heads/main', head: 'h24' } },
        ]);
      }
      if (url.includes('/commits?')) {
        expect(url).toContain('sha=h25');
        expect(url).toContain('since=2026-09-25T00%3A00%3A00Z');
        expect(url).toContain('until=2026-09-26T00%3A00%3A00Z');
        expect(url).toContain('author=octocat');
        return json([
          { sha: '2', commit: { message: 'Fix the calendar\n\nCo-Authored-By: A <a@b.c>' } },
          { sha: '1', commit: { message: 'Add the calendar' } },
        ]);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof QueryCommand) return { Items: [{ date: '2026-09-24' }] };
      return {};
    });
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Added and fixed the calendar.' }] });

    await handler();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const prompt = mockCreate.mock.calls[0][0].messages[0].content as string;
    // Oldest commit first.
    expect(prompt).toContain('- commit: Add the calendar\n- commit: Fix the calendar');

    const puts = mockSend.mock.calls.map(([c]) => c).filter((c) => c instanceof PutCommand);
    expect(puts).toHaveLength(1);
    expect(puts[0].input.Item).toMatchObject({
      pk: 'GITHUB_DAY',
      date: '2026-09-25',
      summary: 'Added and fixed the calendar.',
      repos: ['octo/repo'],
      commitCount: 2,
    });
    expect(puts[0].input.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  test('does nothing when every active day already has a summary', async () => {
    fetchMock.mockResolvedValue(
      json([{ type: 'PushEvent', created_at: '2026-09-25T10:00:00Z', repo: { name: 'octo/repo' }, payload: { ref: 'refs/heads/main', head: 'h' } }]),
    );
    mockSend.mockResolvedValue({ Items: [{ date: '2026-09-25' }] });

    await handler();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSend.mock.calls.some(([c]) => c instanceof PutCommand)).toBe(false);
  });

  test('skips storing an empty reply so the day is retried', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/events/public')
        ? json([{ type: 'PushEvent', created_at: '2026-09-25T10:00:00Z', repo: { name: 'octo/repo' }, payload: { ref: 'refs/heads/main', head: 'h' } }])
        : json([], 404),
    );
    mockSend.mockResolvedValue({ Items: [] });
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '   ' }] });

    await handler();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls.some(([c]) => c instanceof PutCommand)).toBe(false);
  });
});
