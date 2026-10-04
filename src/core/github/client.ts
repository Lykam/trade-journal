// A small GitHub REST client for the browser (SPEC §4.5A, §8): reads
// trade-history fresh through the API and writes exactly one commit with the Git
// Data API (blobs → tree → commit → update ref, never forced). The token is
// sent only to api.github.com and never appears in errors or logs.
import { fromBase64, toBase64 } from "../crypto";
import { bytesOf, gitBlobSha, parseHistory, type FileWrite, type HistorySnapshot, type HistoryTexts } from "../history/files";
import type { Validate } from "../schema-names";

export const API = "https://api.github.com";

export interface RepoId {
  owner: string;
  repo: string;
}

export const repoName = (r: RepoId) => `${r.owner}/${r.repo}`;

export function parseRepo(s: string): RepoId | null {
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(s.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export type GitHubErrorKind = "auth" | "permission" | "not-found" | "conflict" | "invalid" | "rate-limit" | "network" | "server";

export class GitHubError extends Error {
  override name = "GitHubError";
  constructor(
    readonly kind: GitHubErrorKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** main moved between our read and the ref update. */
export class RefMovedError extends GitHubError {
  override name = "RefMovedError";
  constructor() {
    super("conflict", 422, "main moved while committing");
  }
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** GitHub's own message, kept short; it never contains the token. */
async function apiMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message.slice(0, 200) : "";
  } catch {
    return "";
  }
}

export class GitHubClient {
  /** The token's expiry, from the last response's github-authentication-token-expiration header. */
  expiresAt: string | null = null;
  readonly #token: string;
  readonly #fetch: FetchFn;

  constructor(token: string, fetchFn: FetchFn = (url, init) => globalThis.fetch(url, init)) {
    this.#token = token;
    this.#fetch = fetchFn;
  }

  /** Never let a token be serialized or printed through the client object. */
  toJSON() {
    return { api: API };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("GitHub API paths must be absolute");
    const url = new URL(API + path);
    // The only place the token is attached: an https request to api.github.com.
    if (url.origin !== API) throw new Error("refusing to send the token outside api.github.com");
    let res: Response;
    try {
      res = await this.#fetch(url.href, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new GitHubError("network", 0, "Could not reach api.github.com. Check your connection.");
    }
    const exp = res.headers.get("github-authentication-token-expiration");
    if (exp) this.expiresAt = exp;
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

    const msg = await apiMessage(res);
    const what = `${method} ${path.split("?")[0]}`;
    if (res.status === 401) throw new GitHubError("auth", 401, "GitHub rejected the token (expired, revoked or mistyped).");
    if (res.status === 403 || res.status === 429) {
      if (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(msg)) {
        throw new GitHubError("rate-limit", res.status, "GitHub API rate limit reached. Try again in a few minutes.");
      }
      throw new GitHubError("permission", res.status, `The token lacks permission for ${what}${msg ? ` (${msg})` : ""}.`);
    }
    if (res.status === 404) throw new GitHubError("not-found", 404, `Not found: ${what}. The repo doesn't exist or the token can't see it.`);
    if (res.status === 409) throw new GitHubError("conflict", 409, `${what}: ${msg || "conflict"}`);
    if (res.status === 422) throw new GitHubError("invalid", 422, `${what}: ${msg || "rejected"}`);
    throw new GitHubError("server", res.status, `${what}: HTTP ${res.status}${msg ? ` (${msg})` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Reading

export interface TreeEntry {
  path: string;
  sha: string;
  type: "blob" | "tree" | "commit";
}

export interface RepoState {
  repo: RepoId;
  branch: string;
  headSha: string;
  treeSha: string;
  /** Blobs by path. */
  files: Map<string, TreeEntry>;
}

const enc = encodeURIComponent;
const repoPath = (r: RepoId) => `/repos/${enc(r.owner)}/${enc(r.repo)}`;

export async function readState(gh: GitHubClient, repo: RepoId, branch = "main"): Promise<RepoState> {
  const ref = await gh.request<{ object: { sha: string } }>("GET", `${repoPath(repo)}/git/ref/heads/${enc(branch)}`);
  const commit = await gh.request<{ tree: { sha: string } }>("GET", `${repoPath(repo)}/git/commits/${ref.object.sha}`);
  const tree = await gh.request<{ tree: TreeEntry[]; truncated: boolean }>("GET", `${repoPath(repo)}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new GitHubError("server", 200, "The repository tree is too large to read in one request.");
  return {
    repo,
    branch,
    headSha: ref.object.sha,
    treeSha: commit.tree.sha,
    files: new Map(tree.tree.filter((e) => e.type === "blob").map((e) => [e.path, e])),
  };
}

export async function readBlob(gh: GitHubClient, state: RepoState, path: string): Promise<Uint8Array> {
  const entry = state.files.get(path);
  if (!entry) throw new GitHubError("not-found", 404, `${path} is not in ${repoName(state.repo)}`);
  const blob = await gh.request<{ content: string; encoding: string }>("GET", `${repoPath(state.repo)}/git/blobs/${entry.sha}`);
  if (blob.encoding !== "base64") throw new GitHubError("server", 200, `unexpected blob encoding for ${path}`);
  return fromBase64(blob.content.replace(/\s/g, ""));
}

const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** A trade-history snapshot read fresh from the API (never from data.enc), plus the repo state it came from. */
export interface RemoteHistory {
  state: RepoState;
  snap: HistorySnapshot;
  /** imports/raw/ as it is now, for archiving each CSV once. */
  archived: { paths: Set<string>; blobShas: Set<string> };
}

export async function readHistory(gh: GitHubClient, repo: RepoId, validate: Validate): Promise<RemoteHistory> {
  const state = await readState(gh, repo);
  const text = async (path: string) => utf8.decode(await readBlob(gh, state, path));
  const optional = (path: string) => (state.files.has(path) ? text(path) : Promise.resolve(undefined));
  if (!state.files.has("config.json")) throw new GitHubError("not-found", 404, `${repoName(repo)} has no config.json; is it a trade-history repo?`);
  const fillPaths = [...state.files.keys()].filter((p) => /^fills\/\d{4}\.json$/.test(p));
  const [config, symbols, overrides, derived, fills] = await Promise.all([
    text("config.json"),
    optional("symbols.json"),
    optional("overrides.json"),
    optional("derived/trades.json"),
    Promise.all(fillPaths.map(async (p) => ({ name: p.slice("fills/".length), text: await text(p) }))),
  ]);
  const texts: HistoryTexts = { config, symbols, overrides, derived, fills };
  const raw = [...state.files.values()].filter((e) => e.path.startsWith("imports/raw/"));
  return {
    state,
    snap: parseHistory(texts, validate),
    archived: { paths: new Set(raw.map((e) => e.path)), blobShas: new Set(raw.map((e) => e.sha)) },
  };
}

// ---------------------------------------------------------------------------
// Writing

export interface CommitResult {
  sha: string;
  /** Committer date, ISO 8601. */
  date: string;
  url: string;
  /** Paths written (unchanged files are left out). */
  paths: string[];
}

/**
 * One commit on top of `state.headSha` with the files whose content changed.
 * Returns null when nothing changed. Throws RefMovedError if main moved since
 * `state` was read; the ref is never forced.
 */
export async function commitFiles(gh: GitHubClient, state: RepoState, files: FileWrite[], message: string): Promise<CommitResult | null> {
  const changed = files.filter((f) => state.files.get(f.path)?.sha !== gitBlobSha(f.content));
  if (!changed.length) return null;
  const base = repoPath(state.repo);
  const entries = [];
  for (const f of changed) {
    const blob = await gh.request<{ sha: string }>("POST", `${base}/git/blobs`, { content: toBase64(bytesOf(f.content)), encoding: "base64" });
    entries.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const tree = await gh.request<{ sha: string }>("POST", `${base}/git/trees`, { base_tree: state.treeSha, tree: entries });
  const commit = await gh.request<{ sha: string; html_url: string; committer: { date: string } }>("POST", `${base}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [state.headSha],
  });
  try {
    await gh.request("PATCH", `${base}/git/refs/heads/${enc(state.branch)}`, { sha: commit.sha, force: false });
  } catch (e) {
    // GitHub answers 422 "Update is not a fast forward" when the branch moved.
    if (e instanceof GitHubError && e.kind === "invalid") throw new RefMovedError();
    throw e;
  }
  return { sha: commit.sha, date: commit.committer.date, url: commit.html_url, paths: changed.map((f) => f.path) };
}

/** A retry after main moved would commit something other than what was previewed. */
export class PreviewChangedError<P> extends Error {
  override name = "PreviewChangedError";
  constructor(
    readonly plan: P,
    readonly remote: RemoteHistory,
  ) {
    super("trade-history changed since the preview, and the result is different. Review the new preview.");
  }
}

export interface Planned {
  files: FileWrite[];
  message: string;
  fingerprint: string;
}

/**
 * Commit a plan computed from `remote`. If main moved, re-read, recompute and
 * try again (up to `attempts`); if the recomputed plan differs from what the
 * user approved (its fingerprint), stop with PreviewChangedError instead.
 */
export async function commitPlan<P extends Planned>(
  gh: GitHubClient,
  validate: Validate,
  remote: RemoteHistory,
  plan: P,
  compute: (remote: RemoteHistory) => P,
  attempts = 3,
): Promise<{ commit: CommitResult | null; plan: P; remote: RemoteHistory }> {
  const approved = plan.fingerprint;
  for (let i = 1; ; i++) {
    try {
      return { commit: await commitFiles(gh, remote.state, plan.files, plan.message), plan, remote };
    } catch (e) {
      if (!(e instanceof RefMovedError) || i >= attempts) throw e;
    }
    remote = await readHistory(gh, remote.state.repo, validate);
    plan = compute(remote);
    if (plan.fingerprint !== approved) throw new PreviewChangedError(plan, remote);
  }
}

// ---------------------------------------------------------------------------
// Token check (Settings)

export interface TokenCheck {
  repo: RepoId;
  /** Can read and write contents of the data repo. */
  write: boolean;
  /** This token may start workflows on the app repo. */
  actions: boolean;
  expiresAt: string | null;
}

export class TokenError extends Error {
  override name = "TokenError";
}

export const FINE_GRAINED_PREFIX = "github_pat_";
/** A ref that never exists, so the Actions probe can't start a run. */
export const PROBE_REF = "refs/heads/tj-permission-probe-never-exists";

function requireFineGrained(token: string) {
  if (!token.startsWith(FINE_GRAINED_PREFIX)) {
    throw new TokenError("Use a fine-grained personal access token (it starts with github_pat_). Classic tokens reach every repo you can.");
  }
}

/**
 * Whether a token may start a workflow on `app`. It dispatches on a ref that
 * doesn't exist: with permission GitHub answers 422 (no such ref), without it
 * 403/404, and no workflow ever runs.
 */
export async function probeActions(gh: GitHubClient, app: RepoId, workflow = "prices.yml"): Promise<boolean> {
  try {
    await gh.request("POST", `${repoPath(app)}/actions/workflows/${enc(workflow)}/dispatches`, { ref: PROBE_REF });
    return true; // never expected: the ref doesn't exist
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    if (e.kind === "invalid") return true;
    if (e.kind === "permission" || e.kind === "not-found") return false;
    throw e;
  }
}

/**
 * Check the main token before saving it: fine-grained, can read the data
 * repo's main and create a blob there (an unreferenced blob changes nothing),
 * and whether it also reaches the app repo's Actions (it shouldn't, Q38).
 */
export async function checkToken(gh: GitHubClient, token: string, data: RepoId, app: RepoId, workflow = "prices.yml"): Promise<TokenCheck> {
  requireFineGrained(token);
  try {
    await gh.request("GET", `${repoPath(data)}/git/ref/heads/main`);
  } catch (e) {
    if (e instanceof GitHubError && (e.kind === "not-found" || e.kind === "permission")) {
      throw new TokenError(`The token can't read ${repoName(data)}. Give it Contents: read and write on that repository.`);
    }
    if (e instanceof GitHubError && e.kind === "conflict") throw new TokenError(`${repoName(data)} is empty (no main branch yet).`);
    throw e;
  }
  try {
    await gh.request("POST", `${repoPath(data)}/git/blobs`, { content: "", encoding: "utf-8" });
  } catch (e) {
    if (e instanceof GitHubError && (e.kind === "permission" || e.kind === "not-found")) {
      throw new TokenError(`The token can read ${repoName(data)} but not write to it. Set Contents to read and write.`);
    }
    throw e;
  }
  const actions = await probeActions(gh, app, workflow);
  return { repo: data, write: true, actions, expiresAt: gh.expiresAt };
}

/** Check the optional Actions token: fine-grained and allowed to start prices.yml. */
export async function checkActionsToken(gh: GitHubClient, token: string, app: RepoId, workflow = "prices.yml"): Promise<void> {
  requireFineGrained(token);
  if (!(await probeActions(gh, app, workflow))) {
    throw new TokenError(`The Actions token can't start workflows on ${repoName(app)}. Give it Actions: read and write on that repository only.`);
  }
}

/** Start prices.yml on main (the optional "Refresh prices" button, SPEC §5.4). */
export async function dispatchWorkflow(gh: GitHubClient, app: RepoId, workflow = "prices.yml"): Promise<void> {
  await gh.request("POST", `${repoPath(app)}/actions/workflows/${enc(workflow)}/dispatches`, { ref: "main" });
}
