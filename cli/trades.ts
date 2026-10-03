// npm run trades -- [--date YYYY-MM-DD | --from D --to D] [--style day|swing]
//                   [--broker schwab|webull] [--symbol SYM] [--status open|closed|unmatched]
//                   [--ideas] [--history-dir DIR]
//
// Lists trades recomputed from trade-history fills + overrides (identical to
// derived/trades.json; `npm run verify` checks that).
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { etDate } from "../src/core/normalize/util";
import { buildTrades, summarize } from "../src/core/trades";
import type { Trade } from "../src/core/types";
import { loadHistory, resolveHistoryDir } from "./lib/history";
import { money, pct, table, tradeRows } from "./lib/report";

export function runTrades(argv: string[], log: (s: string) => void = console.log): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      date: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      style: { type: "string" },
      broker: { type: "string" },
      symbol: { type: "string" },
      status: { type: "string" },
      ideas: { type: "boolean", default: false },
      "history-dir": { type: "string" },
    },
  });
  for (const d of [values.date, values.from, values.to]) {
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`dates must be YYYY-MM-DD, got "${d}"`);
  }
  if (values.style && !["day", "swing"].includes(values.style)) throw new Error("--style must be day or swing");

  const history = loadHistory(resolveHistoryDir(values["history-dir"]));
  const { trades, ideas } = buildTrades(history.fills, history);
  const from = values.date ?? values.from ?? "0000-00-00";
  const to = values.date ?? values.to ?? "9999-99-99";
  const sym = values.symbol?.toUpperCase();

  // A trade is "on" a date if it was open at any point that day.
  const onDates = (t: Trade) => etDate(t.openedAt) <= to && (t.closedAt ? etDate(t.closedAt) : "9999-99-99") >= from;
  const picked = trades.filter(
    (t) =>
      onDates(t) &&
      (!values.style || t.style === values.style) &&
      (!values.broker || t.broker === values.broker) &&
      (!values.status || t.status === values.status) &&
      (!sym || t.symbol === sym || t.underlying === sym),
  );

  if (!picked.length) {
    log("No trades match.");
    return 0;
  }

  if (values.ideas) {
    const ids = new Set(picked.map((t) => t.ideaId));
    const rows: Array<Array<string | number>> = [["DATE", "STYLE", "UNDERLYING", "SYMBOLS", "ACCOUNTS", "TRADES", "STATUS", "NET"]];
    for (const i of ideas.filter((i) => ids.has(i.id))) {
      rows.push([i.date, i.style, i.underlying, i.symbolsTraded.join(","), i.accounts.join(","), i.tradeIds.length, i.status, money(i.netPnl)]);
    }
    log(table(rows, ["l", "l", "l", "l", "l", "r", "l", "r"]));
  } else {
    log(tradeRows(picked));
  }
  const s = summarize(picked);
  log(`\n${s.trades} trades · ${s.wins}W / ${s.losses}L / ${s.breakevens}BE · win ${pct(s.winRate)} · net ${money(s.netPnl)}` +
    (s.open ? ` · ${s.open} open` : "") + (s.unmatched ? ` · ${s.unmatched} unmatched` : ""));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.exitCode = runTrades(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
