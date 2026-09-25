import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  };
});

import { handler as addReflection } from '../lambda/add-reflection';
import { handler as listReflections } from '../lambda/list-reflections';
import { handler as updateReflection } from '../lambda/update-reflection';
import { addReflectionSchema, isReflectionId } from '../lambda/reflection-schema';

const TABLE = 'reflections-test';

const bodyEvent = (body: unknown): APIGatewayProxyEvent =>
  ({ body: JSON.stringify(body), headers: {} }) as unknown as APIGatewayProxyEvent;
const queryEvent = (query: Record<string, string> = {}): APIGatewayProxyEvent =>
  ({ queryStringParameters: query, headers: {} }) as unknown as APIGatewayProxyEvent;

const parse = (r: { statusCode: number; body: string }) => ({ statusCode: r.statusCode, body: JSON.parse(r.body) });

/** A stored note, as the add path writes it. */
const stored = (type: string, date: string, suffix: string, over: Record<string, unknown> = {}) => ({
  type,
  sk: `${date}#${suffix}`,
  date,
  body: `${type} on ${date}`,
  themes: [],
  createdAt: `${date}T20:00:00.000Z`,
  ...over,
});

beforeAll(() => {
  process.env.REFLECTIONS_TABLE_NAME = TABLE;
});

beforeEach(() => {
  mockSend.mockReset();
});

describe('adding a reflection', () => {
  it('should append a new item keyed by the day it is about, with normalised themes', async () => {
    mockSend.mockResolvedValueOnce({});

    const { statusCode, body } = parse(
      await addReflection(
        bodyEvent({
          type: 'workout',
          date: '2026-09-24',
          body: 'Bench felt heavy — "I was running on four hours of sleep".',
          themes: ['Sleep', ' sleep ', 'bench'],
        }),
      ),
    );

    expect(statusCode).toBe(201);
    const input = mockSend.mock.calls[0][0].input;
    expect(input.TableName).toBe(TABLE);
    // Never overwrite: a repeated add is a second note, not a replacement.
    expect(input.ConditionExpression).toBe('attribute_not_exists(sk)');
    expect(input.Item.type).toBe('workout');
    expect(input.Item.sk).toMatch(/^2026-09-24#[0-9a-f-]{36}$/);
    expect(input.Item.themes).toEqual(['sleep', 'bench']);
    expect(body.id).toBe(input.Item.sk);
    expect(body.sk).toBeUndefined();
  });

  it('should refuse an unknown type rather than letting the vocabulary drift', async () => {
    const { statusCode } = parse(
      await addReflection(bodyEvent({ type: 'workouts', date: '2026-09-24', body: 'x' })),
    );
    expect(statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('should require the date instead of guessing it in UTC', () => {
    expect(addReflectionSchema.safeParse({ type: 'life', body: 'x' }).success).toBe(false);
    expect(addReflectionSchema.safeParse({ type: 'life', body: 'x', date: '2026-02-30' }).success).toBe(false);
    expect(addReflectionSchema.safeParse({ type: 'life', body: '   ', date: '2026-02-03' }).success).toBe(false);
  });
});

describe('listing reflections', () => {
  it('should read one type over a date window, newest first, with inclusive day bounds', async () => {
    mockSend.mockResolvedValueOnce({ Items: [stored('workout', '2026-09-20', 'b'), stored('workout', '2026-09-10', 'a')] });

    const { statusCode, body } = parse(
      await listReflections(queryEvent({ type: 'workout', from: '2026-09-10', to: '2026-09-20' })),
    );

    expect(statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const input = mockSend.mock.calls[0][0].input;
    expect(input.ScanIndexForward).toBe(false);
    expect(input.ExpressionAttributeValues).toEqual({
      ':type': 'workout',
      ':lo': '2026-09-10#',
      ':hi': '2026-09-20$',
    });
    // The bounds must take in every note on the edge days and nothing past them.
    expect('2026-09-20#ffffffff' <= input.ExpressionAttributeValues[':hi']).toBe(true);
    expect('2026-09-21#00000000' > input.ExpressionAttributeValues[':hi']).toBe(true);
    expect(body.reflections.map((r: { id: string }) => r.id)).toEqual(['2026-09-20#b', '2026-09-10#a']);
  });

  it('should merge both types newest first and cap at the limit when no type is given', async () => {
    mockSend.mockImplementation((command: { input: { ExpressionAttributeValues: Record<string, string> } }) =>
      Promise.resolve({
        Items:
          command.input.ExpressionAttributeValues[':type'] === 'workout'
            ? [stored('workout', '2026-09-22', 'w2'), stored('workout', '2026-09-18', 'w1')]
            : [stored('life', '2026-09-20', 'l1')],
      }),
    );

    const { body } = parse(await listReflections(queryEvent({ limit: '2' })));

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(body.count).toBe(2);
    expect(body.reflections.map((r: { id: string }) => r.id)).toEqual(['2026-09-22#w2', '2026-09-20#l1']);
  });

  it('should keep paging a theme-filtered read until it has enough matches', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { type: 'life', sk: 'x' } })
      .mockResolvedValueOnce({ Items: [stored('life', '2026-08-01', 'a', { themes: ['sleep'] })] });

    const { body } = parse(await listReflections(queryEvent({ type: 'life', theme: 'Sleep' })));

    expect(mockSend).toHaveBeenCalledTimes(2);
    const first = mockSend.mock.calls[0][0].input;
    expect(first.FilterExpression).toBe('contains(#themes, :theme)');
    expect(first.ExpressionAttributeValues[':theme']).toBe('sleep');
    // A Limit before a filter would return short pages that look like the end.
    expect(first.Limit).toBeUndefined();
    expect(mockSend.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ type: 'life', sk: 'x' });
    expect(body.count).toBe(1);
  });

  it('should refuse a reversed window', async () => {
    const { statusCode } = parse(await listReflections(queryEvent({ from: '2026-09-20', to: '2026-09-10' })));
    expect(statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('correcting a reflection', () => {
  it('should update only the supplied fields of an existing note', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: stored('life', '2026-09-01', 'abc', { body: 'fixed' }) });

    const { statusCode, body } = parse(
      await updateReflection(bodyEvent({ type: 'life', id: '2026-09-01#abc', body: 'fixed' })),
    );

    expect(statusCode).toBe(200);
    const input = mockSend.mock.calls[0][0].input;
    expect(input.Key).toEqual({ type: 'life', sk: '2026-09-01#abc' });
    expect(input.ConditionExpression).toBe('attribute_exists(sk)');
    expect(input.UpdateExpression).toBe('SET #updatedAt = :updatedAt, #body = :body');
    expect(body.id).toBe('2026-09-01#abc');
  });

  it('should answer 404, not upsert, when the note does not exist', async () => {
    mockSend.mockRejectedValueOnce(
      new ConditionalCheckFailedException({ message: 'nope', $metadata: {} }),
    );

    const { statusCode } = parse(
      await updateReflection(bodyEvent({ type: 'life', id: '2026-09-01#missing', themes: ['x'] })),
    );
    expect(statusCode).toBe(404);
  });

  it('should refuse an update that changes nothing, and an id it could never have minted', async () => {
    expect(parse(await updateReflection(bodyEvent({ type: 'life', id: '2026-09-01#abc' }))).statusCode).toBe(400);
    expect(parse(await updateReflection(bodyEvent({ type: 'life', id: 'garbage', body: 'x' }))).statusCode).toBe(404);
    expect(mockSend).not.toHaveBeenCalled();
    expect(isReflectionId('2026-09-01#abc')).toBe(true);
    expect(isReflectionId('2026-09-01#abc#def')).toBe(false);
  });
});
