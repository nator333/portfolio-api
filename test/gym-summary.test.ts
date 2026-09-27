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

import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { handler } from '../lambda/gym-summary';

const streamEvent = (...keys: [string, string][]): DynamoDBStreamEvent => ({
  Records: keys.map(([type, sk]) => ({
    eventName: 'INSERT',
    dynamodb: { Keys: { type: { S: type }, sk: { S: sk } } },
  })),
});

const reply = (text: string) => ({ content: [{ type: 'text', text }] });
const sent = <T>(cls: new (...args: never[]) => T): T[] =>
  mockSend.mock.calls.map(([c]) => c).filter((c): c is T => c instanceof cls);

describe('gym-summary handler', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockCreate.mockReset();
    Object.assign(process.env, {
      REFLECTIONS_TABLE_NAME: 'reflections',
      GITHUB_SUMMARY_TABLE_NAME: 'summaries',
      BEDROCK_REGION: 'us-west-2',
      SUMMARY_MODEL_ID: 'us.anthropic.test',
    });
  });

  test("summarises every workout note of the changed day, oldest first, and stores the line", async () => {
    mockSend.mockImplementation(async (command: unknown) =>
      command instanceof QueryCommand
        ? {
            Items: [
              { body: 'Deadlift felt heavy.', createdAt: '2026-09-20T12:00:00Z' },
              { body: 'Squat 140x5.', createdAt: '2026-09-20T09:00:00Z' },
            ],
          }
        : {},
    );
    mockCreate.mockResolvedValue(reply('Hit 140 kg squats; deadlifts felt heavy.'));

    await handler(streamEvent(['workout', '2026-09-20#a'], ['workout', '2026-09-20#b']));

    // Two records on one day are one summary.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const query = sent(QueryCommand)[0];
    expect(query.input.ExpressionAttributeValues).toEqual({ ':type': 'workout', ':prefix': '2026-09-20#' });
    const prompt = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(prompt.indexOf('Squat 140x5.')).toBeLessThan(prompt.indexOf('Deadlift felt heavy.'));

    const [put] = sent(PutCommand);
    expect(put.input.TableName).toBe('summaries');
    expect(put.input.Item).toMatchObject({
      pk: 'GYM_DAY',
      date: '2026-09-20',
      summary: 'Hit 140 kg squats; deadlifts felt heavy',
      noteCount: 2,
    });
  });

  test('ignores life notes even if the event-source filter let one through', async () => {
    await handler(streamEvent(['life', '2026-09-20#a']));
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('removes the line when the model finds nothing shareable', async () => {
    mockSend.mockImplementation(async (command: unknown) =>
      command instanceof QueryCommand ? { Items: [{ body: 'Only personal things today.' }] } : {},
    );
    mockCreate.mockResolvedValue(reply('-'));

    await handler(streamEvent(['workout', '2026-09-20#a']));

    expect(sent(PutCommand)).toHaveLength(0);
    expect(sent(DeleteCommand)[0].input.Key).toEqual({ pk: 'GYM_DAY', date: '2026-09-20' });
  });

  test('a Bedrock failure propagates so the stream retries the day', async () => {
    mockSend.mockResolvedValue({ Items: [{ body: 'Bench 100x5.' }] });
    mockCreate.mockRejectedValue(new Error('throttled'));

    await expect(handler(streamEvent(['workout', '2026-09-20#a']))).rejects.toThrow('throttled');
    expect(sent(DeleteCommand)).toHaveLength(0);
  });

  test('a hand-run backfill summarises each workout note day in the window', async () => {
    mockSend.mockImplementation(async (command: QueryCommand) => {
      if (command instanceof QueryCommand && command.input.ProjectionExpression === 'sk') {
        return { Items: [{ sk: '2026-09-18#a' }, { sk: '2026-09-18#b' }, { sk: '2026-09-19#c' }] };
      }
      return command instanceof QueryCommand ? { Items: [{ body: 'Rows.' }] } : {};
    });
    mockCreate.mockResolvedValue(reply('Worked on rows'));

    await handler({ backfillDays: 30 });

    expect(sent(PutCommand).map((p) => p.input.Item?.date)).toEqual(['2026-09-18', '2026-09-19']);
  });
});
