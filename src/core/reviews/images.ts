// Playbook chart images (SPEC §6.4 Charts). The chart-image skill saves them as
// Images/<DATE>/<TICKER>-<daily|intraday>[-2].png, and reviews embed them with
// paths relative to the review file ("../Images/<DATE>/<name>").

export interface ChartImage {
  path: string;
  date: string;
  symbol: string;
  kind: "daily" | "intraday";
  name: string;
}

const CHART_RE = /^Images\/(\d{4}-\d{2}-\d{2})\/([^/]+?)-(daily|intraday)[^/]*\.(png|jpe?g|gif|webp|bmp)$/i;
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
};

/** Content type by extension, for the dev server and for decrypted blob URLs. */
export const imageType = (path: string) => IMAGE_TYPES[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

export function parseChartPath(path: string): ChartImage | null {
  const m = CHART_RE.exec(path);
  if (!m) return null;
  return { path, date: m[1]!, symbol: m[2]!.toUpperCase(), kind: m[3]!.toLowerCase() as ChartImage["kind"], name: path.split("/").pop()! };
}

/**
 * The gallery label: the timeframe of a chart uploaded in the journal
 * (`-intraday-1m` → 1M, `-intraday-5m` → 5M), else its kind, plus AFTER for
 * the review skill's after-the-exit charts.
 */
export function chartLabel(c: ChartImage): string {
  const rest = c.name.replace(/\.[^.]+$/, "").slice(c.symbol.length + 1).toLowerCase();
  const tf = /^intraday-(1m|5m)\b/.exec(rest)?.[1];
  return `${tf ? tf.toUpperCase() : c.kind.toUpperCase()}${/-after\b/.test(rest) ? " AFTER" : ""}`;
}

// ---------------------------------------------------------------------------
// Uploads from Trade detail (Q78)

export type UploadKind = "1m" | "5m" | "daily";
export const UPLOAD_KINDS: UploadKind[] = ["1m", "5m", "daily"];
/** The file stem after the ticker. 1m / 5m stay "intraday" charts, so the gallery and the review skill still find them. */
const UPLOAD_STEM: Record<UploadKind, string> = { "1m": "intraday-1m", "5m": "intraday-5m", daily: "daily" };
export const UPLOAD_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };
/** Larger than any screenshot; keeps an accidental photo out of the repo. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export class UploadError extends Error {
  override name = "UploadError";
}

/**
 * Where an uploaded chart goes: Images/<DATE>/<SYMBOL>-<stem>.<ext>, adding
 * -2, -3, … when that name (in any image format) is already in `existing`, as
 * the chart-image skill does.
 */
export function uploadPath(existing: Iterable<string>, date: string, symbol: string, kind: UploadKind, ext: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UploadError(`Bad date: ${date}`);
  const sym = symbol.toUpperCase();
  if (!/^[A-Z0-9.]{1,12}$/.test(sym)) throw new UploadError(`Bad symbol: ${symbol}`);
  if (!Object.values(UPLOAD_TYPES).includes(ext)) throw new UploadError(`Unsupported image type: ${ext}`);
  const dir = `Images/${date}/`;
  const taken = new Set(
    [...existing].filter((p) => p.startsWith(dir) && IMAGE_EXT_RE.test(p)).map((p) => p.slice(dir.length).replace(IMAGE_EXT_RE, "").toUpperCase()),
  );
  const stem = `${sym}-${UPLOAD_STEM[kind]}`;
  let name = stem;
  for (let n = 2; taken.has(name.toUpperCase()); n++) name = `${stem}-${n}`;
  return `${dir}${name}.${ext}`;
}

/** Charts saved on any of `dates` for any of `symbols` (the underlying and the traded ETFs): daily first. */
export function chartsFor(images: string[], dates: Iterable<string>, symbols: Iterable<string>): ChartImage[] {
  const ds = new Set(dates);
  const ss = new Set([...symbols].map((s) => s.toUpperCase()));
  return images
    .map(parseChartPath)
    .filter((c): c is ChartImage => c !== null && ds.has(c.date) && ss.has(c.symbol))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "daily" ? -1 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Resolve an image or link `src` written inside a review to a Playbook-relative
 * path ("../Images/x.png" from "Reviews/a.md" → "Images/x.png"). Returns null
 * for absolute URLs and for paths that leave the Playbook root.
 */
export function resolvePlaybookPath(reviewPath: string, src: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//") || src.startsWith("#")) return null;
  let rel = src.split(/[?#]/)[0]!;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    /* keep as written */
  }
  const parts = rel.startsWith("/") ? [] : reviewPath.split("/").slice(0, -1);
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}
