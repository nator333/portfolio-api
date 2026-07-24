import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  GITHUB_ACTIVITY_ITEM_ID,
  gitHubEventsToEntries,
  type ActivityEntry,
  type GitHubEvent,
} from './activity-schema';

/**
 * Snapshots the owner's public GitHub activity into DynamoDB on a schedule.
 *
 * GET /activity reads this snapshot rather than calling GitHub itself: the feed
 * sits on the landing page's critical path, and proxying live would put
 * GitHub's rate limit and availability there too. Running unauthenticated caps
 * history at what the public-events API returns (roughly the last 90 days, 300
 * events) — accepted deliberately to avoid storing a token for a public feed.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Public events are paginated 100 at a time, and GitHub serves at most 3 pages. */
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

export const handler = async (): Promise<void> => {
  const tableName = process.env.CV_TABLE_NAME;
  const user = process.env.GITHUB_USER;
  if (!tableName || !user) {
    throw new Error('Missing required env: CV_TABLE_NAME, GITHUB_USER');
  }

  const events = await fetchEvents(user);
  const entries = gitHubEventsToEntries(events);

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        id: GITHUB_ACTIVITY_ITEM_ID,
        entries,
        fetchedAt: new Date().toISOString(),
      },
    }),
  );

  console.log(`Stored ${entries.length} GitHub activity entries from ${events.length} events`);
};

async function fetchEvents(user: string): Promise<GitHubEvent[]> {
  const all: GitHubEvent[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `https://api.github.com/users/${encodeURIComponent(user)}/events/public?per_page=${PAGE_SIZE}&page=${page}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        // GitHub rejects requests without one, and identifying the caller is
        // what keeps this from looking like anonymous abuse.
        'User-Agent': 'portfolio-api-activity-ingest',
      },
    });

    if (!response.ok) {
      // Surface the status: an unauthenticated caller gets 403 once the hourly
      // rate limit is spent, which is a very different problem from a 404 user.
      throw new Error(`GitHub events request failed: ${response.status} ${response.statusText}`);
    }

    const batch = (await response.json()) as GitHubEvent[];
    all.push(...batch);
    // A short page means there is nothing after it.
    if (batch.length < PAGE_SIZE) break;
  }

  return all;
}

/** Exported for tests: the stored snapshot's shape. */
export interface GitHubActivitySnapshot {
  readonly entries: ActivityEntry[];
  readonly fetchedAt: string;
}
