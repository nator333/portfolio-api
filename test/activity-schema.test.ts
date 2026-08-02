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

  test('rolls a day of events on one repo into a single entry', () => {
    // The raw stream is per action: one busy day produced 114 near-identical
    // feed lines and 114 calendar contributions, drowning every other day.
    const entries = gitHubEventsToEntries([
      event({ type: 'PushEvent' }),
      event({ type: 'PushEvent' }),
      event({ type: 'PushEvent' }),
      event({ type: 'PullRequestEvent', payload: { action: 'merged' } }),
      event({ type: 'PullRequestEvent', payload: { action: 'opened' } }),
    ]);
    expect(entries).toEqual([
      {
        date: '2026-07-24',
        type: 'github',
        title: 'octo/repo: 3 pushes, 1 PR merged, 1 PR opened',
        url: 'https://github.com/octo/repo',
      },
    ]);
  });

  test('pluralises push as pushes and singularises a lone one', () => {
    const [one] = gitHubEventsToEntries([event({ type: 'PushEvent' })]);
    expect(one.title).toBe('octo/repo: 1 push');
    const [many] = gitHubEventsToEntries([
      event({ type: 'PushEvent' }),
      event({ type: 'PushEvent' }),
    ]);
    expect(many.title).toBe('octo/repo: 2 pushes');
  });

  test('keeps repositories separate within a day, busiest first', () => {
    const entries = gitHubEventsToEntries([
      event({ type: 'PushEvent', repo: { name: 'octo/quiet' } }),
      event({ type: 'PushEvent', repo: { name: 'octo/busy' } }),
      event({ type: 'PushEvent', repo: { name: 'octo/busy' } }),
    ]);
    expect(entries.map((e) => e.title)).toEqual([
      'octo/busy: 2 pushes',
      'octo/quiet: 1 push',
    ]);
  });

  test('separates the same repo on different days', () => {
    const entries = gitHubEventsToEntries([
      event({ type: 'PushEvent', created_at: '2026-07-24T10:00:00Z' }),
      event({ type: 'PushEvent', created_at: '2026-07-23T10:00:00Z' }),
    ]);
    expect(entries.map((e) => e.date)).toEqual(['2026-07-24', '2026-07-23']);
  });

  test('distinguishes merged, opened and closed pull requests', () => {
    const [entry] = gitHubEventsToEntries([
      event({ type: 'PullRequestEvent', payload: { action: 'merged' } }),
      event({ type: 'PullRequestEvent', payload: { action: 'opened' } }),
      event({ type: 'PullRequestEvent', payload: { action: 'closed' } }),
    ]);
    expect(entry.title).toBe('octo/repo: 1 PR merged, 1 PR opened, 1 PR closed');
  });

  test('counts unrecognised events without inventing a category', () => {
    // Branch churn and review comments are noise at this granularity, but a day
    // made only of them should still register.
    const [entry] = gitHubEventsToEntries([
      event({ type: 'CreateEvent' }),
      event({ type: 'DeleteEvent' }),
    ]);
    expect(entry.title).toBe('octo/repo: 2 updates');
  });

  test('skips events with no usable date', () => {
    expect(
      gitHubEventsToEntries([event({ type: 'PushEvent', created_at: undefined })]),
    ).toEqual([]);
  });
});

describe('workoutDaysToEntries', () => {
  test('leads the title with the day’s most-worked muscles', () => {
    const [entry] = workoutDaysToEntries([
      { sk: '2026-07-23', sets: 14, muscles: { Quads: 12, Calves: 2 } },
    ]);
    expect(entry).toEqual({
      date: '2026-07-23',
      type: 'gym',
      title: 'Workout: 14 sets — Quads, Calves',
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
    { type: 'PushEvent', created_at: '2026-07-20T10:00:00Z', repo: { name: 'o/r' } },
  ]);
  const gym = workoutDaysToEntries([{ sk: '2026-07-23', sets: 14, muscles: { Quads: 14 } }]);
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
      workoutDaysToEntries([{ sk: '2026-07-20', sets: 5, muscles: { Quads: 5 } }]),
      github,
      blogPostsToEntries([{ title: 'P', date: '2026-07-20', url: '/p' }]),
    ];
    const once = mergeActivity(sameDay, { from: '2026-01-01', to: '2026-12-31' });
    const twice = mergeActivity([...sameDay].reverse(), { from: '2026-01-01', to: '2026-12-31' });
    expect(once).toEqual(twice);
    expect(once.map((e) => e.type)).toEqual(['blog', 'github', 'gym']);
  });
});
