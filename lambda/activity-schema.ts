/**
 * Shapes and pure transforms for the unified activity feed that powers the home
 * page's contribution calendar and recent-activity list.
 *
 * The contract mirrors `ActivityEntry` in portfolio-front
 * (src/app/models/activity-data.ts): the front derives the calendar itself by
 * counting one entry per day, so this API returns a flat, already-merged list
 * rather than pre-aggregated buckets.
 *
 * Kept free of AWS SDK imports so both Lambdas and the unit tests can use it.
 */

/** Matches portfolio-front's ActivityType — note "gym", not "workout". */
export type ActivityType = 'blog' | 'gym' | 'github';

export interface ActivityEntry {
  /** Local calendar date, YYYY-MM-DD. */
  readonly date: string;
  readonly type: ActivityType;
  readonly title: string;
  /** In-app route ("/blog/x") or external URL; omitted when not linkable. */
  readonly url?: string;
}

/** Item id under which the daily GitHub snapshot is stored in the CV table. */
export const GITHUB_ACTIVITY_ITEM_ID = 'github-activity';

/** Days of history the feed covers by default — one contribution-calendar year. */
export const ACTIVITY_WINDOW_DAYS = 365;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Extracts the YYYY-MM-DD calendar date from an ISO timestamp or date string. */
export function toIsoDate(value: string): string | null {
  if (DATE_RE.test(value)) return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

/**
 * The subset of a GitHub public-events payload the rollup reads. The API returns
 * far more per event; anything not named here is counted toward the day's total
 * without needing its own case.
 */
export interface GitHubEvent {
  readonly type?: string;
  readonly created_at?: string;
  readonly repo?: { readonly name?: string };
  readonly payload?: {
    /** "opened" | "merged" | "closed" on a pull request. */
    readonly action?: string;
  };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

interface RepoDayTally {
  pushes: number;
  prsOpened: number;
  prsMerged: number;
  prsClosed: number;
  issues: number;
  releases: number;
  other: number;
  total: number;
}

const emptyTally = (): RepoDayTally => ({
  pushes: 0,
  prsOpened: 0,
  prsMerged: 0,
  prsClosed: 0,
  issues: 0,
  releases: 0,
  other: 0,
  total: 0,
});

function tallyEvent(tally: RepoDayTally, event: GitHubEvent): void {
  const action = event.payload?.action;
  tally.total += 1;
  switch (event.type) {
    case 'PushEvent':
      tally.pushes += 1;
      break;
    case 'PullRequestEvent':
      if (action === 'merged') tally.prsMerged += 1;
      else if (action === 'closed') tally.prsClosed += 1;
      else tally.prsOpened += 1;
      break;
    case 'IssuesEvent':
      tally.issues += 1;
      break;
    case 'ReleaseEvent':
      tally.releases += 1;
      break;
    default:
      // Branch churn and review comments are noise at this granularity; they
      // still count toward the day's total.
      tally.other += 1;
  }
}

/**
 * Summarises a day's work on one repository.
 *
 * Pushes are counted as *events*, not commits: the public-events payload omits
 * the commit count despite documenting it, and recovering it would mean a
 * compare call per push against an unauthenticated rate limit.
 */
function summarise(tally: RepoDayTally): string {
  const parts: string[] = [];
  // 'push' takes -es, which the generic helper does not handle.
  if (tally.pushes) parts.push(`${tally.pushes} push${tally.pushes === 1 ? '' : 'es'}`);
  if (tally.prsMerged) parts.push(`${plural(tally.prsMerged, 'PR')} merged`);
  if (tally.prsOpened) parts.push(`${plural(tally.prsOpened, 'PR')} opened`);
  if (tally.prsClosed) parts.push(`${plural(tally.prsClosed, 'PR')} closed`);
  if (tally.issues) parts.push(plural(tally.issues, 'issue'));
  if (tally.releases) parts.push(plural(tally.releases, 'release'));
  if (parts.length === 0) parts.push(plural(tally.other, 'update'));
  return parts.join(', ');
}

/**
 * Rolls GitHub public events up to one entry per repository per day.
 *
 * The raw stream is per *action*, so a single active day produced over a
 * hundred near-identical feed lines and an equal number of calendar
 * contributions, drowning every other day on the grid. One entry per repo per
 * day reads as a day's work and keeps the calendar's intensity meaningful,
 * while still distinguishing a busy day across several repositories.
 *
 * Events without a usable date are skipped so one malformed entry cannot fail
 * an ingest.
 */
export function gitHubEventsToEntries(events: readonly GitHubEvent[]): ActivityEntry[] {
  const byRepoDay = new Map<string, { date: string; repo: string; tally: RepoDayTally }>();

  for (const event of events) {
    const date = event.created_at ? toIsoDate(event.created_at) : null;
    if (!date) continue;
    const repo = event.repo?.name ?? 'GitHub';
    const key = `${date}|${repo}`;
    const bucket = byRepoDay.get(key) ?? { date, repo, tally: emptyTally() };
    tallyEvent(bucket.tally, event);
    byRepoDay.set(key, bucket);
  }

  return [...byRepoDay.values()]
    // Newest first, busiest repo first within a day.
    .sort((a, b) => (a.date === b.date ? b.tally.total - a.tally.total : b.date.localeCompare(a.date)))
    .map(({ date, repo, tally }) => ({
      date,
      type: 'github' as const,
      title: `${repo}: ${summarise(tally)}`,
      url: repo.includes('/') ? `https://github.com/${repo}` : undefined,
    }));
}

/** A workout day as stored under SUMMARY_PK.day in the workout summary table. */
export interface WorkoutDayLike {
  readonly sk?: unknown;
  readonly sets?: unknown;
  readonly muscles?: Record<string, number>;
}

/** Muscle groups named in a gym entry's title before it collapses to a count. */
const TITLE_MUSCLE_LIMIT = 2;

/**
 * One entry per workout day. The title leads with the day's most-worked muscle
 * groups, which is what makes the feed line worth reading — a bare "Workout"
 * would carry no information the calendar square doesn't already show.
 */
export function workoutDaysToEntries(days: readonly WorkoutDayLike[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const day of days) {
    if (typeof day.sk !== 'string' || !DATE_RE.test(day.sk)) continue;
    const sets = typeof day.sets === 'number' ? day.sets : 0;
    const top = Object.entries(day.muscles ?? {})
      .sort(([, a], [, b]) => b - a)
      .slice(0, TITLE_MUSCLE_LIMIT)
      .map(([muscle]) => muscle);
    const focus = top.length ? ` — ${top.join(', ')}` : '';
    entries.push({
      date: day.sk,
      type: 'gym',
      title: `Workout: ${plural(sets, 'set')}${focus}`,
    });
  }
  return entries;
}

/** A blog post as stored under the blog item in the CV table. */
export interface BlogPostLike {
  readonly title?: unknown;
  readonly date?: unknown;
  readonly url?: unknown;
  /** Draft posts are unpublished; see the note in blogPostsToEntries. */
  readonly draft?: unknown;
}

/**
 * Draft posts are withheld from the public GET /blog so their content never
 * reaches anonymous callers; the same must hold here, or an unpublished post's
 * title would leak through the activity feed and its calendar contribution.
 */
export function blogPostsToEntries(posts: readonly BlogPostLike[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const post of posts) {
    if (post.draft === true) continue;
    if (typeof post.date !== 'string' || typeof post.title !== 'string') continue;
    const date = toIsoDate(post.date);
    if (!date) continue;
    entries.push({
      date,
      type: 'blog',
      title: post.title,
      url: typeof post.url === 'string' ? post.url : undefined,
    });
  }
  return entries;
}

/**
 * Merges every source into the feed order the front renders: newest first, with
 * a stable tie-break so equal dates don't reshuffle between requests.
 */
export function mergeActivity(
  sources: readonly ActivityEntry[][],
  { from, to }: { from: string; to: string },
): ActivityEntry[] {
  return sources
    .flat()
    .filter((entry) => entry.date >= from && entry.date <= to)
    .sort((a, b) => (a.date === b.date ? a.type.localeCompare(b.type) : b.date.localeCompare(a.date)));
}
