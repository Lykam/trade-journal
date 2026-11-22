// Node-only reader for a Playbook checkout (SPEC §2, §6.7): review markdown plus
// the list of chart images. Read only; nothing here ever writes to Playbook.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../cli/lib/history.ts";
import { IMAGE_EXT_RE } from "../src/core/reviews/images.ts";
import type { PlaybookData } from "../src/core/types.ts";

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

/** Reviews/*.md, Plays/*.md (Q84), Library/*.md (Q87), Routines/*.md and Library/Routines/*.md (Q88) and every image under Images/ (and Reviews/, where older reviews kept theirs). null without a checkout. */
export function loadPlaybook(dir: string): PlaybookData | null {
  if (!existsSync(dir)) return null;
  const reviewsDir = join(dir, "Reviews");
  const reviews = existsSync(reviewsDir)
    ? readdirSync(reviewsDir)
        .filter((n) => /\.md$/i.test(n) && statSync(join(reviewsDir, n)).isFile())
        .sort()
        .map((n) => ({ path: `Reviews/${n}`, markdown: readFileSync(join(reviewsDir, n), "utf8") }))
    : [];
  const mdFiles = (folder: string) => {
    const at = join(dir, folder);
    return existsSync(at)
      ? readdirSync(at)
          .filter((n) => n.toLowerCase().endsWith(".md") && statSync(join(at, n)).isFile())
          .sort()
          .map((n) => ({ path: `${folder}/${n}`, markdown: readFileSync(join(at, n), "utf8") }))
      : [];
  };
  const plays = mdFiles("Plays");
  const library = mdFiles("Library");
  const routines = mdFiles("Routines");
  const libraryRoutines = mdFiles("Library/Routines");
  const images = [...walk(dir, "Images"), ...walk(dir, "Reviews")].filter((p) => IMAGE_EXT_RE.test(p)).sort();
  return { reviews, images, plays, library, routines, libraryRoutines };
}
