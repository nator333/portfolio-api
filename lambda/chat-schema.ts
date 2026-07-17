import { z } from 'zod';

// Request-shape caps that bound the worst-case Bedrock cost per call; together
// with the gateway usage-plan quota they enforce the monthly spend budget.
export const CHAT_MAX_MESSAGES = 8;
export const CHAT_MAX_MESSAGE_CHARS = 1000;

// Only user/assistant roles are accepted: the system prompt is built
// server-side and must not be overridable by visitors.
const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(CHAT_MAX_MESSAGE_CHARS),
});

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(CHAT_MAX_MESSAGES),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
