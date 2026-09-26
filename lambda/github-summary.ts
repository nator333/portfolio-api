import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
// Legacy bedrock-runtime client via the "us." inference profile; see chat.ts.
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { fetchCommits, fetchEvents } from './github-api';
import {
  GITHUB_SUMMARY_PK,
  SUMMARY_SYSTEM_PROMPT,
  backfillStart,
  buildSummaryPrompt,
  commitLine,
  groupEventsByDay,
  nextDay,
  parseRepoSummaries,
  pendingSummaryDates,
  type DayWork,
  type GitHubEventWithPayload,
  type RepoDayDetail,
} from './github-summary-schema';

/**
 * Writes a one-line summary of each repository's work on each finished day and
 * keeps it for good, so the activity feed can say what was done rather than
 * only where. One Bedrock call per day covers all of that day's repositories.
 *
 * Runs daily just after the UTC day closes. Each run also fills any recent day
 * still missing a summary (a missed schedule, a Bedrock error), a few days at a
 * time; a day, once summarised, is never rewritten.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
let bedrock: AnthropicBedrock | undefined;

/** Bounds the reply: a 75-character phrase per repository, as JSON. */
const MAX_SUMMARY_TOKENS = 600;

/**
 * Commit-list requests per run. The unauthenticated limit is 60 an hour per IP,
 * three of which go on the events feed; the rest of the headroom absorbs the
 * snapshot ingest landing in the same hour.
 */
const COMMIT_REQUEST_BUDGET = 40;

export const handler = async (): Promise<void> => {
  const tableName = process.env.GITHUB_SUMMARY_TABLE_NAME;
  const user = process.env.GITHUB_USER;
  const bedrockRegion = process.env.BEDROCK_REGION;
  const modelId = process.env.SUMMARY_MODEL_ID;
  if (!tableName || !user || !bedrockRegion || !modelId) {
    throw new Error('Missing required env: GITHUB_SUMMARY_TABLE_NAME, GITHUB_USER, BEDROCK_REGION, SUMMARY_MODEL_ID');
  }

  const today = new Date().toISOString().slice(0, 10);
  const [events, summarised] = await Promise.all([
    fetchEvents(user) as Promise<GitHubEventWithPayload[]>,
    readSummarisedDates(tableName, backfillStart(today)),
  ]);
  const days = groupEventsByDay(events);
  const pending = pendingSummaryDates(days.keys(), summarised, today);
  if (pending.length === 0) {
    console.log('No GitHub days awaiting a summary');
    return;
  }

  bedrock ??= new AnthropicBedrock({ awsRegion: bedrockRegion });
  let budget = COMMIT_REQUEST_BUDGET;
  let written = 0;

  for (const date of pending) {
    const day = days.get(date)!;
    const needed = day.repos.reduce((n, r) => n + r.heads.length, 0);
    // Leave a day for the next run rather than summarise it from a fraction of
    // its commits — unless it is the first, which would otherwise never fit.
    if (needed > budget && written > 0) break;

    const repos = await withCommits(day, user, budget);
    budget -= Math.min(needed, budget);

    const summaries = await summarise(modelId, date, repos);
    if (Object.keys(summaries).length === 0) {
      console.warn(`Empty summary for ${date}; will retry next run`);
      continue;
    }

    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: GITHUB_SUMMARY_PK,
          date,
          summaries,
          commitCount: repos.reduce((n, r) => n + r.commits.length, 0),
          model: modelId,
          generatedAt: new Date().toISOString(),
        },
        // Summaries are written once; a concurrent or retried run must not
        // overwrite one already published.
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    ).catch((error: { name?: string }) => {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    });
    written += 1;
  }

  console.log(`Wrote ${written} GitHub day summaries (${pending.length} pending)`);
};

async function readSummarisedDates(table: string, from: string): Promise<Set<string>> {
  const dates = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND #date >= :from',
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: { ':pk': GITHUB_SUMMARY_PK, ':from': from },
        ProjectionExpression: '#date',
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of page.Items ?? []) {
      if (typeof item.date === 'string') dates.add(item.date);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return dates;
}

/** Fetches each branch tip's commits for the day, deduplicated across branches. */
async function withCommits(day: DayWork, author: string, budget: number): Promise<RepoDayDetail[]> {
  const since = `${day.date}T00:00:00Z`;
  const until = `${nextDay(day.date)}T00:00:00Z`;
  const repos: RepoDayDetail[] = [];
  let remaining = budget;

  for (const repo of day.repos) {
    const seen = new Set<string>();
    const commits: string[] = [];
    for (const head of repo.heads) {
      if (remaining <= 0) break;
      remaining -= 1;
      try {
        const list = await fetchCommits(repo.repo, { sha: head.sha, author, since, until });
        // Oldest first reads as the day's progression.
        for (const commit of [...list].reverse()) {
          if (!commit.sha || seen.has(commit.sha) || !commit.commit?.message) continue;
          seen.add(commit.sha);
          commits.push(commitLine(commit.commit.message));
        }
      } catch (error) {
        console.warn(`Commit fetch failed for ${repo.repo}@${head.ref}`, error);
      }
    }
    repos.push({ ...repo, commits });
  }
  return repos;
}

async function summarise(
  modelId: string,
  date: string,
  repos: RepoDayDetail[],
): Promise<Record<string, string>> {
  const response = await bedrock!.messages.create({
    model: modelId,
    max_tokens: MAX_SUMMARY_TOKENS,
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildSummaryPrompt(date, repos) }],
  });
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return parseRepoSummaries(
    text,
    repos.map((r) => r.repo),
  );
}
