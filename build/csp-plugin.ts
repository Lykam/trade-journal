// Content-Security-Policy for the built site (SPEC §8, Q46). Added only to
// `vite build` output: the dev server needs inline styles and a websocket for
// hot reload. Inline scripts in index.html are allowed by their SHA-256 hash,
// computed from the final HTML, so editing one can't silently break it.
import { createHash } from "node:crypto";
import type { Plugin } from "vite";

export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' HASHES",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' blob: data:",
  // The app reads data.enc and img/*.enc from its own origin and talks only to the GitHub API.
  "connect-src 'self' https://api.github.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
];

/** The policy for an HTML page: every inline <script> body allowed by hash. */
export function cspFor(html: string): string {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`);
  return CSP_DIRECTIVES.join("; ").replace(" HASHES", hashes.length ? ` ${hashes.join(" ")}` : "");
}

export function cspPlugin(): Plugin {
  return {
    name: "tj-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (html) => {
        const meta = `<meta http-equiv="Content-Security-Policy" content="${cspFor(html)}" />`;
        const charset = /<meta charset="[^"]*" \/>/i.exec(html);
        return charset ? html.replace(charset[0], `${charset[0]}\n    ${meta}`) : html.replace("<head>", `<head>\n    ${meta}`);
      },
    },
  };
}
