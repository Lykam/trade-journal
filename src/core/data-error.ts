// A trade-history or Playbook file that could not be read. `file` and `kind` are
// safe for public CI logs; `message` is not (Node's JSON.parse quotes its input,
// and a schema error's instance path starts with an object key such as a ticker
// or fill id), so public logs print only "<file>: <kind>" (SPEC §8, Q43).
export type DataErrorKind = "invalid JSON" | "schema mismatch";

export class DataFileError extends Error {
  override name = "DataFileError";

  constructor(
    readonly file: string,
    readonly kind: DataErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** JSON.parse that reports which file failed, as a DataFileError. */
export function parseJsonFile<T>(text: string, file: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new DataFileError(file, "invalid JSON", `${file}: ${(e as Error).message}`);
  }
}
