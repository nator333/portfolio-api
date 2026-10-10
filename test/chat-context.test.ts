import {
  buildSystemPrompt,
  CHAT_MAX_ACTIVITY_CHARS,
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

test('the home page is grounded in the activity feed alone', () => {
  const prompt = buildSystemPrompt('home', {
    cv,
    projects,
    activity: {
      range: { from: '2025-10-10', to: '2026-10-10' },
      entries: [
        { date: '2026-10-09', type: 'github', title: 'nator333/portfolio-api', summary: 'Added page-aware chat' },
        { date: '2026-10-08', type: 'gym', title: 'Upper A' },
      ],
    },
  });
  expect(prompt).toContain('2026-10-09 github: nator333/portfolio-api — Added page-aware chat');
  expect(prompt).toContain('2026-10-08 gym: Upper A');
  expect(prompt).not.toContain('CV data');
  expect(prompt).not.toContain('Projects data');
});

test('the home page says so when there is no activity', () => {
  expect(buildSystemPrompt('home', {})).toContain('no recent activity');
});

test('a long activity feed keeps the newest whole entries', () => {
  const entries = Array.from({ length: 2000 }, (_, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    type: 'github' as const,
    title: `repo-${i}`,
  }));
  const prompt = buildSystemPrompt('home', { activity: { range: { from: 'a', to: 'b' }, entries } });
  expect(prompt).toContain(': repo-0\n');
  expect(prompt).not.toContain('repo-1999');
  expect(prompt).not.toContain('[truncated]');
  expect(prompt.length).toBeLessThan(CHAT_MAX_ACTIVITY_CHARS + 2_000);
});

test('the training page adds workout reflections, newest first, capped at whole notes', () => {
  const prompt = buildSystemPrompt('workout', {
    workoutPlan: { name: 'Upper/Lower' },
    reflections: [
      { date: '2026-10-09', body: 'Bench felt strong.', themes: ['bench', 'energy'] },
      { date: '2026-10-07', body: 'Short on sleep.' },
    ],
  });
  expect(prompt).toContain('Training reflections');
  expect(prompt).toContain('2026-10-09 [bench, energy]: Bench felt strong.');
  expect(prompt).toContain('2026-10-07: Short on sleep.');

  const long = Array.from({ length: 50 }, (_, i) => ({ date: '2026-01-01', body: `note-${i} ${'x'.repeat(1000)}` }));
  const capped = buildSystemPrompt('workout', { reflections: long });
  expect(capped).toContain('note-0 ');
  expect(capped).not.toContain('note-49 ');
  expect(buildSystemPrompt('workout', {})).toContain('Training reflections: none recently.');
});

test('reflections never reach any page but training', () => {
  const reflections = [{ date: '2026-10-09', body: 'secret-ish note' }];
  for (const page of ['home', 'profile', 'projects', 'blog', 'blog-post'] as const) {
    expect(buildSystemPrompt(page, { reflections })).not.toContain('secret-ish note');
  }
});
