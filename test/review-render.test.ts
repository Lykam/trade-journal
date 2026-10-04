// Review rendering (SPEC §6.4 Notes): sanitized HTML, template comments hidden,
// the Finviz <details> block kept, images resolved to the Playbook. Fake review only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { embeddedImages, ReviewMarkdown, withHeaderBreaks } from "../src/app/components/ReviewMarkdown";
import { FIXTURES } from "./helpers";

const path = "Reviews/2025-03-10-ZZTA.md";
const markdown = readFileSync(join(FIXTURES, "playbook", path), "utf8");
const html = renderToStaticMarkup(createElement(ReviewMarkdown, { path, markdown }));

describe("ReviewMarkdown", () => {
  it("drops scripts and the template's HTML comments", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toContain("not allowed");
    expect(html).not.toContain("Status is OPEN only");
    expect(html).not.toContain("finviz:start");
  });

  it("keeps the Finviz <details> block with its headlines", () => {
    expect(html).toMatch(/<details>\s*<summary>Headlines 2025-03-09 to 2025-03-10/);
    expect(html).toContain('href="https://example.com/zzta-1"');
    expect(html).toContain('target="_blank"');
  });

  it("serves review-relative images from the Playbook (dev endpoint)", () => {
    expect(html).toContain('__data/playbook/Images/2025-03-10/ZZTA-intraday.png"');
    expect(embeddedImages(path, markdown)).toEqual(["Images/2025-03-10/ZZTA-intraday.png", "Images/2025-03-10/ZZTA-intraday-2.png"]);
  });

  it("puts each header field on its own line", () => {
    expect(withHeaderBreaks("**Date:** x\n**Ticker:** y\n\ntext")).toBe("**Date:** x  \n**Ticker:** y\n\ntext");
    expect(html).toMatch(/<strong>Date:<\/strong> 2025-03-10<br\/?>/);
  });
});
