// Short notes on MOVERS rows (SPEC §6.7f, Q86): mover-notes.json in trade-history,
// kept apart from movers.json because the weekly run rewrites that file.
// One note per mover-week, keyed "<week end>|<ticker>", at most NOTE_MAX characters.

export const NOTES_PATH = "mover-notes.json";
export const NOTE_MAX = 200;

export interface MoverNote {
  text: string;
  /** ET date of the last edit. */
  updated: string;
}

export interface MoverNotesFile {
  schemaVersion: 1;
  notes: Record<string, MoverNote>;
}

export const noteKey = (weekEnd: string, ticker: string) => `${weekEnd}|${ticker}`;

export const emptyNotes = (): MoverNotesFile => ({ schemaVersion: 1, notes: {} });

/** Parse mover-notes.json; null for anything else. */
export function parseNotes(text: string | undefined | null): MoverNotesFile | null {
  if (!text) return null;
  try {
    const f = JSON.parse(text) as MoverNotesFile;
    return f && f.schemaVersion === 1 && f.notes && typeof f.notes === "object" && !Array.isArray(f.notes) ? f : null;
  } catch {
    return null;
  }
}

/** Whitespace collapsed to single spaces and trimmed; one line, as the table shows it. */
export const cleanNote = (text: string) => text.replace(/\s+/g, " ").trim();

export class NoteError extends Error {
  override name = "NoteError";
}

/** The file with `key`'s note set to `text` (cleaned), or removed when `text` is blank. Keys stay sorted so diffs are small. */
export function applyNote(file: MoverNotesFile | null, key: string, text: string, date: string): MoverNotesFile {
  const t = cleanNote(text);
  if (t.length > NOTE_MAX) throw new NoteError(`A note is at most ${NOTE_MAX} characters (this one is ${t.length}).`);
  const notes = { ...(file?.notes ?? {}) };
  if (t) notes[key] = { text: t, updated: date };
  else delete notes[key];
  return { schemaVersion: 1, notes: Object.fromEntries(Object.entries(notes).sort(([a], [b]) => a.localeCompare(b))) };
}

export const notesJson = (file: MoverNotesFile) => `${JSON.stringify(file, null, 2)}\n`;
