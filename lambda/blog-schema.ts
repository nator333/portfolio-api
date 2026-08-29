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
  // Draft posts are withheld from the public GET /blog and only surface through
  // the Cognito-gated GET /blog/all (so their content never reaches anonymous
  // callers). Omitted rather than false to keep published documents clean.
  draft: z.boolean().optional(),
});

export const blogDataSchema = z.object({
  posts: z.array(blogPostSchema),
});

export type BlogData = z.infer<typeof blogDataSchema>;
export type BlogPost = z.infer<typeof blogPostSchema>;

/**
 * The posts an audience may see. Authenticated callers (includeDrafts) get
 * everything; the public endpoint drops drafts so their content never leaves
 * the server. Tolerant of a missing list so a malformed document degrades to
 * an empty result rather than throwing.
 */
export function visiblePosts(
  posts: BlogPost[] | undefined,
  includeDrafts: boolean,
): BlogPost[] {
  const all = posts ?? [];
  return includeDrafts ? all : all.filter((post) => !post.draft);
}
