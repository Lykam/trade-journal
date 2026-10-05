// JSON Schema validation for the trade-history contract (SPEC §7, Q17). The
// schema texts come from trade-journal/schema/. The CLI compiles them here with
// Ajv at runtime; the app uses the same schemas precompiled at build time
// (build/validators-plugin.ts), because the site's CSP forbids `new Function` (Q46).
import { Ajv, type ValidateFunction } from "ajv";
import { validatorFrom, type SchemaName, type SchemaTexts, type Validate } from "./schema-names.ts";

export { SCHEMAS, type SchemaName, type SchemaTexts, type Validate } from "./schema-names.ts";

export function makeValidator(texts: SchemaTexts): Validate {
  const ajv = new Ajv({ allErrors: true });
  const compiled = new Map<SchemaName, ValidateFunction>();
  return validatorFrom((name) => {
    let v = compiled.get(name);
    if (!v) {
      v = ajv.compile(JSON.parse(texts[name]) as object);
      compiled.set(name, v);
    }
    return v;
  });
}
