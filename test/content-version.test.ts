import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send: mockSend }) } };
});

import { handler as getCv } from '../lambda/get-cv';
import { handler as getHome } from '../lambda/get-home';
import { handler as getProjects } from '../lambda/get-projects';
import { blogReader } from '../lambda/get-blog';
import { handler as updateHome } from '../lambda/update-home';
import { handler as updateCv } from '../lambda/update-cv';
import { handler as updateProjects } from '../lambda/update-projects';
import { handler as updateBlog } from '../lambda/update-blog';
import { ifMatch } from '../lambda/content-version';

const get = (headers: Record<string, string> = {}): APIGatewayProxyEvent =>
  ({ headers, queryStringParameters: null }) as unknown as APIGatewayProxyEvent;
const put = (body: unknown, headers: Record<string, string> = {}): APIGatewayProxyEvent =>
  ({ headers, body: JSON.stringify(body) }) as unknown as APIGatewayProxyEvent;

const HOME = { mottoes: ['Keep going'] };
/** The smallest valid document of each kind. */
const VALID: Record<string, unknown> = {
  home: HOME,
  projects: { projects: [] },
  blog: { posts: [] },
  cv: {
    personalInfo: { fullName: 'A', title: 'B', email: 'a@example.com', phone: '', links: { website: '', github: '', linkedin: '' } },
    summary: '',
    technicalSkills: [],
    experience: [],
    qualifications: [],
    education: [],
  },
};

beforeAll(() => {
  process.env.CV_TABLE_NAME = 'cv-test';
});

beforeEach(() => {
  mockSend.mockReset();
});

describe('reading a site document', () => {
  it.each([
    ['cv', getCv],
    ['home', getHome],
    ['projects', getProjects],
    ['blog (public)', blogReader(false)],
  ])('should carry the %s version as an ETag and keep it out of the document', async (_doc, handler) => {
    mockSend.mockResolvedValueOnce({ Item: { id: 'x', version: 'v7', posts: [], projects: [], mottoes: [] } });

    const result = await handler(get());

    expect(result.headers?.ETag).toBe('"v7"');
    const body = JSON.parse(result.body);
    expect(body).not.toHaveProperty('version');
    expect(body).not.toHaveProperty('id');
  });

  it('should give a document never written with a version the initial one', async () => {
    mockSend.mockResolvedValueOnce({ Item: { id: 'home', ...HOME } });
    expect((await getHome(get())).headers?.ETag).toBe('"0"');

    mockSend.mockResolvedValueOnce({});
    expect((await getHome(get())).headers?.ETag).toBe('"0"');
  });

  it('should include drafts only in the admin blog read', async () => {
    const posts = [{ slug: 'live' }, { slug: 'wip', draft: true }];
    mockSend.mockResolvedValue({ Item: { id: 'blog', version: 'b1', posts } });

    const pub = JSON.parse((await blogReader(false)(get())).body);
    const admin = JSON.parse((await blogReader(true)(get())).body);

    expect(pub.posts.map((p: { slug: string }) => p.slug)).toEqual(['live']);
    expect(admin.posts.map((p: { slug: string }) => p.slug)).toEqual(['live', 'wip']);
  });
});

describe('writing a site document', () => {
  it('should save without If-Match (the site editor), still stamping a new version', async () => {
    mockSend.mockResolvedValueOnce({});

    const result = await updateHome(put(HOME));

    expect(result.statusCode).toBe(200);
    const { input } = mockSend.mock.calls[0][0];
    expect(input.ConditionExpression).toBeUndefined();
    expect(input.Item).toMatchObject({ id: 'home', ...HOME });
    expect(input.Item.version).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.headers?.ETag).toBe(`"${input.Item.version}"`);
    // The version never enters the response body either.
    expect(JSON.parse(result.body)).toEqual(HOME);
  });

  it('should write only over the version named in If-Match', async () => {
    mockSend.mockResolvedValueOnce({});

    await updateHome(put(HOME, { 'If-Match': '"v7"' }));

    const { input } = mockSend.mock.calls[0][0];
    expect(input.ConditionExpression).toBe('#v = :expected');
    expect(input.ExpressionAttributeValues).toEqual({ ':expected': 'v7' });
  });

  it('should treat the initial version as "never versioned"', async () => {
    mockSend.mockResolvedValueOnce({});

    await updateHome(put(HOME, { 'if-match': '"0"' }));

    expect(mockSend.mock.calls[0][0].input.ConditionExpression).toBe('attribute_not_exists(#v)');
  });

  it.each([
    ['cv', updateCv],
    ['projects', updateProjects],
    ['blog', updateBlog],
    ['home', updateHome],
  ])('should refuse a stale %s with 412 and leave it as it was', async (doc, handler) => {
    mockSend.mockRejectedValueOnce(
      new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} }),
    );

    const result = await handler(put(VALID[doc], { 'If-Match': '"stale"' }));

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input.ConditionExpression).toBe('#v = :expected');
    expect(result.statusCode).toBe(412);
    expect(JSON.parse(result.body).message).toContain(`The ${doc} document changed since it was read`);
  });
});

describe('reading If-Match', () => {
  it.each([
    ['"abc"', 'abc'],
    ['abc', 'abc'],
    ['W/"abc"', 'abc'],
  ])('should read %s as %s', (header, version) => {
    expect(ifMatch(put({}, { 'If-Match': header }))).toBe(version);
  });

  it('should be absent when no header is sent', () => {
    expect(ifMatch(put({}))).toBeUndefined();
  });
});
