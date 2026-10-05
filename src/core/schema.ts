// JSON Schema validation for the trade-history contract (SPEC §7, Q17). The
// schema texts come from trade-journal/schema/: read from disk by the CLI and
// bundled (?raw) by the app, so both validate against the same files.
// Ajv lives here only, so the app loads it with the import / commit code, not up front.
import { Ajv, type ValidateFunction } from "ajv";
import { DataFileError } from "./data-error";
import type { SchemaName, SchemaTexts, Validate } from "./schema-names";

export { SCHEMAS, type SchemaName, type SchemaTexts, type Validate } from "./schema-names";

export function makeValidator(texts: SchemaTexts): Validate {
  const ajv = new Ajv({ allErrors: true });
  const compiled = new Map<SchemaName, ValidateFunction>();
  return (name, data, label) => {
    let v = compiled.get(name);
    if (!v) {
      v = ajv.compile(JSON.parse(texts[name]) as object);
      compiled.set(name, v);
    }
    if (!v(data)) {
      const errs = (v.errors ?? []).slice(0, 5).map((e) => `  ${e.instancePath || "/"} ${e.message}`);
      throw new DataFileError(label, "schema mismatch", `${label} does not match ${name}.schema.json:\n${errs.join("\n")}`);
    }
  };
}
