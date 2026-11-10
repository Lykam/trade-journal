// Gather everything the deployed app needs (SPEC §7 Deploy step 4): the same
// bundle the dev server serves (fills without source names, overrides, config,
// symbols, derived trades, quotes, review markdown, image list), plus the
// image bytes for build/encrypt.ts. Nothing here prints data.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHistoryDir } from "../cli/lib/history";
import type { DataBundle } from "../src/core/types";
import { resolveQuotesFile } from "./fetch-quotes";
import { resolveRegimeFile } from "./fetch-regime";
import { loadBundle } from "./load-bundle";
import { resolvePlaybookDir } from "./playbook";

export interface BundleScanDay {
  date: string;
  bytes: Uint8Array;
}

export interface BundleSources {
  historyDir: string;
  quotesFile: string;
  playbookDir: string;
  regimeFile: string;
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
    regimeFile: resolveRegimeFile(flags.regimeFile),
  };
}

/** The plaintext bundle, the Playbook images it lists, and the watchlist-scan history days it lists — each encrypted into its own file (build/encrypt.ts), never bundled eagerly. A Playbook with no Reviews/ or Images/, or no watchlist-scans/, gives empty lists. */
export function bundleData(src: BundleSources): { bundle: DataBundle; images: BundleImage[]; scanDays: BundleScanDay[] } {
  const bundle = loadBundle(src.historyDir, src.quotesFile, src.playbookDir, src.regimeFile);
  const images = (bundle.playbook?.images ?? []).map((path) => ({ path, bytes: new Uint8Array(readFileSync(join(src.playbookDir, path))) }));
  const scanDays = bundle.watchlistScanHistory.map((date) => ({ date, bytes: new Uint8Array(readFileSync(join(src.historyDir, "watchlist-scans", `${date}.json`))) }));
  return { bundle, images, scanDays };
}
