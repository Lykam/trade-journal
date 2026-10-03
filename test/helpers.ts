import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Overrides, SymbolsMap } from "../src/core/types";

export const FIXTURES = join(import.meta.dirname, "fixtures");
export const IMPORTED_AT = "2025-03-20T22:00:00Z";

export const WEBULL_A = "webull/Webull_Orders_Records.csv";
export const WEBULL_B = "webull/Webull_Orders_Records(1).csv";
export const SCHWAB_A = "schwab/Trading_XXX000_Transactions_20250315-170000.csv";
export const SCHWAB_B = "schwab/Trading_XXX000_Transactions_20250320-170000.csv";

export const fixture = (rel: string) => readFileSync(join(FIXTURES, rel), "utf8");
export const input = (rel: string) => ({ name: rel.split("/").pop()!, text: fixture(rel) });

const json = <T>(rel: string) => JSON.parse(fixture(rel)) as T;
export const config = json<Config>("history/config.json");
export const symbols = json<SymbolsMap>("history/symbols.json");
export const noOverrides = (): Overrides => ({ trades: {}, openingPositions: [] });
