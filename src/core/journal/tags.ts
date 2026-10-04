// Tags (SPEC §6.6). Automatic tags are computed and can't be removed; manual
// tags come from overrides.json (already applied to derived trades).
import type { Trade } from "../types";

export interface TradeTags {
  auto: string[];
  manual: string[];
  all: string[];
}

export const AUTO_TAGS = ["Day", "Swing", "ETF", "Reviewed"] as const;

/** Day/Swing, ETF, Reviewed, plus the Category of each review linked to the trade's idea. */
export function autoTags(t: Trade, reviewCategories: Array<string | null> | null): string[] {
  const out = [t.style === "day" ? "Day" : "Swing"];
  if (t.instrument === "leveraged_etf") out.push("ETF");
  if (reviewCategories) {
    out.push("Reviewed");
    for (const c of reviewCategories) if (c && !out.some((x) => x.toLowerCase() === c.toLowerCase())) out.push(c);
  }
  return out;
}

export function tradeTags(t: Trade, reviewCategories: Array<string | null> | null): TradeTags {
  const auto = autoTags(t, reviewCategories);
  const lower = new Set(auto.map((x) => x.toLowerCase()));
  const manual = [...new Set(t.tags)].filter((x) => !lower.has(x.toLowerCase()));
  return { auto, manual, all: [...auto, ...manual] };
}

export const isAutoTag = (tag: string, tags: TradeTags) => tags.auto.some((x) => x.toLowerCase() === tag.toLowerCase());
