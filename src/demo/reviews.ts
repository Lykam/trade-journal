// Demo reviews, built mechanically from the review template's structure: the
// header fields, Idea ID, a Category from a fixed list and the same short
// placeholder line in every section. No invented prose (owner decision).
import type { Idea, ReviewFile } from "../core/types";

export const CATEGORIES = ["Gap and go", "Breaking news", "Pullback to the 20 EMA", "Breakout", "Earnings drift"];

const PLACEHOLDER = "Demo placeholder: on the real site this section holds the review written in Playbook.";

const money = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;

export function demoReview(idea: Idea, status: "OPEN" | "CLOSED", index: number, charts: string[]): ReviewFile {
  const u = idea.underlying;
  const chart = (kind: "daily" | "intraday") => {
    const path = charts.find((c) => c.endsWith(`-${kind}.png`));
    return path ? `![${u} ${kind} chart](../${path})` : "No chart saved.";
  };
  const markdown = `# Playbook Review — ${u} ${idea.date}

**Date:** ${idea.date}
**Ticker:** ${u}
**Idea ID:** ${idea.id}
**P&L:** ${status === "OPEN" && idea.status === "open" ? "open" : money(idea.netPnl)}
**Trade Type:** ${idea.style === "day" ? "DAY TRADE" : "SWING TRADE"}
**Status:** ${status}

## Category

${CATEGORIES[index % CATEGORIES.length]}.

## Context

${PLACEHOLDER}

## Daily Chart

${chart("daily")}

**Analysis:** ${PLACEHOLDER}

## Intraday Chart

${idea.style === "day" ? chart("intraday") : "Not used for this swing trade."}

## How I Traded It

${PLACEHOLDER}

## How I Should Have Traded It

${PLACEHOLDER}

## Solutions & Lessons Learned

${status === "OPEN" ? "Open: the exit sections are still to be written." : PLACEHOLDER}
`;
  return { path: `Reviews/${idea.date}-${u}.md`, markdown };
}
