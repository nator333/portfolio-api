import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
// Legacy bedrock-runtime client via the "us." inference profile; see chat.ts.
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { CV_TABLE_ITEM_ID, cvDataSchema } from './cv-schema';
import { PROJECTS_TABLE_ITEM_ID, projectsDataSchema } from './projects-schema';
import { agentRequestSchema } from './agent-schema';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Room for a full proposed CV document in the tool input plus prose.
const MAX_REPLY_TOKENS = 4096;
// One conversational call plus up to two validation retries after a bad tool input.
const MAX_MODEL_CALLS = 3;

let bedrock: AnthropicBedrock | undefined;

const PROPOSE_CV_TOOL = 'propose_cv_update';
const PROPOSE_PROJECTS_TOOL = 'propose_projects_update';

// Real validation happens server-side with the zod schemas; the loose input
// schema keeps the tool definition small since the model already sees the
// current documents (and therefore their shape) in the system prompt.
const tools: Anthropic.Tool[] = [
  {
    name: PROPOSE_CV_TOOL,
    description:
      'Propose a replacement CV document. Call only when the admin asks for a concrete change. ' +
      'Pass the COMPLETE updated CV document with the exact same structure as the current CV data — never a partial diff.',
    input_schema: { type: 'object' },
  },
  {
    name: PROPOSE_PROJECTS_TOOL,
    description:
      'Propose a replacement projects document. Call only when the admin asks for a concrete change. ' +
      'Pass the COMPLETE updated projects document with the exact same structure as the current projects data — never a partial diff.',
    input_schema: { type: 'object' },
  },
];

function buildSystemPrompt(cv: unknown, projects: unknown): string {
  return [
    "You are the private CV editing copilot for Masahiro Nakamata, the owner of this portfolio site. You are talking to Masahiro himself.",
    'Help him improve, rewrite, and extend his CV and projects data: sharper wording, better structure, filling gaps he describes.',
    'Discuss and draft in plain text (no markdown). When he asks for a concrete change, call the matching propose tool with the complete updated document; the site will show him the proposal with an Apply button, so do not claim changes are saved.',
    'Never invent facts about his career — ask him for missing details instead.',
    '',
    `Current CV data: ${JSON.stringify(cv)}`,
    `Current projects data: ${JSON.stringify(projects ?? { projects: [] })}`,
  ].join('\n');
}

interface Proposal {
  target: 'cv' | 'projects';
  data: unknown;
}

function validateProposal(toolName: string, input: unknown):
  | { ok: true; proposal: Proposal }
  | { ok: false; issues: string } {
  const schema = toolName === PROPOSE_CV_TOOL ? cvDataSchema : projectsDataSchema;
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return {
      ok: true,
      proposal: {
        target: toolName === PROPOSE_CV_TOOL ? 'cv' : 'projects',
        data: parsed.data,
      },
    };
  }
  return { ok: false, issues: JSON.stringify(parsed.error.issues) };
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.CV_TABLE_NAME;
  const bedrockRegion = process.env.BEDROCK_REGION;
  const modelId = process.env.AGENT_MODEL_ID;
  if (!tableName || !bedrockRegion || !modelId) {
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'Agent backend is not configured' }) };
  }

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Request body must be valid JSON' }) };
  }

  const parsed = agentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Invalid agent request', issues: parsed.error.issues }),
    };
  }

  const [cvResult, projectsResult] = await Promise.all([
    ddb.send(new GetCommand({ TableName: tableName, Key: { id: CV_TABLE_ITEM_ID } })),
    ddb.send(new GetCommand({ TableName: tableName, Key: { id: PROJECTS_TABLE_ITEM_ID } })),
  ]);

  if (!cvResult.Item) {
    return { statusCode: 404, headers, body: JSON.stringify({ message: 'CV data not found' }) };
  }

  const { id: _cvId, ...cvData } = cvResult.Item;
  const projectsData = projectsResult.Item
    ? (({ id: _pid, ...rest }) => rest)(projectsResult.Item)
    : undefined;

  bedrock ??= new AnthropicBedrock({ awsRegion: bedrockRegion });

  const conversation: Anthropic.MessageParam[] = [...parsed.data.messages];

  try {
    for (let call = 0; call < MAX_MODEL_CALLS; call++) {
      const response = await bedrock.messages.create({
        model: modelId,
        max_tokens: MAX_REPLY_TOKENS,
        system: buildSystemPrompt(cvData, projectsData),
        tools,
        messages: conversation,
      });

      const reply = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      if (response.stop_reason !== 'tool_use') {
        if (!reply) {
          return { statusCode: 502, headers, body: JSON.stringify({ message: 'The agent returned no answer, please try again' }) };
        }
        return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
      }

      const toolUse = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      if (!toolUse) {
        return { statusCode: 502, headers, body: JSON.stringify({ message: 'The agent returned no answer, please try again' }) };
      }

      const result = validateProposal(toolUse.name, toolUse.input);
      if (result.ok) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            reply: reply || 'Here is my proposed update — review it and click Apply to save.',
            proposal: result.proposal,
          }),
        };
      }

      // Feed the validation failure back so the model can correct the document.
      conversation.push({ role: 'assistant', content: response.content });
      conversation.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `The proposed document failed validation. Fix these issues and call the tool again: ${result.issues}`,
            is_error: true,
          },
        ],
      });
    }

    return { statusCode: 502, headers, body: JSON.stringify({ message: 'The agent could not produce a valid proposal, please rephrase the request' }) };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 429 || status === 529) {
      return { statusCode: 429, headers, body: JSON.stringify({ message: 'The agent is busy, please try again shortly' }) };
    }
    console.error('Bedrock call failed', error);
    return { statusCode: 502, headers, body: JSON.stringify({ message: 'The agent is unavailable right now' }) };
  }
};
