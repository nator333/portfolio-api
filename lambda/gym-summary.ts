import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
// Legacy bedrock-runtime client via the "us." inference profile; see chat.ts.
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import {
  GYM_REFLECTION_TYPE,
  GYM_SUMMARY_PK,
  GYM_SUMMARY_SYSTEM_PROMPT,
  SHORTEN_GYM_REQUEST,
  buildGymPrompt,
  dateFromReflectionKey,
  parseGymSummary,
} from './gym-summary-schema';
import { cleanSummary, overLimit } from './github-summary-schema';

/**
 * Keeps one public line per training day in step with that day's private
 * workout reflections.
 *
 * Triggered by the reflections table's stream (keys only, filtered to workout
 * notes), so an added or corrected note re-summarises its day within seconds.
 * The stream carries no note text; this function reads the day's notes itself
 * and is the only reader of that table besides the MCP server. It writes
 * nothing back to it.
 *
 * Invoked by hand with `{ "backfillDays": 90 }`, it summarises every workout
 * note day in that window — for notes written before this existed.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
let bedrock: AnthropicBedrock | undefined;

/** Bounds the reply: one 75-character phrase. */
const MAX_SUMMARY_TOKENS = 100;

interface BackfillEvent {
  readonly backfillDays?: number;
}

export const handler = async (event: DynamoDBStreamEvent | BackfillEvent): Promise<void> => {
  const reflectionsTable = process.env.REFLECTIONS_TABLE_NAME;
  const summaryTable = process.env.GITHUB_SUMMARY_TABLE_NAME;
  const bedrockRegion = process.env.BEDROCK_REGION;
  const modelId = process.env.SUMMARY_MODEL_ID;
  if (!reflectionsTable || !summaryTable || !bedrockRegion || !modelId) {
    throw new Error(
      'Missing required env: REFLECTIONS_TABLE_NAME, GITHUB_SUMMARY_TABLE_NAME, BEDROCK_REGION, SUMMARY_MODEL_ID',
    );
  }

  const dates =
    'Records' in event
      ? streamDates(event)
      : await backfillDates(reflectionsTable, (event as BackfillEvent).backfillDays ?? 90);

  bedrock ??= new AnthropicBedrock({ awsRegion: bedrockRegion });

  // In series: a handful of days at most, and one failure should surface (and
  // be retried by the stream) without racing the others.
  for (const date of dates) {
    const bodies = await readDayNotes(reflectionsTable, date);
    const summary = bodies.length ? await summarise(modelId, date, bodies) : null;

    if (summary) {
      await ddb.send(
        new PutCommand({
          TableName: summaryTable,
          Item: {
            pk: GYM_SUMMARY_PK,
            date,
            summary,
            noteCount: bodies.length,
            model: modelId,
            generatedAt: new Date().toISOString(),
          },
        }),
      );
    } else {
      // No notes left, or nothing shareable in them: the day shows no line
      // rather than a stale one from before the correction.
      await ddb.send(new DeleteCommand({ TableName: summaryTable, Key: { pk: GYM_SUMMARY_PK, date } }));
    }
  }

  console.log(`Refreshed gym summaries for ${dates.length} day(s)`);
};

function streamDates(event: DynamoDBStreamEvent): string[] {
  const dates = new Set<string>();
  for (const record of event.Records) {
    const keys = record.dynamodb?.Keys;
    // The event-source filter already drops "life" notes; this is the backstop.
    if (keys?.type?.S !== GYM_REFLECTION_TYPE) continue;
    const date = dateFromReflectionKey(keys.sk?.S);
    if (date) dates.add(date);
  }
  return [...dates];
}

async function backfillDates(table: string, days: number): Promise<string[]> {
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - days);
  const dates = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: '#type = :type AND sk >= :from',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: { ':type': GYM_REFLECTION_TYPE, ':from': from.toISOString().slice(0, 10) },
        ProjectionExpression: 'sk',
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const date = dateFromReflectionKey(item.sk);
      if (date) dates.add(date);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return [...dates].sort();
}

async function readDayNotes(table: string, date: string): Promise<string[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: '#type = :type AND begins_with(sk, :prefix)',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':type': GYM_REFLECTION_TYPE, ':prefix': `${date}#` },
      ProjectionExpression: 'body, createdAt',
    }),
  );
  return (result.Items ?? [])
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    .map((item) => item.body)
    .filter((body): body is string => typeof body === 'string' && body.trim() !== '');
}

/** One phrase for the day; an overrun is sent back once before the hard cap cuts it. */
async function summarise(modelId: string, date: string, bodies: string[]): Promise<string | null> {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: buildGymPrompt(date, bodies) },
  ];
  const first = await ask(modelId, messages);
  let summary = parseGymSummary(first);
  if (summary && overLimit(summary)) {
    messages.push({ role: 'assistant', content: first }, { role: 'user', content: SHORTEN_GYM_REQUEST });
    summary = parseGymSummary(await ask(modelId, messages)) ?? summary;
  }
  return summary ? cleanSummary(summary) : null;
}

async function ask(
  modelId: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
): Promise<string> {
  const response = await bedrock!.messages.create({
    model: modelId,
    max_tokens: MAX_SUMMARY_TOKENS,
    system: GYM_SUMMARY_SYSTEM_PROMPT,
    messages,
  });
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
