import {
  MAX_REFS_PER_REPO_DAY,
  MAX_SUMMARY_CHARS,
  SUMMARY_DAYS_PER_RUN,
  buildSummaryPrompt,
  cleanSummary,
  commitLine,
  groupEventsByDay,
  itemsToSummaries,
  pendingSummaryDates,
  type GitHubEventWithPayload,
} from '../lambda/github-summary-schema';

const push = (at: string, ref: string, head: string, repo = 'octo/repo'): GitHubEventWithPayload => ({
  type: 'PushEvent',
  created_at: at,
  repo: { name: repo },
  payload: { ref, head },
});

describe('groupEventsByDay', () => {
  test('keeps only the last pushed tip per branch, so one request covers every push', () => {
    const days = groupEventsByDay([
      push('2026-09-20T09:00:00Z', 'refs/heads/main', 'aaa'),
      push('2026-09-20T15:00:00Z', 'refs/heads/main', 'ccc'),
      push('2026-09-20T12:00:00Z', 'refs/heads/main', 'bbb'),
      push('2026-09-20T10:00:00Z', 'refs/heads/feature', 'fff'),
    ]);
    expect(days.get('2026-09-20')?.repos).toEqual([
      {
        repo: 'octo/repo',
        heads: [
          { ref: 'refs/heads/main', sha: 'ccc' },
          { ref: 'refs/heads/feature', sha: 'fff' },
        ],
        pullRequests: [],
        events: 4,
      },
    ]);
  });

  test('splits by UTC day and orders repositories busiest first', () => {
    const days = groupEventsByDay([
      push('2026-09-20T23:59:00Z', 'refs/heads/main', 'a', 'octo/quiet'),
      push('2026-09-20T01:00:00Z', 'refs/heads/main', 'b', 'octo/busy'),
      push('2026-09-20T02:00:00Z', 'refs/heads/main', 'c', 'octo/busy'),
      push('2026-09-21T00:01:00Z', 'refs/heads/main', 'd', 'octo/quiet'),
    ]);
    expect(days.get('2026-09-20')?.repos.map((r) => r.repo)).toEqual(['octo/busy', 'octo/quiet']);
    expect(days.get('2026-09-21')?.repos.map((r) => r.repo)).toEqual(['octo/quiet']);
  });

  test('caps the branch tips fetched per repository per day', () => {
    const events = Array.from({ length: MAX_REFS_PER_REPO_DAY + 3 }, (_, i) =>
      push(`2026-09-20T0${i}:00:00Z`, `refs/heads/b${i}`, `sha${i}`),
    );
    const [repo] = groupEventsByDay(events).get('2026-09-20')!.repos;
    expect(repo.heads).toHaveLength(MAX_REFS_PER_REPO_DAY);
    // The newest branches are the ones kept.
    expect(repo.heads[0].ref).toBe(`refs/heads/b${MAX_REFS_PER_REPO_DAY + 2}`);
  });

  test('records a PR opened and merged the same day as merged', () => {
    const pr = (action: string, merged?: boolean): GitHubEventWithPayload => ({
      type: 'PullRequestEvent',
      created_at: '2026-09-20T10:00:00Z',
      repo: { name: 'octo/repo' },
      payload: { action, number: 7, pull_request: { title: 'Add summaries', merged } },
    });
    const [repo] = groupEventsByDay([pr('opened'), pr('closed', true)]).get('2026-09-20')!.repos;
    expect(repo.pullRequests).toEqual([{ number: 7, action: 'merged', title: 'Add summaries' }]);
  });

  test('skips events without a date or repository', () => {
    const days = groupEventsByDay([
      { type: 'PushEvent', repo: { name: 'octo/repo' } },
      { type: 'PushEvent', created_at: '2026-09-20T10:00:00Z' },
    ]);
    expect(days.size).toBe(0);
  });
});

describe('pendingSummaryDates', () => {
  const today = '2026-09-26';

  test('never summarises today, and skips days already done', () => {
    expect(
      pendingSummaryDates(['2026-09-26', '2026-09-25', '2026-09-24'], new Set(['2026-09-24']), today),
    ).toEqual(['2026-09-25']);
  });

  test('ignores days outside the backfill window', () => {
    expect(pendingSummaryDates(['2026-06-01', '2026-09-20'], new Set(), today)).toEqual(['2026-09-20']);
  });

  test('works newest first and caps the days per run', () => {
    const active = Array.from({ length: SUMMARY_DAYS_PER_RUN + 2 }, (_, i) => `2026-09-${String(10 + i).padStart(2, '0')}`);
    const pending = pendingSummaryDates(active, new Set(), today);
    expect(pending).toHaveLength(SUMMARY_DAYS_PER_RUN);
    expect(pending[0]).toBe(active[active.length - 1]);
  });
});

describe('commitLine', () => {
  test('keeps the subject and first body paragraph, dropping trailers', () => {
    const message = [
      'Add the daily summariser',
      '',
      'Writes one paragraph per day\nfrom the commit messages.',
      '',
      'Co-Authored-By: Someone <x@example.com>',
      'Session: https://example.com/s',
    ].join('\n');
    expect(commitLine(message)).toBe(
      'Add the daily summariser — Writes one paragraph per day from the commit messages.',
    );
  });

  test('returns the bare subject when the body is only trailers', () => {
    expect(commitLine('Fix typo\n\nCo-Authored-By: A <a@b.c>')).toBe('Fix typo');
  });

  test('truncates an overlong line', () => {
    expect(commitLine('x'.repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});

describe('buildSummaryPrompt', () => {
  test('lists PRs and commits per repository', () => {
    const prompt = buildSummaryPrompt('2026-09-20', [
      {
        repo: 'octo/repo',
        heads: [],
        pullRequests: [{ number: 3, action: 'merged', title: 'Feature' }],
        events: 3,
        commits: ['Add a thing', 'Fix the thing'],
      },
    ]);
    expect(prompt).toBe(
      [
        'Date: 2026-09-20',
        '',
        'Repository: octo/repo',
        '- PR #3 merged: Feature',
        '- commit: Add a thing',
        '- commit: Fix the thing',
      ].join('\n'),
    );
  });

  test('still describes a repository whose commits could not be fetched', () => {
    const prompt = buildSummaryPrompt('2026-09-20', [
      { repo: 'octo/repo', heads: [], pullRequests: [], events: 4, commits: [] },
    ]);
    expect(prompt).toContain('4 GitHub events, no commit details available');
  });
});

describe('cleanSummary', () => {
  test('collapses whitespace and caps the length', () => {
    expect(cleanSummary('  Added   a\n\nthing. ')).toBe('Added a thing.');
    expect(cleanSummary('a'.repeat(5000))).toHaveLength(MAX_SUMMARY_CHARS);
  });
});

describe('itemsToSummaries', () => {
  test('returns well-formed items newest first and drops the rest', () => {
    expect(
      itemsToSummaries([
        { date: '2026-09-19', summary: 'Older.', repos: ['octo/a', 3] },
        { date: '2026-09-20', summary: 'Newer.' },
        { date: '2026-09-21' },
      ]),
    ).toEqual([
      { date: '2026-09-20', summary: 'Newer.', repos: [] },
      { date: '2026-09-19', summary: 'Older.', repos: ['octo/a'] },
    ]);
  });
});
