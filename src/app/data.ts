import { useEffect, useState } from "react";
import type { DataBundle } from "../core/types";

export type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: DataBundle };

async function fetchBundle(): Promise<DataBundle> {
  // Dev only: the Vite dev server serves plaintext trade-history (build/dev-data-plugin.ts).
  // This branch is dropped from `vite build`, so the production bundle has no loader for it.
  if (import.meta.env.DEV) {
    const res = await fetch(`${import.meta.env.BASE_URL}__data/bundle.json`, { cache: "no-store" });
    const body = (await res.json()) as DataBundle | { error: string };
    if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
    return body;
  }
  throw new Error("The encrypted data bundle arrives in milestone 4. Run `npm run dev` to use local data.");
}

export function useBundle(): Load {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  useEffect(() => {
    let live = true;
    fetchBundle().then(
      (data) => live && setLoad({ status: "ready", data }),
      (e: Error) => live && setLoad({ status: "error", message: e.message }),
    );
    return () => {
      live = false;
    };
  }, []);
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
 * URL of a Playbook image. Dev only for now: the dev server serves the file
 * (build/dev-data-plugin.ts). The branch is dropped from `vite build`; milestone 4
 * serves decrypted images instead. null means "not available".
 */
export function playbookImageUrl(path: string): string | null {
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
