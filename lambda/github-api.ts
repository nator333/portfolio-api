import type { GitHubEvent } from './activity-schema';
import type { GitHubCommit } from './github-summary-schema';

/**
 * Unauthenticated GitHub REST calls shared by the activity snapshot and the
 * daily summariser. Running without a token caps both at 60 requests an hour
 * per IP — accepted deliberately to avoid storing a token for public data — so
 * callers budget their requests rather than paging freely.
 */

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  // GitHub rejects requests without one, and identifying the caller is
  // what keeps this from looking like anonymous abuse.
  'User-Agent': 'portfolio-api-activity-ingest',
};

/** Public events are paginated 100 at a time, and GitHub serves at most 3 pages. */
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

export async function fetchEvents(user: string): Promise<GitHubEvent[]> {
  const all: GitHubEvent[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `https://api.github.com/users/${encodeURIComponent(user)}/events/public?per_page=${PAGE_SIZE}&page=${page}`;
    const response = await fetch(url, { headers: HEADERS });

    if (!response.ok) {
      // Surface the status: an unauthenticated caller gets 403 once the hourly
      // rate limit is spent, which is a very different problem from a 404 user.
      throw new Error(`GitHub events request failed: ${response.status} ${response.statusText}`);
    }

    const batch = (await response.json()) as GitHubEvent[];
    all.push(...batch);
    // A short page means there is nothing after it.
    if (batch.length < PAGE_SIZE) break;
  }

  return all;
}

/**
 * The user's commits reachable from `sha` within [since, until). A branch tip
 * that no longer exists (a deleted, force-pushed branch) yields an empty list
 * rather than an error, so one vanished branch cannot sink a day's summary.
 */
export async function fetchCommits(
  repo: string,
  { sha, author, since, until }: { sha: string; author: string; since: string; until: string },
): Promise<GitHubCommit[]> {
  const params = new URLSearchParams({ sha, author, since, until, per_page: '100' });
  const url = `https://api.github.com/repos/${repo}/commits?${params.toString()}`;
  const response = await fetch(url, { headers: HEADERS });
  if (response.status === 404 || response.status === 409 || response.status === 422) return [];
  if (!response.ok) {
    throw new Error(`GitHub commits request failed for ${repo}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as GitHubCommit[];
}
