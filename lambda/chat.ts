import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
// Legacy bedrock-runtime client: the Mantle endpoint reported Anthropic models
// as unavailable for this account, while InvokeModel via the "us." cross-region
// inference profile works.
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { CV_TABLE_ITEM_ID } from './cv-schema';
import { PROJECTS_TABLE_ITEM_ID } from './projects-schema';
import { BLOG_TABLE_ITEM_ID, visiblePosts, type BlogPost } from './blog-schema';
import { chatRequestSchema } from './chat-schema';
import { buildSystemPrompt, PAGE_PROFILES, resolvePage, type ChatContextData } from './chat-context';
import { handler as getWorkoutPlan } from './get-workout-plan';
import { handler as getActivity } from './get-activity';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Bounds the answer length; part of the per-request cost cap.
const MAX_REPLY_TOKENS = 512;

let bedrock: AnthropicBedrock | undefined;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.CV_TABLE_NAME;
  const bedrockRegion = process.env.BEDROCK_REGION;
  const modelId = process.env.CHAT_MODEL_ID;
  if (!tableName || !bedrockRegion || !modelId) {
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'Chat backend is not configured' }) };
  }

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Request body must be valid JSON' }) };
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Invalid chat request', issues: parsed.error.issues }),
    };
  }

  const page = resolvePage(parsed.data.page);
  const needs = PAGE_PROFILES[page].needs;
  const data: ChatContextData = {};

  // Load only what the page's assistant needs; each read is the same one the
  // page's own public endpoint makes, so nothing private (drafts, logged sets)
  // can reach the prompt.
  await Promise.all([
    needs.includes('cv') &&
      ddb.send(new GetCommand({ TableName: tableName, Key: { id: CV_TABLE_ITEM_ID } })).then((r) => {
        data.cv = withoutId(r.Item);
      }),
    needs.includes('projects') &&
      ddb.send(new GetCommand({ TableName: tableName, Key: { id: PROJECTS_TABLE_ITEM_ID } })).then((r) => {
        data.projects = withoutId(r.Item);
      }),
    needs.includes('posts') &&
      ddb.send(new GetCommand({ TableName: tableName, Key: { id: BLOG_TABLE_ITEM_ID } })).then((r) => {
        data.posts = visiblePosts((r.Item as { posts?: BlogPost[] } | undefined)?.posts, false);
      }),
    needs.includes('activity') &&
      loadActivity(event).then((activity) => {
        data.activity = activity;
      }),
    needs.includes('workoutPlan') &&
      loadWorkoutPlan(event).then((plan) => {
        data.workoutPlan = plan;
      }),
  ]);

  if (needs.includes('cv') && data.cv === undefined) {
    return { statusCode: 404, headers, body: JSON.stringify({ message: 'CV data not found' }) };
  }

  bedrock ??= new AnthropicBedrock({ awsRegion: bedrockRegion });

  try {
    const response = await bedrock.messages.create({
      model: modelId,
      max_tokens: MAX_REPLY_TOKENS,
      system: buildSystemPrompt(page, data, parsed.data.slug),
      messages: parsed.data.messages,
    });

    const reply = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (!reply) {
      return { statusCode: 502, headers, body: JSON.stringify({ message: 'The assistant returned no answer, please try again' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 429 || status === 529) {
      return { statusCode: 429, headers, body: JSON.stringify({ message: 'The assistant is busy, please try again shortly' }) };
    }
    console.error('Bedrock call failed', error);
    return { statusCode: 502, headers, body: JSON.stringify({ message: 'The assistant is unavailable right now' }) };
  }
};

function withoutId(item: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!item) {
    return undefined;
  }
  const { id: _id, ...rest } = item;
  return rest;
}

/**
 * The current program, as the public GET /workout-plan serves it (menu with
 * the weekly targets composed on). Undefined when none is published or the
 * table is not wired, so the training assistant says so instead of failing.
 */
async function loadWorkoutPlan(event: APIGatewayProxyEvent): Promise<unknown> {
  if (!process.env.WORKOUT_PLAN_TABLE_NAME) {
    return undefined;
  }
  const result = await getWorkoutPlan({ ...event, queryStringParameters: null });
  return result.statusCode === 200 ? JSON.parse(result.body) : undefined;
}

/**
 * The home page's activity feed, exactly as the public GET /activity serves
 * it (default one-year window). Undefined on failure, so the assistant says
 * there is nothing to report instead of failing the chat.
 */
async function loadActivity(event: APIGatewayProxyEvent): Promise<ChatContextData['activity']> {
  const result = await getActivity({ ...event, queryStringParameters: null });
  return result.statusCode === 200 ? JSON.parse(result.body) : undefined;
}
