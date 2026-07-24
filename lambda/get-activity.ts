import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  ACTIVITY_WINDOW_DAYS,
  GITHUB_ACTIVITY_ITEM_ID,
  blogPostsToEntries,
  mergeActivity,
  workoutDaysToEntries,
  type ActivityEntry,
} from './activity-schema';
import { BLOG_TABLE_ITEM_ID } from './blog-schema';
import { SUMMARY_PK } from './workout-schema';
import { corsHeaders } from './cors';

/**
 * Unified activity feed for the home page's contribution calendar and recent
 * activity list: blog posts and the GitHub snapshot from the local table, gym
 * sessions from the workout summary table in us-west-2.
 *
 * Merging server-side means the landing page makes one call instead of three,
 * which matters against a per-day request quota shared by every visitor.
 *
 * Each source is read independently and a failure in one is swallowed, so a
 * cross-region hiccup or a missing GitHub snapshot degrades the feed rather
 * than emptying the calendar.
 */

const local = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const workoutRegion = process.env.WORKOUT_REGION;
const workout = DynamoDBDocumentClient.from(
  new DynamoDBClient(workoutRegion ? { region: workoutRegion } : {}),
);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const cvTable = process.env.CV_TABLE_NAME;
  if (!cvTable) {
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'CV_TABLE_NAME is not configured' }) };
  }
  const workoutTable = process.env.WORKOUT_SUMMARY_TABLE_NAME;

  const params = event.queryStringParameters ?? {};
  const to = params.to && DATE_RE.test(params.to) ? params.to : isoDate(new Date());
  let from: string;
  if (params.from && DATE_RE.test(params.from)) {
    from = params.from;
  } else {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ACTIVITY_WINDOW_DAYS);
    from = isoDate(d);
  }

  const [github, blog, gym] = await Promise.all([
    readGitHub(cvTable),
    readBlog(cvTable),
    workoutTable ? readWorkout(workoutTable, from, to) : Promise.resolve([]),
  ]);

  const entries = mergeActivity([github, blog, gym], { from, to });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      range: { from, to },
      entries,
      counts: {
        github: github.length,
        blog: blog.length,
        gym: gym.length,
        total: entries.length,
      },
    }),
  };
};

/** Never let one dead source empty the whole feed. */
async function safely<T>(label: string, read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    console.warn(`activity: ${label} source unavailable`, error);
    return [];
  }
}

const readGitHub = (table: string): Promise<ActivityEntry[]> =>
  safely('github', async () => {
    const result = await local.send(
      new GetCommand({ TableName: table, Key: { id: GITHUB_ACTIVITY_ITEM_ID } }),
    );
    const entries = result.Item?.entries;
    return Array.isArray(entries) ? (entries as ActivityEntry[]) : [];
  });

const readBlog = (table: string): Promise<ActivityEntry[]> =>
  safely('blog', async () => {
    const result = await local.send(
      new GetCommand({ TableName: table, Key: { id: BLOG_TABLE_ITEM_ID } }),
    );
    const posts = result.Item?.posts;
    return blogPostsToEntries(Array.isArray(posts) ? posts : []);
  });

const readWorkout = (table: string, from: string, to: string): Promise<ActivityEntry[]> =>
  safely('gym', async () => {
    const days: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const page = await workout.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
          ExpressionAttributeValues: { ':pk': SUMMARY_PK.day, ':from': from, ':to': to },
          ExclusiveStartKey: lastKey,
        }),
      );
      days.push(...((page.Items ?? []) as Record<string, unknown>[]));
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);
    return workoutDaysToEntries(days);
  });
