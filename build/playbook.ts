// Node-only reader for a Playbook checkout (SPEC §2, §6.7): review markdown plus
// the list of chart images. Read only; nothing here ever writes to Playbook.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../cli/lib/history";
import { IMAGE_EXT_RE } from "../src/core/reviews/images";
import type { PlaybookData } from "../src/core/types";

export function resolvePlaybookDir(flag?: string): string {
  return resolve(flag ?? process.env.PLAYBOOK_DIR ?? join(REPO_ROOT, "..", "Playbook"));
}

/** Files under `dir`, as paths relative to `root` with forward slashes. */
function walk(root: string, rel: string): string[] {
  const dir = join(root, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const r = `${rel}/${n}`;
    return statSync(join(root, r)).isDirectory() ? walk(root, r) : [r];
  });
}

/** Reviews/*.md and every image under Images/ (and Reviews/, where older reviews kept theirs). null without a checkout. */
export function loadPlaybook(dir: string): PlaybookData | null {
  if (!existsSync(dir)) return null;
  const reviewsDir = join(dir, "Reviews");
  const reviews = existsSync(reviewsDir)
    ? readdirSync(reviewsDir)
        .filter((n) => /\.md$/i.test(n) && statSync(join(reviewsDir, n)).isFile())
        .sort()
        .map((n) => ({ path: `Reviews/${n}`, markdown: readFileSync(join(reviewsDir, n), "utf8") }))
    : [];
  const images = [...walk(dir, "Images"), ...walk(dir, "Reviews")].filter((p) => IMAGE_EXT_RE.test(p)).sort();
  return { reviews, images };
}

export const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
};
