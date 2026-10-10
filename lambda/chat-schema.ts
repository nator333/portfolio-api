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

// The site page the visitor is chatting from; the assistant loads that page's
// data and focuses its answers on it. Omitted means the general profile scope
// (CV and projects), which is also what older clients get.
export const CHAT_PAGES = ['home', 'profile', 'projects', 'blog', 'blog-post', 'workout'] as const;
export type ChatPage = (typeof CHAT_PAGES)[number];

// The `:url` segment of a /blog/:url route; only sent with page 'blog-post'.
export const CHAT_MAX_SLUG_CHARS = 200;

export const chatRequestSchema = z
  .object({
    messages: z.array(chatMessageSchema).min(1).max(CHAT_MAX_MESSAGES),
    page: z.enum(CHAT_PAGES).optional(),
    slug: z
      .string()
      .min(1)
      .max(CHAT_MAX_SLUG_CHARS)
      .regex(/^[^/]+$/, 'slug must be a single URL path segment')
      .optional(),
  })
  .refine((request) => request.slug === undefined || request.page === 'blog-post', {
    message: "slug is only accepted with page 'blog-post'",
    path: ['slug'],
  });

export type ChatRequest = z.infer<typeof chatRequestSchema>;
