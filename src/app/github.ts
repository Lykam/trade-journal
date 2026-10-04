// The browser's GitHub connection (SPEC §2, §4.5A, §6.9): the fine-grained token,
// sealed in localStorage under the site key and opened into memory only while
// unlocked, plus the "Deploying…" watcher that runs after a commit.
import { useEffect, useSyncExternalStore } from "react";
import { checkActionsToken, checkToken, dispatchWorkflow, GitHubClient, parseRepo, type RepoId } from "../core/github/client";
import { DEPLOY_POLL_MS, DEPLOY_TIMEOUT_MS, deployIncludes, type Awaited } from "../core/github/deploy";
import { clearToken, loadToken, saveToken, type KeyValueStore, type TokenRecord } from "../core/github/token-store";
import { fetchNewBundle, secretKey } from "./vault";

export const DEFAULT_DATA_REPO = "Lykam/trade-history";
export const APP_REPO: RepoId = { owner: "Lykam", repo: "trade-journal" };
export const ACTIONS_URL = `https://github.com/${APP_REPO.owner}/${APP_REPO.repo}/actions`;

/** Tiny external store, so every component sees the same state. */
function createStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}

// ---------------------------------------------------------------------------
// Token

export type TokenState =
  | { status: "loading" }
  | { status: "none" }
  /** A sealed token exists but the current site key can't open it (the passphrase changed). */
  | { status: "unreadable" }
  | { status: "ok"; record: TokenRecord };

const tokenStore = createStore<TokenState>({ status: "loading" });

// Dev has no site key that survives a reload, so the token stays in this page's memory.
const memory = new Map<string, string>();
function storage(): KeyValueStore | null {
  if (import.meta.env.DEV) return { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v), removeItem: (k) => void memory.delete(k) };
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let loading: Promise<void> | null = null;
function loadOnce() {
  loading ??= (async () => {
    const key = await secretKey();
    const store = storage();
    if (!key || !store) return tokenStore.set({ status: "none" });
    const t = await loadToken(store, key);
    tokenStore.set(t);
  })().catch(() => tokenStore.set({ status: "unreadable" }));
  return loading;
}

export function useToken(): TokenState {
  useEffect(() => void loadOnce(), []);
  return useSyncExternalStore(tokenStore.subscribe, tokenStore.get);
}

/** Check the token(s) against GitHub, then seal and save them. Throws with a readable message. */
export async function saveCheckedToken(token: string, repoText: string, actionsToken = ""): Promise<TokenRecord> {
  const repo = parseRepo(repoText);
  if (!repo) throw new Error('Repository must look like "owner/name".');
  const t = token.trim();
  const a = actionsToken.trim();
  const check = await checkToken(new GitHubClient(t), t, repo, APP_REPO);
  if (a) await checkActionsToken(new GitHubClient(a), a, APP_REPO);
  const record: TokenRecord = {
    token: t,
    repo: `${repo.owner}/${repo.repo}`,
    actions: Boolean(a) || check.actions,
    ...(a ? { actionsToken: a } : {}),
    mainReachesApp: check.actions,
    expiresAt: check.expiresAt,
    checkedAt: new Date().toISOString(),
  };
  const key = await secretKey();
  const store = storage();
  if (!key || !store) throw new Error("This browser blocks storage; the token can't be saved.");
  await saveToken(store, key, record);
  tokenStore.set({ status: "ok", record });
  return record;
}

export function forgetToken() {
  const store = storage();
  if (store) clearToken(store);
  tokenStore.set({ status: "none" });
}

export function clientFor(record: TokenRecord) {
  const repo = parseRepo(record.repo);
  if (!repo) throw new Error("The saved repository name is invalid; save the token again.");
  return { gh: new GitHubClient(record.token), repo };
}

/** The site is built from DEFAULT_DATA_REPO; a commit anywhere else (a test repo) never shows up in data.enc. */
export const feedsSite = (record: TokenRecord) => record.repo.toLowerCase() === DEFAULT_DATA_REPO.toLowerCase();

// ---------------------------------------------------------------------------
// Deploying…

export type DeployState =
  | null
  | {
      label: string;
      phase: "waiting" | "ready" | "timeout";
      startedAt: number;
      want: Awaited;
      /** Where to look if it takes too long. */
      link: string;
      commitUrl?: string;
      note?: string;
    };

const deployStore = createStore<DeployState>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

export const useDeploy = () => useSyncExternalStore(deployStore.subscribe, deployStore.get);
export const dismissDeploy = () => {
  if (timer) clearTimeout(timer);
  deployStore.set(null);
};

async function poll() {
  const s = deployStore.get();
  if (!s || s.phase !== "waiting") return;
  try {
    const bundle = await fetchNewBundle();
    if (bundle && deployIncludes(bundle, s.want)) return deployStore.set({ ...s, phase: "ready" });
  } catch {
    /* a failed poll is retried until the timeout */
  }
  if (Date.now() - s.startedAt > DEPLOY_TIMEOUT_MS) return deployStore.set({ ...s, phase: "timeout" });
  timer = setTimeout(poll, DEPLOY_POLL_MS);
}

/** Show "Deploying…" and poll data.enc (no-store) until the new data is live. */
export function watchDeploy(s: { label: string; want: Awaited; link: string; commitUrl?: string; note?: string }) {
  if (timer) clearTimeout(timer);
  deployStore.set({ ...s, phase: "waiting", startedAt: Date.now() });
  if (import.meta.env.DEV) {
    deployStore.set({ ...s, phase: "timeout", startedAt: Date.now(), note: "Dev mode reads your local trade-history checkout: git pull there to see the change." });
    return;
  }
  timer = setTimeout(poll, DEPLOY_POLL_MS);
}

/** "Refresh prices": start prices.yml, then wait for its deploy. */
export async function refreshPrices(record: TokenRecord) {
  const gh = new GitHubClient(record.actionsToken ?? record.token);
  const at = new Date().toISOString();
  await dispatchWorkflow(gh, APP_REPO);
  watchDeploy({ label: "Refreshing prices", want: { date: at }, link: `${ACTIONS_URL}/workflows/prices.yml` });
}
