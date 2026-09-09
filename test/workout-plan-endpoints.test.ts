import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  };
});

import { handler as getPlan, DEFAULT_PLAN_ID } from '../lambda/get-workout-plan';
import { handler as updatePlan } from '../lambda/update-workout-plan';
import { UPPER_LOWER_V1 } from '../lambda/workout-plan-upper-lower';
import { planVersionItem } from '../lambda/workout-plan-schema';

const TABLE = 'portfolio-workout-plan-test';

const readEvent = (query: Record<string, string> = {}): APIGatewayProxyEvent =>
  ({ queryStringParameters: query, headers: {} }) as unknown as APIGatewayProxyEvent;

const writeEvent = (body: unknown): APIGatewayProxyEvent =>
  ({
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {},
  }) as unknown as APIGatewayProxyEvent;

const read = async (query: Record<string, string> = {}) => {
  const result = await getPlan(readEvent(query));
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
};

const write = async (body: unknown) => {
  const result = await updatePlan(writeEvent(body));
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
};

/** A stored version item, as the publish path writes it. */
const stored = (version: number, over: Record<string, unknown> = {}) =>
  planVersionItem({ ...UPPER_LOWER_V1, version, ...over });

/** The last command handed to DynamoDB, for asserting how it was queried. */
const lastInput = () => mockSend.mock.calls[mockSend.mock.calls.length - 1][0].input;

beforeAll(() => {
  process.env.WORKOUT_PLAN_TABLE_NAME = TABLE;
});

beforeEach(() => {
  mockSend.mockReset();
});

describe('reading the plan', () => {
  it('should return the newest version with one descending query when given no arguments', async () => {
    mockSend.mockResolvedValueOnce({ Items: [stored(3)] });

    const { statusCode, body } = await read();

    expect(statusCode).toBe(200);
    expect(body.version).toBe(3);
    expect(body.planId).toBe(DEFAULT_PLAN_ID);
    // The padded sort key exists so "latest" is one cheap query, not a scan.
    expect(lastInput().ScanIndexForward).toBe(false);
    expect(lastInput().Limit).toBe(1);
  });

  it('should drop the sort key from the returned document', async () => {
    mockSend.mockResolvedValueOnce({ Items: [stored(1)] });
    const { body } = await read();
    expect(body.sk).toBeUndefined();
    expect(body.sessions).toHaveLength(4);
  });

  it('should fetch an exact version by key', async () => {
    mockSend.mockResolvedValueOnce({ Item: stored(2) });

    const { statusCode, body } = await read({ version: '2' });

    expect(statusCode).toBe(200);
    expect(body.version).toBe(2);
    expect(lastInput().Key).toEqual({ planId: DEFAULT_PLAN_ID, sk: 'V#0002' });
  });

  it('should reject a version that is not a positive integer', async () => {
    const { statusCode } = await read({ version: 'latest' });
    expect(statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('should return the version in force on a date', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        stored(1, { effectiveFrom: '2026-01-01', effectiveTo: '2026-05-31' }),
        stored(2, { effectiveFrom: '2026-06-01', effectiveTo: '2026-08-31' }),
      ],
    });

    const { statusCode, body } = await read({ date: '2026-07-04' });

    expect(statusCode).toBe(200);
    expect(body.version).toBe(2);
  });

  it('should 404 when no version covers the requested date', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [stored(1, { effectiveFrom: '2026-01-01', effectiveTo: '2026-05-31' })],
    });

    const { statusCode, body } = await read({ date: '2026-12-25' });

    expect(statusCode).toBe(404);
    expect(body.message).toContain('2026-12-25');
  });

  it('should reject a malformed date without querying', async () => {
    const { statusCode } = await read({ date: '2026/07/04' });
    expect(statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('should list history as metadata projected away from the session detail', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { version: 2, name: 'Autumn block', effectiveFrom: null, effectiveTo: null, changeNote: 'more quads', createdAt: '2026-09-01T00:00:00.000Z' },
        { version: 1, name: 'Summer block', effectiveFrom: null, effectiveTo: '2026-08-31', changeNote: '', createdAt: '2026-06-01T00:00:00.000Z' },
      ],
    });

    const { statusCode, body } = await read({ history: 'true' });

    expect(statusCode).toBe(200);
    expect(body.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(lastInput().ProjectionExpression).toContain('#v');
  });

  it('should 404 when the plan has never been published', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    const { statusCode } = await read();
    expect(statusCode).toBe(404);
  });

  it('should paginate a partition that spans pages', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [stored(1)], LastEvaluatedKey: { planId: 'x', sk: 'V#0001' } })
      .mockResolvedValueOnce({ Items: [stored(2)] });

    const { body } = await read({ date: '2026-07-04' });

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(body.version).toBe(2);
  });
});

describe('publishing a plan version', () => {
  it('should append a new version guarded against overwriting an existing one', async () => {
    mockSend.mockResolvedValueOnce({});

    const { statusCode, body } = await write({ ...UPPER_LOWER_V1, version: 2 });

    expect(statusCode).toBe(201);
    expect(body.version).toBe(2);
    expect(lastInput().ConditionExpression).toBe('attribute_not_exists(sk)');
    expect(lastInput().Item.sk).toBe('V#0002');
  });

  it('should stamp createdAt server-side rather than trusting the caller', async () => {
    mockSend.mockResolvedValueOnce({});

    const { body } = await write({ ...UPPER_LOWER_V1, version: 2, createdAt: '1999-01-01T00:00:00.000Z' });

    expect(body.createdAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(Date.parse(body.createdAt)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('should accept a document round-tripped from the read tool, sort key and all', async () => {
    mockSend.mockResolvedValueOnce({});
    const { statusCode } = await write(stored(2));
    expect(statusCode).toBe(201);
  });

  it('should reject an invalid document without writing', async () => {
    const { statusCode, body } = await write({ ...UPPER_LOWER_V1, version: 2, sessions: [] });

    expect(statusCode).toBe(400);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('should reject a rotation naming a session that does not exist', async () => {
    const { statusCode } = await write({
      ...UPPER_LOWER_V1,
      version: 2,
      rotation: [...UPPER_LOWER_V1.rotation, 'upper-c'],
    });
    expect(statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('should reject a body that is not JSON', async () => {
    const { statusCode } = await write('not json at all');
    expect(statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('should report the next free version when the one sent already exists', async () => {
    const conflict = Object.assign(new Error('exists'), {
      name: 'ConditionalCheckFailedException',
    });
    mockSend
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ Items: [{ version: 4 }] });

    const { statusCode, body } = await write({ ...UPPER_LOWER_V1, version: 2 });

    expect(statusCode).toBe(409);
    expect(body.latestVersion).toBe(4);
    expect(body.nextVersion).toBe(5);
  });
});
