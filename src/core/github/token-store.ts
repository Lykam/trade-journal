// The browser GitHub token at rest (SPEC §2, §8): sealed with AES-GCM under a
// key derived (HKDF) from the site key, in localStorage only. Without the site
// key, which LOCK forgets, the stored value is unreadable. The plaintext token
// lives in memory only.
import { deriveSubKey, seal, unseal, type Sealed } from "../crypto";

export const TOKEN_STORAGE_KEY = "tj.gh";
const INFO = "trade-journal github token v1";
const AAD = "tj.gh.v1";

export interface TokenRecord {
  token: string;
  /** "owner/repo" of the trade-history repo the token writes to. */
  repo: string;
  /** "Refresh prices" is available: actionsToken (or, discouraged, token) may start prices.yml on trade-journal. */
  actions: boolean;
  /**
   * Optional second fine-grained token, trade-journal only, Actions: read and
   * write (Q38). Kept separate because a token's permissions apply to every repo
   * it selects: one token for both repos would get Contents: write on the app.
   */
  actionsToken?: string;
  /** The main token can reach trade-journal too (it then has Contents: write there): warn. */
  mainReachesApp?: boolean;
  expiresAt: string | null;
  checkedAt: string;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const tokenKey = (siteKeyRaw: Uint8Array) => deriveSubKey(siteKeyRaw, INFO);

export async function saveToken(store: KeyValueStore, key: CryptoKey, rec: TokenRecord): Promise<void> {
  store.setItem(TOKEN_STORAGE_KEY, JSON.stringify(await seal(key, JSON.stringify(rec), AAD)));
}

export type LoadedToken = { status: "none" } | { status: "unreadable" } | { status: "ok"; record: TokenRecord };

/** "unreadable": a sealed token exists but this key can't open it (the passphrase changed). */
export async function loadToken(store: KeyValueStore, key: CryptoKey): Promise<LoadedToken> {
  const raw = store.getItem(TOKEN_STORAGE_KEY);
  if (!raw) return { status: "none" };
  try {
    const sealed = JSON.parse(raw) as Sealed;
    const rec = JSON.parse(await unseal(key, sealed, AAD)) as TokenRecord;
    if (typeof rec.token !== "string" || typeof rec.repo !== "string") return { status: "unreadable" };
    return { status: "ok", record: rec };
  } catch {
    return { status: "unreadable" };
  }
}

export function clearToken(store: KeyValueStore): void {
  store.removeItem(TOKEN_STORAGE_KEY);
}
