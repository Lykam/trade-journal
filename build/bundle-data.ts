// Gather everything the deployed app needs (SPEC §7 Deploy step 4): the same
// bundle the dev server serves (fills without source names, overrides, config,
// symbols, derived trades, quotes, review markdown, image list), plus the
// image bytes for build/encrypt.ts. Nothing here prints data.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHistoryDir } from "../cli/lib/history";
import type { DataBundle } from "../src/core/types";
import { resolveQuotesFile } from "./fetch-quotes";
import { loadBundle } from "./load-bundle";
import { resolvePlaybookDir } from "./playbook";

export interface BundleSources {
  historyDir: string;
  quotesFile: string;
  playbookDir: string;
}

export interface BundleImage {
  path: string;
  bytes: Uint8Array;
}

export function resolveSources(flags: Partial<BundleSources> = {}): BundleSources {
  return {
    historyDir: resolveHistoryDir(flags.historyDir),
    quotesFile: resolveQuotesFile(flags.quotesFile),
    playbookDir: resolvePlaybookDir(flags.playbookDir),
  };
}

/** The plaintext bundle and the Playbook images it lists. A Playbook with no Reviews/ or Images/ gives empty lists. */
export function bundleData(src: BundleSources): { bundle: DataBundle; images: BundleImage[] } {
  const bundle = loadBundle(src.historyDir, src.quotesFile, src.playbookDir);
  const images = (bundle.playbook?.images ?? []).map((path) => ({ path, bytes: new Uint8Array(readFileSync(join(src.playbookDir, path))) }));
  return { bundle, images };
}
