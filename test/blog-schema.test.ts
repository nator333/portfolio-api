import { blogDataSchema } from '../lambda/blog-schema';

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
