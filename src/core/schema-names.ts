// Names and types of the trade-history JSON Schemas, and the validate wrapper
// shared by the runtime (Ajv) and precompiled validators. No Ajv here, so
// importing it is free.
import { DataFileError } from "./data-error";

export const SCHEMAS = ["fills", "overrides", "config", "symbols", "trades"] as const;
export type SchemaName = (typeof SCHEMAS)[number];
export type SchemaTexts = Record<SchemaName, string>;
/** Throws when `data` does not match the named schema. */
export type Validate = (name: SchemaName, data: unknown, label: string) => void;

/** An Ajv validate function: compiled at runtime, or precompiled (standalone). */
export interface ValidateFn {
  (data: unknown): boolean;
  errors?: Array<{ instancePath: string; message?: string }> | null;
}

/** A Validate over per-schema functions, throwing the same DataFileError either way. */
export function validatorFrom(get: (name: SchemaName) => ValidateFn): Validate {
  return (name, data, label) => {
    const v = get(name);
    if (!v(data)) {
      const errs = (v.errors ?? []).slice(0, 5).map((e) => `  ${e.instancePath || "/"} ${e.message}`);
      throw new DataFileError(label, "schema mismatch", `${label} does not match ${name}.schema.json:\n${errs.join("\n")}`);
    }
  };
}
