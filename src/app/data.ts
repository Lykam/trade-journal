import { useCallback, useEffect, useState } from "react";
import { WrongKeyError } from "../core/crypto";
import type { DataBundle } from "../core/types";
import { encryptedImageUrl, fetchEncrypted, hasEncryptedImage, unlockWithPassphrase, unlockWithStored } from "./vault";

/** Unlocks with a passphrase; resolves to an error message, or null on success. */
export type Unlock = (passphrase: string, remember: boolean) => Promise<string | null>;

export type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "locked"; notice: string | null; unlock: Unlock }
  | { status: "ready"; data: DataBundle };

/** Dev only: the Vite dev server serves plaintext trade-history (build/dev-data-plugin.ts). */
async function fetchDevBundle(): Promise<DataBundle> {
  const res = await fetch(`${import.meta.env.BASE_URL}__data/bundle.json`, { cache: "no-store" });
  const body = (await res.json()) as DataBundle | { error: string };
  if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
  return body;
}

export const WRONG_PASSPHRASE = "Wrong passphrase. Nothing was decrypted; try again.";

/**
 * The data bundle. In dev it comes from the dev server in plaintext; that branch
 * is dropped from `vite build`, so production has no loader for it. In
 * production it is data.enc, decrypted in memory with the key saved in this
 * browser, or else after the lock screen's passphrase (SPEC §2 Encryption).
 */
export function useBundle(): Load {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const fail = useCallback((e: unknown) => setLoad({ status: "error", message: (e as Error)?.message ?? String(e) }), []);

  useEffect(() => {
    let live = true;
    if (import.meta.env.DEV) {
      fetchDevBundle().then((data) => live && setLoad({ status: "ready", data }), (e) => live && fail(e));
      return () => {
        live = false;
      };
    }
    (async () => {
      const file = await fetchEncrypted();
      const unlock: Unlock = async (passphrase, remember) => {
        try {
          const data = await unlockWithPassphrase(file, passphrase, remember);
          if (live) setLoad({ status: "ready", data });
          return null;
        } catch (e) {
          return e instanceof WrongKeyError ? WRONG_PASSPHRASE : `Could not decrypt: ${(e as Error).message}`;
        }
      };
      let notice: string | null = null;
      try {
        const data = await unlockWithStored(file);
        if (data) {
          if (live) setLoad({ status: "ready", data });
          return;
        }
      } catch (e) {
        if (!(e instanceof WrongKeyError)) throw e;
        notice = "The key saved in this browser no longer opens the data (the passphrase was probably changed). Enter the new passphrase.";
      }
      if (live) setLoad({ status: "locked", notice, unlock });
    })().catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [fail]);
  return load;
}

/** "Now" for the whole app. `?now=2026-10-02T15:00:00-04:00` pins it (handy for checking past weeks). */
export function appNow(): string {
  const pinned = new URLSearchParams(window.location.search).get("now");
  return pinned && !Number.isNaN(Date.parse(pinned)) ? new Date(pinned).toISOString() : new Date().toISOString();
}

/** Hash routes: "#/open", "#/trades?style=day". */
export function useRoute(): { path: string; params: URLSearchParams } {
  const read = () => {
    const [path, query] = (window.location.hash.replace(/^#/, "") || "/").split("?");
    return { path: path || "/", params: new URLSearchParams(query ?? "") };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function usePersisted<T extends string>(key: string, initial: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key) as T | null;
      return s && allowed.includes(s) ? s : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* storage unavailable: keep in memory only */
    }
  };
  return [v, set];
}

/**
 * Display URLs for Playbook images, by path: a string once available, undefined
 * while an encrypted image is still decrypting, null if the image isn't
 * available. Dev serves the files directly (build/dev-data-plugin.ts; dropped
 * from `vite build`); production decrypts img/<hash>.enc to blob URLs on demand.
 */
export function useImageSrcs(paths: string[]): Map<string, string | null | undefined> {
  const key = paths.join("\n");
  const initial = () => new Map(paths.map((p) => [p, import.meta.env.DEV ? devImageUrl(p) : hasEncryptedImage(p) ? undefined : null] as const));
  const [srcs, setSrcs] = useState(initial);
  useEffect(() => {
    setSrcs(initial());
    if (import.meta.env.DEV) return;
    let live = true;
    for (const p of paths) {
      encryptedImageUrl(p)?.then(
        (url) => live && setSrcs((m) => new Map(m).set(p, url)),
        () => live && setSrcs((m) => new Map(m).set(p, null)),
      );
    }
    return () => {
      live = false;
    };
    // `key` stands for the content of `paths`.
  }, [key]);
  return srcs;
}

function devImageUrl(path: string): string | null {
  if (import.meta.env.DEV) return `${import.meta.env.BASE_URL}__data/playbook/${path.split("/").map(encodeURIComponent).join("/")}`;
  return null;
}

export function go(hash: string) {
  window.location.hash = hash;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
