/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { devDataPlugin } from "./build/dev-data-plugin";

export default defineConfig({
  plugins: [react(), devDataPlugin()],
  base: "/trade-journal/",
  test: {
    include: ["test/**/*.test.ts"],
  },
});
