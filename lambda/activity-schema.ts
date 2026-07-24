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
 * The subset of a GitHub public-events payload this maps from. The API returns
 * far more per event; only these fields are read, so unknown event types
 * degrade to a generic title rather than failing the whole ingest.
 */
export interface GitHubEvent {
  readonly type?: string;
  readonly created_at?: string;
  readonly repo?: { readonly name?: string };
  readonly payload?: {
    /** "refs/heads/x" on a push; the bare branch or tag name on create/delete. */
    readonly ref?: string;
    readonly ref_type?: string;
    /** Documented for pushes but absent from the public-events payload in practice. */
    readonly size?: number;
    readonly commits?: unknown[];
    readonly action?: string;
    readonly number?: number;
    readonly pull_request?: { readonly number?: number; readonly title?: string };
    readonly issue?: { readonly number?: number; readonly title?: string };
  };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const branchOf = (ref?: string): string | undefined =>
  ref ? ref.replace(/^refs\/(heads|tags)\//, '') : undefined;

/**
 * Turns an event's own action into the verb, rather than assuming a fixed pair.
 * A pull request reports `merged` as well as `opened` and `closed`, so mapping
 * "anything not closed" to "Opened" reported the same PR as opened twice.
 */
const verb = (action?: string): string =>
  action ? action.charAt(0).toUpperCase() + action.slice(1) : 'Updated';

/**
 * Renders one GitHub event as a feed line.
 *
 * One entry per event, not per commit: the feed stays readable, at the cost of
 * the calendar counting *events* rather than matching github.com's commit-level
 * contribution numbers. The public-events payload omits a push's commit count
 * despite documenting it, so pushes name the branch and mention a count only
 * when the API actually supplies one.
 */
function titleFor(event: GitHubEvent, repo: string): string {
  const p = event.payload ?? {};
  const named = (kind: string): string => {
    const ref = branchOf(p.ref);
    return ref ? `${kind} ${ref}` : kind;
  };

  switch (event.type) {
    case 'PushEvent': {
      const count = p.size ?? p.commits?.length;
      const target = branchOf(p.ref);
      const what = count === undefined ? 'Pushed' : `Pushed ${plural(count, 'commit')}`;
      return target ? `${what} to ${target} in ${repo}` : `${what} to ${repo}`;
    }
    case 'PullRequestEvent': {
      const number = p.number ?? p.pull_request?.number;
      return `${verb(p.action)} PR${number ? ` #${number}` : ''} in ${repo}`;
    }
    case 'IssuesEvent': {
      const number = p.issue?.number;
      return `${verb(p.action)} issue${number ? ` #${number}` : ''} in ${repo}`;
    }
    case 'CreateEvent':
      return `Created ${named(p.ref_type ?? 'ref')} in ${repo}`;
    case 'DeleteEvent':
      return `Deleted ${named(p.ref_type ?? 'ref')} in ${repo}`;
    case 'PullRequestReviewEvent':
    case 'PullRequestReviewCommentEvent':
      return `Reviewed PR #${p.pull_request?.number ?? '?'} in ${repo}`;
    case 'IssueCommentEvent':
      return `Commented on #${p.issue?.number ?? '?'} in ${repo}`;
    case 'WatchEvent':
      return `Starred ${repo}`;
    case 'ForkEvent':
      return `Forked ${repo}`;
    case 'ReleaseEvent':
      return `Published a release in ${repo}`;
    default:
      return `Activity in ${repo}`;
  }
}

/**
 * Maps GitHub public events to feed entries, skipping any without a usable date
 * so one malformed event cannot fail an ingest.
 */
export function gitHubEventsToEntries(events: readonly GitHubEvent[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const event of events) {
    const date = event.created_at ? toIsoDate(event.created_at) : null;
    if (!date) continue;
    const repo = event.repo?.name ?? 'GitHub';
    entries.push({
      date,
      type: 'github',
      title: titleFor(event, repo),
      url: event.repo?.name ? `https://github.com/${event.repo.name}` : undefined,
    });
  }
  return entries;
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
}

export function blogPostsToEntries(posts: readonly BlogPostLike[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const post of posts) {
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
