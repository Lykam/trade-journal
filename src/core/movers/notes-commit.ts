// Commit one MOVERS note to trade-history's mover-notes.json (Q86). Loaded only
// on save (dynamic import), never in the demo. The file is read fresh at commit
// time and the commit retried if main moved, so a note saved elsewhere is kept.
import { etDate } from "../normalize/util";
import { commitFiles, readBlob, readState, RefMovedError, type GitHubClient, type RepoId } from "../github/client";
import { applyNote, notesJson, NOTES_PATH, parseNotes, type MoverNotesFile } from "./notes";

export interface NoteCommit {
  file: MoverNotesFile;
  /** Committer date and sha, for the deploy watcher; null when nothing changed. */
  date: string | null;
  sha: string | null;
  url: string | null;
}

export async function commitMoverNote(gh: GitHubClient, repo: RepoId, key: string, text: string, now = new Date(), attempts = 3): Promise<NoteCommit> {
  for (let attempt = 1; ; attempt++) {
    const state = await readState(gh, repo);
    const current = state.files.has(NOTES_PATH) ? parseNotes(new TextDecoder().decode(await readBlob(gh, state, NOTES_PATH))) : null;
    const file = applyNote(current, key, text, etDate(now.toISOString()));
    const [weekEnd, ticker] = key.split("|");
    const verb = file.notes[key] ? (current?.notes[key] ? "Edit" : "Add") : "Remove";
    try {
      const res = await commitFiles(gh, state, [{ path: NOTES_PATH, content: notesJson(file) }], `${verb} mover note: ${ticker} week of ${weekEnd}`);
      return { file, date: res?.date ?? null, sha: res?.sha ?? null, url: res?.url ?? null };
    } catch (e) {
      if (!(e instanceof RefMovedError) || attempt >= attempts) throw e;
    }
  }
}
