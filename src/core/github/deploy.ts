// "Deploying…" after a commit (SPEC §4.5A step 5): the app polls data.enc and
// decides whether a newly deployed bundle already contains the change.

/** Give up waiting after this long and link to the Actions run instead. */
export const DEPLOY_TIMEOUT_MS = 5 * 60_000;
export const DEPLOY_POLL_MS = 10_000;

export interface Awaited {
  /** The commit (or dispatch) time to wait for, ISO 8601. */
  date: string;
  /** The commit sha, when waiting for a commit to the repo the site is built from. */
  sha?: string;
}

/**
 * Whether a bundle includes what we wait for. For a commit to the repo the site
 * reads, the bundle's trade-history HEAD must be that commit or a later one.
 * Otherwise (a test repo, or a prices run) any bundle built after the time will do.
 */
export function deployIncludes(bundle: { loadedAt: string; history?: { sha: string; date: string } | null }, want: Awaited): boolean {
  if (want.sha && bundle.history) {
    return bundle.history.sha === want.sha || Date.parse(bundle.history.date) > Date.parse(want.date);
  }
  return Date.parse(bundle.loadedAt) > Date.parse(want.date);
}
