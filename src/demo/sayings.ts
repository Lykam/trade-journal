// The demo's QUOTES page (Q81): made-up trading maxims with made-up sources, so
// nothing is attributed to a real person. Dated back from "now" like the rest.
import { addDays, etInstant } from "../core/calendar";
import { etDate } from "../core/normalize/util";
import type { SayingsFile } from "../core/types";

const SAMPLES: Array<{ text: string; source?: string; link?: true; tags?: string[]; daysAgo: number }> = [
  { text: "Relative strength is the first sign. Volatility contracting on top of it is the second.", source: "Weekend review video", link: true, tags: ["relative-strength", "volatility"], daysAgo: 2 },
  { text: "The best trades work right away. If it needs a story to stay in, it's probably done.", source: "Own note", tags: ["exits"], daysAgo: 6 },
  { text: "Size down when the gauge says so, not when the P&L hurts.", source: "Own note", tags: ["sizing", "discipline"], daysAgo: 11 },
  { text: "A tight base after a big move is the market telling you who's still holding.", source: "Trading podcast", link: true, tags: ["setups", "volatility"], daysAgo: 19 },
  { text: "Leaders lead on the way down too: watch which ones refuse to make new lows.", source: "Weekend review video", link: true, tags: ["relative-strength", "market"], daysAgo: 27 },
  { text: "You don't have to trade every day. Cash is a position.", tags: ["discipline"], daysAgo: 40 },
  { text: "Plan the stop before the entry. If you can't name it, you can't take the trade.", source: "Trading book", tags: ["risk", "discipline"], daysAgo: 55 },
];

export function demoSayings(now: string): SayingsFile {
  const today = etDate(now);
  return {
    schemaVersion: 1,
    sayings: SAMPLES.map((s, i) => ({
      id: `q-${(0xdec0de000000 + i).toString(16)}`,
      text: s.text,
      ...(s.source ? { source: s.source } : {}),
      ...(s.link ? { link: `https://example.com/demo/${i + 1}` } : {}),
      ...(s.tags ? { tags: s.tags } : {}),
      addedAt: new Date(Math.min(etInstant(addDays(today, -s.daysAgo), "19:30:00"), Date.parse(now))).toISOString(),
    })),
  };
}
