/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cspPlugin } from "./build/csp-plugin.ts";
import { devDataPlugin } from "./build/dev-data-plugin.ts";
import { validatorsPlugin } from "./build/validators-plugin.ts";
import pkg from "./package.json" with { type: "json" };

// `--mode demo` builds the public demo (SPEC §7, Q50): synthetic data generated in the
// browser, write features off. Every other build has __TJ_DEMO__ = false, so the demo
// code is dropped from it. TJ_BASE overrides the base path.
export default defineConfig(({ mode }) => {
  const demo = mode === "demo";
  return {
    plugins: [react(), devDataPlugin(), validatorsPlugin(fileURLToPath(new URL("./schema", import.meta.url))), cspPlugin({ github: !demo })],
    base: process.env.TJ_BASE ?? (demo ? "/trade-journal/demo/" : "/trade-journal/"),
    build: { outDir: demo ? "dist-demo" : "dist" },
    // __TJ_DEMO_PASSPHRASE__ is null here; only build/preview-demo.ts overrides it (the OPEN DEMO button).
    define: { __APP_VERSION__: JSON.stringify(pkg.version), __TJ_DEMO_PASSPHRASE__: "null", __TJ_DEMO__: JSON.stringify(demo) },
    test: {
      include: ["test/**/*.test.ts"],
    },
  };
});
