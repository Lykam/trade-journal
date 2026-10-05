// Last import per broker, for the top bar (SPEC §6.0, Q55). No runtime imports, so
// build/load-bundle.ts can load it from Vite's config without pulling in the app's core.
import type { Broker, Fill } from "./types.ts";

/** The latest import time per broker, from the fills' `importedAt` (empty values ignored). */
export function lastImports(fills: Fill[]): Partial<Record<Broker, string>> {
  const out: Partial<Record<Broker, string>> = {};
  for (const f of fills) if (f.importedAt && (!out[f.broker] || Date.parse(f.importedAt) > Date.parse(out[f.broker]!))) out[f.broker] = f.importedAt;
  return out;
}
