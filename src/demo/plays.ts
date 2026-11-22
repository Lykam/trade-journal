// The demo's PLAYS page (Q84): a few generic setups in the same file format the
// real page writes, with the demo's generated charts as their images. Like the
// demo reviews, the write-ups are short placeholders, not invented prose. The
// LIBRARY play and routine are credited to a made-up trader (Q87), to show how
// someone else's look; the source points nowhere real.
import { addDays } from "../core/calendar";
import { etDate } from "../core/normalize/util";
import { buildPlayMarkdown, appendSection, LIBRARY, LIBRARY_ROUTINES, ROUTINES, updateTitle, type PlayHeader } from "../core/plays/plays";
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

/** The demo's LIBRARY (Q87): one credited play, no images. */
export function demoLibrary(now: string): ReviewFile[] {
  const header: PlayHeader = { name: "Opening range breakout", markets: ["US large caps"], timeframes: ["5m"], tactics: ["Break of the 5m opening range on volume"], credit: "Demo Trader", source: "https://example.com/demo-video" };
  return [{ path: `${LIBRARY.dir}opening-range-breakout.md`, markdown: buildPlayMarkdown(header, addDays(etDate(now), -14), PLACEHOLDER.replace("PLAYS", "LIBRARY"), LIBRARY) }];
}

const ROUTINE_SAMPLES: Array<{ slug: string; header: PlayHeader; daysAgo: number; library?: boolean }> = [
  {
    slug: "weekend-prep",
    header: { name: "Weekend prep", markets: ["Weekend"], timeframes: ["TradingView"], tactics: ["Weekly charts of the indices", "Sector ETFs: leaders and laggards", "Build the watchlist for Monday"] },
    daysAgo: 20,
  },
  {
    slug: "premarket-checklist",
    header: { name: "Premarket checklist", markets: ["Premarket"], timeframes: ["Scanner", "News"], tactics: ["Scan the gappers", "Read the catalyst", "Mark the levels"], credit: "Demo Trader", source: "Demo placeholder source" },
    daysAgo: 6,
    library: true,
  },
];

/** The demo's routines (Q88), the owner's (`library` false) or the LIBRARY's: placeholder write-ups, no images. */
export function demoRoutines(now: string, library = false): ReviewFile[] {
  const today = etDate(now);
  const kind = library ? LIBRARY_ROUTINES : ROUTINES;
  return ROUTINE_SAMPLES.filter((s) => Boolean(s.library) === library).map((s) => ({
    path: `${kind.dir}${s.slug}.md`,
    markdown: buildPlayMarkdown(s.header, addDays(today, -s.daysAgo), PLACEHOLDER.replace("play's", "routine's").replace("PLAYS", library ? "LIBRARY" : "PLAYS"), kind),
  }));
}

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
