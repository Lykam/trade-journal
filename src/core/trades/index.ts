import type { Config, DerivedTrades, Fill, Overrides, SymbolsMap } from "../types";
import { buildTrades } from "./grouping";

export { buildTrades, assignIdeas } from "./grouping";
export { summarize, isScored, markToMarket, heldOvernightDayTrades, byCloseDesc, type Summary } from "./stats";

export function deriveTrades(
  fills: Fill[],
  ctx: { config: Config; overrides: Overrides; symbols: SymbolsMap; generator: string },
): DerivedTrades {
  const { trades, ideas } = buildTrades(fills, ctx);
  return { generated: true, generator: ctx.generator, trades, ideas };
}
