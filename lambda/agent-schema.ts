import { z } from 'zod';

// Admin-sized limits: the endpoint sits behind the Cognito authorizer, so the
// caps guard cost per request rather than public abuse.
export const AGENT_MAX_MESSAGES = 20;
export const AGENT_MAX_MESSAGE_CHARS = 4000;

// Only user/assistant roles are accepted: the system prompt is built
// server-side and is not overridable through the request.
const agentMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(AGENT_MAX_MESSAGE_CHARS),
});

export const agentRequestSchema = z.object({
  messages: z.array(agentMessageSchema).min(1).max(AGENT_MAX_MESSAGES),
});

export type AgentRequest = z.infer<typeof agentRequestSchema>;
