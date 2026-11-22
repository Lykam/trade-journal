// The demo's PLAYS page (Q84): a few generic setups in the same file format the
// real page writes, with the demo's generated charts as their images. Like the
// demo reviews, the write-ups are short placeholders, not invented prose.
import { addDays } from "../core/calendar";
import { etDate } from "../core/normalize/util";
import { buildPlayMarkdown, appendSection, updateTitle, type PlayHeader } from "../core/plays/plays";
import type { ReviewFile } from "../core/types";

const PLACEHOLDER = "Demo placeholder: on the real site this holds the play's write-up, written on the PLAYS page.";

const SAMPLES: Array<{ slug: string; header: PlayHeader; daysAgo: number; updates: number[] }> = [
  {
    slug: "gap-and-go",
    header: { name: "Gap and Go", markets: ["US small caps", "Premarket gappers"], timeframes: ["1m", "5m"], tactics: ["First 1m candle to make a new high", "Break of the premarket high on volume"] },
    daysAgo: 40,
    updates: [12],
  },
  {
    slug: "pullback-to-the-20-ema",
    header: { name: "Pullback to the 20 EMA", markets: ["US large caps", "Sector ETFs"], timeframes: ["D", "1h"], tactics: ["Hammer or inside day at the 20 EMA", "Reclaim of the prior day's high"] },
    daysAgo: 25,
    updates: [],
  },
  {
    slug: "earnings-drift",
    header: { name: "Earnings Drift", markets: ["US large caps"], timeframes: ["D"], tactics: ["Hold of the gap-day low after day 2"] },
    daysAgo: 9,
    updates: [3],
  },
];

/** `images`: the demo's generated chart paths; daily charts are used as the plays' pictures. */
export function demoPlays(now: string, images: string[]): ReviewFile[] {
  const today = etDate(now);
  const daily = images.filter((p) => p.endsWith("-daily.png"));
  let k = 0;
  const pic = () => (daily.length ? `\n\n![chart](../${daily[k++ % daily.length]})` : "");
  return SAMPLES.map((s) => {
    let md = buildPlayMarkdown(s.header, addDays(today, -s.daysAgo), `${PLACEHOLDER}${pic()}`);
    for (const d of s.updates) md = appendSection(md, updateTitle(addDays(today, -d), "Demo update"), `${PLACEHOLDER}${pic()}`);
    return { path: `Plays/${s.slug}.md`, markdown: md };
  });
}
