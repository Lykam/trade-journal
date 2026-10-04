// Dev-only Vite plugin: serves the plaintext trade-history + quotes.json at
// <base>__data/bundle.json while `npm run dev` runs. `apply: "serve"` keeps it
// out of `vite build` entirely, and the app only fetches it behind
// import.meta.env.DEV, so neither the data nor the loader reaches dist/
// (checked by test/build-leak.test.ts and build/check-dist.ts).
import type { Plugin } from "vite";
import { resolveHistoryDir } from "../cli/lib/history";
import { resolveQuotesFile } from "./fetch-quotes";
import { loadBundle } from "./load-bundle";

export const DEV_DATA_PATH = "__data/bundle.json";

export function devDataPlugin(): Plugin {
  return {
    name: "trade-journal:dev-data",
    apply: "serve",
    configureServer(server) {
      const historyDir = resolveHistoryDir();
      const quotesFile = resolveQuotesFile();
      const url = `${server.config.base}${DEV_DATA_PATH}`;

      // Reload the page when an import or `npm run quotes` changes the data.
      const watched = [`${historyDir}/derived/trades.json`, `${historyDir}/config.json`, `${historyDir}/symbols.json`, quotesFile];
      server.watcher.add(watched);
      server.watcher.on("change", (file) => {
        if (watched.some((w) => w.replace(/\\/g, "/") === file.replace(/\\/g, "/"))) server.ws.send({ type: "full-reload" });
      });

      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== url) return next();
        try {
          const body = JSON.stringify(loadBundle(historyDir, quotesFile));
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(body);
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
    },
  };
}
