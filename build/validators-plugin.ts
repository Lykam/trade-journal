// Precompiled JSON Schema validators for the browser (SPEC §8, Q46). Ajv
// normally compiles a schema with `new Function`, which the site's CSP
// forbids; Ajv's standalone mode generates the same validators as plain code
// at build time instead. The app imports them as `virtual:tj-validators`; the
// CLI keeps compiling at runtime (src/core/schema.ts), from the same files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import standalone from "ajv/dist/standalone/index.js";
import type { Plugin } from "vite";
import { SCHEMAS } from "../src/core/schema-names";

const ID = "virtual:tj-validators";
const RESOLVED = `\0${ID}`;

// Runtime helpers the generated code may require, inlined so the output is pure ESM.
const RUNTIME: Record<string, string> = {
  // Length in Unicode code points, as JSON Schema's minLength / maxLength count it.
  "ajv/dist/runtime/ucs2length": "{ default: (s) => [...s].length }",
};

/** ESM source exporting one validate function per schema name. */
export function validatorsSource(schemaDir: string): string {
  const ajv = new Ajv({ allErrors: true, code: { source: true, esm: true } });
  for (const n of SCHEMAS) ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, `${n}.schema.json`), "utf8")) as object);
  const gen = (standalone as unknown as { default?: typeof standalone }).default ?? standalone;
  const code = gen(ajv, Object.fromEntries(SCHEMAS.map((n) => [n, `${n}.schema.json`])));
  const out = code.replace(/require\("([^"]+)"\)/g, (all, mod: string) => {
    const inline = RUNTIME[mod];
    if (!inline) throw new Error(`validators: generated code needs ${mod}; add it to RUNTIME`);
    return `(${inline})`;
  });
  return out;
}

export function validatorsPlugin(schemaDir: string): Plugin {
  return {
    name: "tj-validators",
    resolveId: (id) => (id === ID ? RESOLVED : undefined),
    load(id) {
      if (id !== RESOLVED) return undefined;
      for (const n of SCHEMAS) this.addWatchFile(join(schemaDir, `${n}.schema.json`));
      return validatorsSource(schemaDir);
    },
  };
}
