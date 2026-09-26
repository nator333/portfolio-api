import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  GITHUB_ACTIVITY_ITEM_ID,
  gitHubEventsToEntries,
  type ActivityEntry,
} from './activity-schema';
import { fetchEvents } from './github-api';

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

/** Exported for tests: the stored snapshot's shape. */
export interface GitHubActivitySnapshot {
  readonly entries: ActivityEntry[];
  readonly fetchedAt: string;
}
