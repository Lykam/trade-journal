// Commits for the PLAYS page (Q84): a play's markdown and its new images go to
// Playbook's main in one commit, through the Git Data API, like reviews (Q80)
// and chart uploads (Q78). Every change reads the file fresh at commit time and
// is re-read and retried if main moves meanwhile, so an edit never overwrites
// a commit made elsewhere (a Claude session in Playbook, another tab).
import { commitFiles, GitHubError, readBlob, readState, RefMovedError, repoName, type CommitResult, type GitHubClient, type RepoId, type RepoState } from "../github/client";
import type { FileWrite } from "../history/files";
import { etDate } from "../normalize/util";
import { checkUpload } from "../reviews/upload";
import {
  appendSection, buildPlayMarkdown, checkHeader, PLAYS, playImagePath, playPath, playSlugOf, PlayError, replaceHeader, replaceSection,
  resolvePending, type PlayHeader, type PlayKind,
} from "./plays";

export interface PlayImage {
  /** The id in the section's `pending:<id>` token. */
  id: number;
  /** MIME type, e.g. image/png. */
  type: string;
  bytes: Uint8Array;
}

export type PlayChange =
  | { kind: "create"; header: PlayHeader; body: string; images: PlayImage[] }
  | { kind: "header"; path: string; header: PlayHeader }
  | { kind: "append"; path: string; title: string; body: string; images: PlayImage[] }
  | { kind: "section"; path: string; index: number; title: string; body: string; images: PlayImage[] }
  | { kind: "delete"; path: string };

export interface PlayCommit extends CommitResult {
  /** The play's path after the change. */
  path: string;
  /** Its markdown after the change; null once deleted. */
  markdown: string | null;
  imagePaths: string[];
}

const utf8 = new TextDecoder("utf-8");

export function playMessage(c: PlayChange, name: string, images = 0, noun = "play"): string {
  const withImages = images ? ` with ${images} image${images === 1 ? "" : "s"}` : "";
  switch (c.kind) {
    case "create": return `Add ${noun}: ${name}${withImages} (written in the journal)`;
    case "header": return `Edit ${noun} header: ${name} (in the journal)`;
    case "append": return `Add update to ${noun}: ${name}${withImages} (in the journal)`;
    case "section": return `Edit ${noun} section “${c.title}”: ${name}${withImages} (in the journal)`;
    case "delete": return `Remove ${noun}: ${name} (in the journal)`;
  }
}


async function current(gh: GitHubClient, state: RepoState, path: string): Promise<string> {
  if (!state.files.has(path)) throw new PlayError(`${path} is no longer in Playbook. It may have been renamed or removed; reload the page.`);
  return utf8.decode(await readBlob(gh, state, path));
}

/** Apply one change to Playbook's main. `now` dates new images and a new play's Created line. */
export async function commitPlay(gh: GitHubClient, repo: RepoId, change: PlayChange, now = new Date(), attempts = 3, kind: PlayKind = PLAYS): Promise<PlayCommit> {
  if ("header" in change) {
    const bad = checkHeader(change.header);
    if (bad) throw new PlayError(bad);
  }
  const images = "images" in change ? change.images : [];
  const exts = images.map(checkUpload);
  const date = etDate(now.toISOString());
  for (let i = 1; ; i++) {
    try {
      const state = await readState(gh, repo);
      const taken = new Set(state.files.keys());
      const path = change.kind === "create" ? playPath(taken, change.header.name, kind) : change.path;
      const slug = playSlugOf(path);
      const imagePaths = new Map<number, string>();
      images.forEach((img, k) => {
        const p = playImagePath(taken, slug, date, exts[k]!, kind);
        taken.add(p);
        imagePaths.set(img.id, p);
      });

      let markdown: string | null;
      let name: string;
      const remove: string[] = [];
      if (change.kind === "create") {
        markdown = buildPlayMarkdown(change.header, date, resolvePending(change.body, imagePaths), kind);
        name = change.header.name.trim();
      } else {
        const before = await current(gh, state, path);
        name = /^# (.+)$/m.exec(before)?.[1]?.trim() ?? slug;
        if (change.kind === "header") {
          markdown = replaceHeader(before, change.header, date, kind);
          name = change.header.name.trim();
        } else if (change.kind === "append") markdown = appendSection(before, change.title, resolvePending(change.body, imagePaths));
        else if (change.kind === "section") markdown = replaceSection(before, change.index, change.title, resolvePending(change.body, imagePaths));
        else {
          markdown = null;
          remove.push(path, ...[...state.files.keys()].filter((p) => p.startsWith(`${kind.imagesDir}${slug}/`)));
        }
      }

      const files: FileWrite[] = [
        ...(markdown !== null ? [{ path, content: markdown }] : []),
        ...images.map((img) => ({ path: imagePaths.get(img.id)!, content: img.bytes })),
      ];
      const commit = await commitFiles(gh, state, files, playMessage(change, name, images.length, kind.noun), remove);
      if (!commit) throw new PlayError("Nothing changed: Playbook already has this.");
      return { ...commit, path, markdown, imagePaths: [...imagePaths.values()] };
    } catch (e) {
      if (e instanceof RefMovedError && i < attempts) continue;
      throw explain(e, repo);
    }
  }
}

function explain(e: unknown, repo: RepoId): unknown {
  if (!(e instanceof GitHubError) || e instanceof RefMovedError) return e;
  if (e.kind === "not-found") return new PlayError(`The token can't see ${repoName(repo)}. On GitHub, edit the token: under Repository access add ${repo.repo}, with Contents: read and write.`);
  if (e.kind === "permission") return new PlayError(`The token can read ${repoName(repo)} but not write to it. Set Contents to read and write for ${repo.repo}.`);
  return e;
}
