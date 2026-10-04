// Names and types of the trade-history JSON Schemas (no Ajv, so importing them is free).
export const SCHEMAS = ["fills", "overrides", "config", "symbols", "trades"] as const;
export type SchemaName = (typeof SCHEMAS)[number];
export type SchemaTexts = Record<SchemaName, string>;
/** Throws when `data` does not match the named schema. */
export type Validate = (name: SchemaName, data: unknown, label: string) => void;
