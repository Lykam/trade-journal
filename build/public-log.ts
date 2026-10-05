// Error output for the scripts the workflows run (SPEC §8, Q35, Q43). Actions
// logs of this public repo are public, so with TJ_PUBLIC_LOG=1 an error prints
// only the script's label and the error kind: never the message, an Ajv
// instance path or a stack, which can quote a data file, a ticker, a fill id or
// a private path. Locally the full message is kept.
import { DataFileError } from "../src/core/data-error.ts";

/** True in the workflows: their logs are public, so scripts print no counts and no error details (Q35). */
export function isPublicLog(): boolean {
  return process.env.TJ_PUBLIC_LOG === "1";
}

/** An error whose message is a fixed string with no data in it, so public logs may print it. */
export class PublicError extends Error {
  override name = "PublicError";
}

/** One line describing `e` for the log: "<label>: <file>: <kind>" or "<label>: <kind>" in public logs, the full message locally. */
export function publicSafeError(e: unknown, label: string, publicLog = isPublicLog()): string {
  if (!publicLog) return `${label}: ${e instanceof Error ? e.message : String(e)}`;
  if (e instanceof PublicError) return `${label}: ${e.message}`;
  if (e instanceof DataFileError) return `${label}: ${e.file}: ${e.kind}`;
  if (e instanceof SyntaxError) return `${label}: a data file is not valid JSON`;
  const name = e instanceof Error && /^\w{1,40}$/.test(e.name) ? e.name : "error";
  return `${label}: failed (${name})`;
}

/**
 * Run a script's main body: an error (thrown or rejected) prints one
 * publicSafeError line to stderr and sets a non-zero exit code, never an
 * uncaught stack. A number returned becomes the exit code.
 */
export async function runMain(label: string, main: () => number | void | Promise<number | void>): Promise<void> {
  try {
    const code = await main();
    if (typeof code === "number") process.exitCode = code;
  } catch (e) {
    console.error(publicSafeError(e, label));
    process.exitCode = 1;
  }
}
