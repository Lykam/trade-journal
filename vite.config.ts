/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { devDataPlugin } from "./build/dev-data-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react(), devDataPlugin()],
  base: "/trade-journal/",
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
