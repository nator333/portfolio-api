import { z } from 'zod';

// Stored in the same single-document table as the CV, under a distinct id.
export const BLOG_TABLE_ITEM_ID = 'blog';

const blogPostSchema = z.object({
  title: z.string().min(1),
  // ISO date string (e.g. "2024-01-15" or full timestamp); the front parses it with new Date().
  date: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'date must be a parseable date string',
  }),
  summary: z.string(),
  tags: z.array(z.string()),
  // Route path the front links to, e.g. "/blog/my-post".
  url: z.string().min(1),
  image: z.string().optional(),
  // Markdown source of the post; the front renders it to HTML at display time.
  content: z.string(),
});

export const blogDataSchema = z.object({
  posts: z.array(blogPostSchema),
});

export type BlogData = z.infer<typeof blogDataSchema>;
