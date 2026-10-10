import {
  buildSystemPrompt,
  CHAT_MAX_POST_CHARS,
  findPost,
  PAGE_PROFILES,
  resolvePage,
} from '../lambda/chat-context';
import type { BlogPost } from '../lambda/blog-schema';

function post(slug: string, overrides: Partial<BlogPost> = {}): BlogPost {
  return {
    title: `Post ${slug}`,
    date: '2026-01-01',
    summary: `Summary of ${slug}`,
    tags: ['aws'],
    url: `/blog/${slug}`,
    content: `Body of ${slug}`,
    ...overrides,
  };
}

const cv = { name: 'Masahiro' };
const projects = { projects: [{ title: 'Portfolio' }] };

test('no page falls back to the profile scope', () => {
  expect(resolvePage(undefined)).toBe('profile');
});

test('profile pages are grounded in the CV and projects only', () => {
  const prompt = buildSystemPrompt('profile', { cv, projects, posts: [post('a')], workoutPlan: { name: 'x' } });
  expect(prompt).toContain('profile (CV) page');
  expect(prompt).toContain('CV data: {"name":"Masahiro"}');
  expect(prompt).toContain('Projects data:');
  expect(prompt).not.toContain('Blog posts');
  expect(prompt).not.toContain('training program:');
});

test('the blog index lists posts without their bodies', () => {
  const prompt = buildSystemPrompt('blog', { posts: [post('a'), post('b')] });
  expect(prompt).toContain('"url":"/blog/a"');
  expect(prompt).toContain('Summary of b');
  expect(prompt).not.toContain('Body of a');
  expect(prompt).not.toContain('CV data');
});

test('a blog post page adds that post, and only that post, in full', () => {
  const prompt = buildSystemPrompt('blog-post', { posts: [post('a'), post('b')] }, 'b');
  expect(prompt).toContain('The post the visitor is reading — "Post b"');
  expect(prompt).toContain('Body of b');
  expect(prompt).not.toContain('Body of a');
});

test('a blog post page with an unknown slug says so', () => {
  const prompt = buildSystemPrompt('blog-post', { posts: [post('a')] }, 'missing');
  expect(prompt).toContain('could not be found');
});

test('a long post is truncated to the cap', () => {
  const content = 'x'.repeat(CHAT_MAX_POST_CHARS + 500);
  const prompt = buildSystemPrompt('blog-post', { posts: [post('long', { content })] }, 'long');
  expect(prompt).toContain('[truncated]');
  expect(prompt).not.toContain('x'.repeat(CHAT_MAX_POST_CHARS + 1));
});

test('the training page is grounded in the program', () => {
  expect(buildSystemPrompt('workout', { workoutPlan: { name: 'Upper/Lower' } })).toContain(
    'Current training program: {"name":"Upper/Lower"}',
  );
  expect(buildSystemPrompt('workout', {})).toContain('none has been published');
});

test('findPost matches the front-end route segment', () => {
  expect(findPost([post('a')], 'a')?.title).toBe('Post a');
  expect(findPost([post('a')], undefined)).toBeUndefined();
});

test('every page declares the data it needs', () => {
  for (const profile of Object.values(PAGE_PROFILES)) {
    expect(profile.needs.length).toBeGreaterThan(0);
  }
});
