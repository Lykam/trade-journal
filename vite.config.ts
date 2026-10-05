/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cspPlugin } from "./build/csp-plugin.ts";
import { devDataPlugin } from "./build/dev-data-plugin.ts";
import { validatorsPlugin } from "./build/validators-plugin.ts";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react(), devDataPlugin(), validatorsPlugin(fileURLToPath(new URL("./schema", import.meta.url))), cspPlugin()],
  base: "/trade-journal/",
  // __TJ_DEMO_PASSPHRASE__ is null here; only build/preview-demo.ts overrides it (the OPEN DEMO button).
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __TJ_DEMO_PASSPHRASE__: "null" },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
