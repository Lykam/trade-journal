// Dev-only Vite plugin: serves the plaintext trade-history, Playbook reviews and
// quotes.json at <base>__data/bundle.json, and Playbook images at
// <base>__data/playbook/<path>, while `npm run dev` runs. `apply: "serve"` keeps
// it out of `vite build` entirely, and the app only fetches these behind
// import.meta.env.DEV, so neither the data nor the loader reaches dist/
// (checked by test/build-leak.test.ts and build/check-dist.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { resolveHistoryDir } from "../cli/lib/history";
import { resolveQuotesFile } from "./fetch-quotes";
import { loadBundle } from "./load-bundle";
import { imageType } from "../src/core/reviews/images";
import { loadPlaybook, resolvePlaybookDir } from "./playbook";

export const DEV_DATA_PATH = "__data/bundle.json";
export const DEV_PLAYBOOK_PATH = "__data/playbook/";

const norm = (p: string) => p.replace(/\\/g, "/");

export function devDataPlugin(): Plugin {
  return {
    name: "trade-journal:dev-data",
    apply: "serve",
    configureServer(server) {
      const historyDir = resolveHistoryDir();
      const quotesFile = resolveQuotesFile();
      const playbookDir = resolvePlaybookDir();
      const url = `${server.config.base}${DEV_DATA_PATH}`;
      const imagePrefix = `${server.config.base}${DEV_PLAYBOOK_PATH}`;

      // Reload the page when an import, `npm run quotes` or a Playbook review/chart changes the data.
      const files = [`${historyDir}/derived/trades.json`, `${historyDir}/config.json`, `${historyDir}/symbols.json`, `${historyDir}/overrides.json`, quotesFile].map(norm);
      const dirs = [`${playbookDir}/Reviews/`, `${playbookDir}/Images/`].map(norm);
      server.watcher.add([...files, ...dirs]);
      const onChange = (file: string) => {
        const f = norm(file);
        if (files.includes(f) || dirs.some((d) => f.startsWith(d))) server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("change", onChange);
      server.watcher.on("add", onChange);
      server.watcher.on("unlink", onChange);

      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        if (path === url) {
          try {
            const body = JSON.stringify(loadBundle(historyDir, quotesFile, playbookDir));
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(body);
          } catch (e) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: (e as Error).message }));
          }
          return;
        }
        if (path.startsWith(imagePrefix)) {
          // Only files in the current image list are served, so no path can escape the Playbook folder.
          let rel = "";
          try {
            rel = decodeURIComponent(path.slice(imagePrefix.length));
          } catch {
            /* malformed: falls through to 404 */
          }
          const images = loadPlaybook(playbookDir)?.images ?? [];
          if (!images.includes(rel)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader("Content-Type", imageType(rel));
          res.setHeader("Cache-Control", "no-store");
          res.end(readFileSync(join(playbookDir, rel)));
          return;
        }
        next();
      });
    },
  };
}
