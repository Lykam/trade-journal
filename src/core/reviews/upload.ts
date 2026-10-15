// Chart uploads from Trade detail (Q78): one image, one commit to Playbook with
// the Git Data API, the same way edits are committed to trade-history. The
// file name is picked against Playbook's main at commit time, so a name taken
// meanwhile gets the next -2, -3, … instead of being overwritten.
import { commitFiles, GitHubError, readState, RefMovedError, repoName, type CommitResult, type GitHubClient, type RepoId } from "../github/client";
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES, UploadError, uploadPath, type UploadKind } from "./images";

export interface ChartUpload {
  date: string;
  symbol: string;
  kind: UploadKind;
  /** MIME type, e.g. image/png. */
  type: string;
  bytes: Uint8Array;
}

/** Throws UploadError when the image can't be uploaded as given. */
export function checkUpload(u: Pick<ChartUpload, "type" | "bytes">): string {
  const ext = UPLOAD_TYPES[u.type];
  if (!ext) throw new UploadError(`Not an image this app stores (${u.type || "unknown type"}). Use PNG, JPEG, GIF, WebP or BMP.`);
  if (u.bytes.length === 0) throw new UploadError("The image is empty.");
  if (u.bytes.length > MAX_UPLOAD_BYTES) throw new UploadError(`The image is ${(u.bytes.length / 1048576).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1048576} MB.`);
  return ext;
}

export const uploadMessage = (u: Pick<ChartUpload, "date" | "symbol" | "kind">) => `Add ${u.symbol.toUpperCase()} ${u.date} ${u.kind} chart (uploaded in the journal)`;

/** Commit the image to `repo`'s main. Re-reads and retries if main moves meanwhile. */
export async function commitChart(gh: GitHubClient, repo: RepoId, u: ChartUpload, attempts = 3): Promise<CommitResult & { path: string }> {
  const ext = checkUpload(u);
  for (let i = 1; ; i++) {
    try {
      const state = await readState(gh, repo);
      const path = uploadPath(state.files.keys(), u.date, u.symbol, u.kind, ext);
      const commit = await commitFiles(gh, state, [{ path, content: u.bytes }], uploadMessage(u));
      // A new path always changes the tree, so a commit is always made.
      return { ...commit!, path };
    } catch (e) {
      if (e instanceof RefMovedError && i < attempts) continue;
      throw explain(e, repo);
    }
  }
}

function explain(e: unknown, repo: RepoId): unknown {
  if (!(e instanceof GitHubError)) return e;
  if (e.kind === "not-found") {
    return new UploadError(`The token can't see ${repoName(repo)}. On GitHub, edit the token: under Repository access add ${repo.repo}, with Contents: read and write.`);
  }
  if (e.kind === "permission") return new UploadError(`The token can read ${repoName(repo)} but not write to it. Set Contents to read and write for ${repo.repo}.`);
  return e;
}

/** Whether a token can write to `repo` (an unreferenced blob changes nothing). */
export async function canWrite(gh: GitHubClient, repo: RepoId): Promise<boolean> {
  try {
    await gh.request("POST", `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/git/blobs`, { content: "", encoding: "utf-8" });
    return true;
  } catch (e) {
    if (e instanceof GitHubError && (e.kind === "permission" || e.kind === "not-found")) return false;
    throw e;
  }
}
