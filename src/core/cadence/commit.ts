// Saving a daily / weekly / monthly entry (SPEC §6.7i): the whole file in one
// commit to Playbook's main, read fresh at commit time and retried if main
// moves. A file changed in Playbook since the page loaded (another tab, a
// Claude session, a hand edit) is never overwritten: the save is refused.
import { commitFiles, GitHubError, readBlob, readState, RefMovedError, repoName, type CommitResult, type GitHubClient, type RepoId } from "../github/client";
import { entryKeyOf } from "./entries";

export class EntryError extends Error {
  override name = "EntryError";
}

const utf8 = new TextDecoder("utf-8");
const same = (a: string, b: string) => a.replace(/\r\n/g, "\n").trimEnd() === b.replace(/\r\n/g, "\n").trimEnd();

export function entryMessage(path: string, isNew: boolean): string {
  const at = entryKeyOf(path);
  const what = !at ? path : at.period === "daily" ? `daily journal ${at.key}` : at.period === "weekly" ? `weekly review, week of ${at.key}` : `monthly review ${at.key}`;
  return `${isNew ? "Add" : "Edit"} ${what} (${isNew ? "written" : "edited"} in the journal)`;
}

/**
 * Write `markdown` to `path`. `base` is the file as the page loaded it (null
 * when it had none): if Playbook's copy differs from it, nothing is written.
 */
export async function commitEntry(
  gh: GitHubClient, repo: RepoId, path: string, markdown: string, base: string | null, attempts = 3,
): Promise<CommitResult> {
  if (!entryKeyOf(path)) throw new EntryError(`Not a journal entry path: ${path}`);
  for (let i = 1; ; i++) {
    try {
      const state = await readState(gh, repo);
      const exists = state.files.has(path);
      if (exists) {
        const now = utf8.decode(await readBlob(gh, state, path));
        if (base === null ? !same(now, markdown) : !same(now, base)) {
          throw new EntryError(`${path} changed in ${repoName(repo)} since this page loaded. Reload to see it, then save again.`);
        }
      } else if (base !== null) {
        throw new EntryError(`${path} is no longer in ${repoName(repo)}. Reload the page.`);
      }
      const commit = await commitFiles(gh, state, [{ path, content: markdown }], entryMessage(path, !exists));
      if (!commit) throw new EntryError("Nothing changed: Playbook already has this.");
      return commit;
    } catch (e) {
      if (e instanceof RefMovedError && i < attempts) continue;
      if (e instanceof GitHubError && !(e instanceof RefMovedError)) {
        if (e.kind === "not-found") throw new EntryError(`The token can't see ${repoName(repo)}. On GitHub, edit the token: under Repository access add ${repo.repo}, with Contents: read and write.`);
        if (e.kind === "permission") throw new EntryError(`The token can read ${repoName(repo)} but not write to it. Set Contents to read and write for ${repo.repo}.`);
      }
      throw e;
    }
  }
}
