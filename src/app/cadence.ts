// Review cadence entries as the app sees them (SPEC §6.7i): the deployed
// Journal/ files plus any saved here since, which show at once (marked
// DEPLOYING) until the redeploy brings them in.
import { useMemo, useSyncExternalStore } from "react";
import { readEntries, type Entries } from "../core/cadence/entries";
import type { DataBundle } from "../core/types";

let saved = new Map<string, string>();
const subs = new Set<() => void>();

export function setSavedEntry(path: string, markdown: string) {
  saved = new Map(saved).set(path, markdown);
  subs.forEach((f) => f());
}

export const useSavedEntries = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => saved, () => saved);

/** Paths saved in this tab and not yet in the deployed data. */
export function useDeploying(data: DataBundle): Set<string> {
  const s = useSavedEntries();
  return useMemo(() => {
    const deployed = new Map((data.playbook?.journal ?? []).map((f) => [f.path, f.markdown]));
    return new Set([...s].filter(([p, md]) => deployed.get(p) !== md).map(([p]) => p));
  }, [s, data]);
}

export function useEntries(data: DataBundle): Entries {
  const s = useSavedEntries();
  return useMemo(() => {
    const files = new Map((data.playbook?.journal ?? []).map((f) => [f.path, f.markdown]));
    for (const [p, md] of s) files.set(p, md);
    return readEntries([...files].map(([path, markdown]) => ({ path, markdown })));
  }, [s, data]);
}
