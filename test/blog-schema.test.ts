import { blogDataSchema, visiblePosts } from '../lambda/blog-schema';

const basePost = {
  title: 'Building a Portfolio with Angular',
  date: '2024-01-15T00:00:00.000Z',
  summary: 'How to create a professional developer portfolio.',
  tags: ['Angular', 'Portfolio'],
  url: '/blog/building-portfolio-with-angular',
  image: 'assets/blog/portfolio.png',
  content: '## Introduction\n\nCreating a portfolio...',
};

test('accepts a valid blog document', () => {
  expect(blogDataSchema.safeParse({ posts: [basePost] }).success).toBe(true);
});

test('accepts an empty posts list', () => {
  expect(blogDataSchema.safeParse({ posts: [] }).success).toBe(true);
});

test('accepts a post without an image', () => {
  const { image, ...post } = basePost;
  expect(blogDataSchema.safeParse({ posts: [post] }).success).toBe(true);
});

test('accepts a plain calendar date', () => {
  const post = { ...basePost, date: '2024-01-15' };
  expect(blogDataSchema.safeParse({ posts: [post] }).success).toBe(true);
});

test('rejects an unparseable date', () => {
  const post = { ...basePost, date: 'not-a-date' };
  expect(blogDataSchema.safeParse({ posts: [post] }).success).toBe(false);
});

test('rejects a post without a title', () => {
  const post = { ...basePost, title: '' };
  expect(blogDataSchema.safeParse({ posts: [post] }).success).toBe(false);
});

test('rejects a post without a url', () => {
  const post = { ...basePost, url: '' };
  expect(blogDataSchema.safeParse({ posts: [post] }).success).toBe(false);
});

test('accepts a post marked as a draft', () => {
  const post = { ...basePost, draft: true };
  expect(blogDataSchema.safeParse({ posts: [post] }).success).toBe(true);
});

test('accepts and preserves a post language', () => {
  const post = { ...basePost, lang: 'ja' };
  const result = blogDataSchema.safeParse({ posts: [post] });
  expect(result.success).toBe(true);
  // The parsed output is what update-blog persists, so lang must survive it.
  expect(result.success && result.data.posts[0].lang).toBe('ja');
});

test('accepts and preserves audit timestamps', () => {
  const post = {
    ...basePost,
    createdAt: '2024-05-01T09:00:00.000Z',
    updatedAt: '2024-06-02T12:30:00.000Z',
  };
  const result = blogDataSchema.safeParse({ posts: [post] });
  expect(result.success).toBe(true);
  // These must survive the parse, or update-blog would strip them on write.
  expect(result.success && result.data.posts[0].createdAt).toBe(
    '2024-05-01T09:00:00.000Z',
  );
  expect(result.success && result.data.posts[0].updatedAt).toBe(
    '2024-06-02T12:30:00.000Z',
  );
});

test('rejects an unparseable audit timestamp', () => {
  const post = { ...basePost, updatedAt: 'not-a-date' };
  expect(blogDataSchema.safeParse({ posts: [post] }).success).toBe(false);
});

test('visiblePosts drops drafts for the public audience', () => {
  const draft = { ...basePost, url: '/blog/wip', draft: true };
  const posts = [basePost, draft];
  expect(visiblePosts(posts, false)).toEqual([basePost]);
});

test('visiblePosts keeps drafts for authenticated callers', () => {
  const draft = { ...basePost, url: '/blog/wip', draft: true };
  const posts = [basePost, draft];
  expect(visiblePosts(posts, true)).toEqual(posts);
});

test('visiblePosts tolerates a missing posts list', () => {
  expect(visiblePosts(undefined, false)).toEqual([]);
});
