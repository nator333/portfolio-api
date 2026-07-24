import {
  blogPostsToEntries,
  gitHubEventsToEntries,
  mergeActivity,
  toIsoDate,
  workoutDaysToEntries,
  type GitHubEvent,
} from '../lambda/activity-schema';

describe('toIsoDate', () => {
  test('passes a plain calendar date through', () => {
    expect(toIsoDate('2026-07-24')).toBe('2026-07-24');
  });

  test('reduces an ISO timestamp to its calendar date', () => {
    expect(toIsoDate('2026-07-24T13:45:12Z')).toBe('2026-07-24');
  });

  test('returns null for an unparseable value', () => {
    expect(toIsoDate('not a date')).toBeNull();
  });
});

describe('gitHubEventsToEntries', () => {
  const event = (over: Partial<GitHubEvent>): GitHubEvent => ({
    created_at: '2026-07-24T10:00:00Z',
    repo: { name: 'octo/repo' },
    ...over,
  });

  test('names the branch on a push, since the payload carries no commit count', () => {
    // The real public-events payload is only {repository_id, push_id, ref,
    // head, before} — reading a documented-but-absent `size` printed "0 commits".
    const [entry] = gitHubEventsToEntries([
      event({ type: 'PushEvent', payload: { ref: 'refs/heads/master' } }),
    ]);
    expect(entry).toEqual({
      date: '2026-07-24',
      type: 'github',
      title: 'Pushed to master in octo/repo',
      url: 'https://github.com/octo/repo',
    });
  });

  test('mentions a commit count only when the API supplies one', () => {
    const [entry] = gitHubEventsToEntries([
      event({ type: 'PushEvent', payload: { ref: 'refs/heads/main', size: 1 } }),
    ]);
    expect(entry.title).toBe('Pushed 1 commit to main in octo/repo');
  });

  test('uses the pull request’s own action as the verb', () => {
    // GitHub reports `merged` as well as `opened`/`closed`; treating anything
    // not-closed as "Opened" reported the same PR as opened twice.
    const [opened, merged, closed] = gitHubEventsToEntries([
      event({ type: 'PullRequestEvent', payload: { action: 'opened', number: 21 } }),
      event({ type: 'PullRequestEvent', payload: { action: 'merged', number: 21 } }),
      event({ type: 'PullRequestEvent', payload: { action: 'closed', number: 21 } }),
    ]);
    expect(opened.title).toBe('Opened PR #21 in octo/repo');
    expect(merged.title).toBe('Merged PR #21 in octo/repo');
    expect(closed.title).toBe('Closed PR #21 in octo/repo');
  });

  test('names the branch created or deleted', () => {
    const [created, deleted] = gitHubEventsToEntries([
      event({ type: 'CreateEvent', payload: { ref_type: 'branch', ref: 'feature/x' } }),
      event({ type: 'DeleteEvent', payload: { ref_type: 'branch', ref: 'feature/x' } }),
    ]);
    expect(created.title).toBe('Created branch feature/x in octo/repo');
    expect(deleted.title).toBe('Deleted branch feature/x in octo/repo');
  });

  test('degrades unknown event types instead of failing', () => {
    const [entry] = gitHubEventsToEntries([event({ type: 'SomeFutureEvent' })]);
    expect(entry.title).toBe('Activity in octo/repo');
  });

  test('skips events with no usable date', () => {
    expect(gitHubEventsToEntries([event({ type: 'PushEvent', created_at: undefined })])).toEqual([]);
  });
});

describe('workoutDaysToEntries', () => {
  test('leads the title with the day’s most-worked muscles', () => {
    const [entry] = workoutDaysToEntries([
      { sk: '2026-07-23', sets: 14, muscles: { Legs: 12, Calves: 2 } },
    ]);
    expect(entry).toEqual({
      date: '2026-07-23',
      type: 'gym',
      title: 'Workout: 14 sets — Legs, Calves',
    });
  });

  test('caps the named muscles so the line stays readable', () => {
    const [entry] = workoutDaysToEntries([
      { sk: '2026-07-21', sets: 22, muscles: { Shoulders: 7, Chest: 6, Biceps: 6, Back: 3 } },
    ]);
    expect(entry.title).toBe('Workout: 22 sets — Shoulders, Chest');
  });

  test('skips summary rows that are not day items', () => {
    expect(workoutDaysToEntries([{ sk: 'META', sets: 1 }])).toEqual([]);
  });
});

describe('blogPostsToEntries', () => {
  test('maps a post to a linkable entry', () => {
    expect(
      blogPostsToEntries([{ title: 'Hello', date: '2026-05-01T00:00:00Z', url: '/blog/hello' }]),
    ).toEqual([{ date: '2026-05-01', type: 'blog', title: 'Hello', url: '/blog/hello' }]);
  });

  test('skips posts missing a title or date', () => {
    expect(blogPostsToEntries([{ title: 'No date' }, { date: '2026-05-01' }])).toEqual([]);
  });
});

describe('mergeActivity', () => {
  const github = gitHubEventsToEntries([
    { type: 'PushEvent', created_at: '2026-07-20T10:00:00Z', repo: { name: 'o/r' }, payload: { size: 1 } },
  ]);
  const gym = workoutDaysToEntries([{ sk: '2026-07-23', sets: 14, muscles: { Legs: 14 } }]);
  const blog = blogPostsToEntries([{ title: 'Post', date: '2026-07-01', url: '/blog/post' }]);

  test('returns every source newest first', () => {
    const merged = mergeActivity([github, blog, gym], { from: '2026-01-01', to: '2026-12-31' });
    expect(merged.map((e) => `${e.date}:${e.type}`)).toEqual([
      '2026-07-23:gym',
      '2026-07-20:github',
      '2026-07-01:blog',
    ]);
  });

  test('drops entries outside the requested window', () => {
    const merged = mergeActivity([github, blog, gym], { from: '2026-07-22', to: '2026-07-31' });
    expect(merged).toHaveLength(1);
    expect(merged[0].type).toBe('gym');
  });

  test('orders same-day entries deterministically across requests', () => {
    const sameDay = [
      workoutDaysToEntries([{ sk: '2026-07-20', sets: 5, muscles: { Legs: 5 } }]),
      github,
      blogPostsToEntries([{ title: 'P', date: '2026-07-20', url: '/p' }]),
    ];
    const once = mergeActivity(sameDay, { from: '2026-01-01', to: '2026-12-31' });
    const twice = mergeActivity([...sameDay].reverse(), { from: '2026-01-01', to: '2026-12-31' });
    expect(once).toEqual(twice);
    expect(once.map((e) => e.type)).toEqual(['blog', 'github', 'gym']);
  });
});
