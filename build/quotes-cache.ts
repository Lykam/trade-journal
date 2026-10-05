// npm run quotes:cache -- save|restore [--quotes FILE] [--cache FILE]
//
// The workflows keep the last quotes.json between runs with actions/cache, so a
// failed Yahoo fetch can fall back to it, marked stale (SPEC §5.4). Caches in a
// public repo can be restored by other workflow runs, so the file is cached
// encrypted under the site key and never as plaintext (Q34).
//   save:    quotes.json → quotes-cache.enc
//   restore: quotes-cache.enc → quotes.json (skipped, without failing, when
//            there is no cache or it was made with a different passphrase)
import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../cli/lib/history";
import { aadFor, decodeHeader, HEADER_BYTES, KIND_CACHE, TAG_BYTES, unpad } from "../src/core/crypto";
import { deriveKeyNode, encryptPayload, type KdfParams, readKdfParams } from "./encrypt";
import { resolveQuotesFile } from "./fetch-quotes";
import { runMain } from "./public-log";

const CACHE_BUCKET = 4 * 1024;

export function sealCache(json: string, passphrase: string, kdf: KdfParams = readKdfParams()): Uint8Array {
  return encryptPayload(deriveKeyNode(passphrase, kdf), kdf, KIND_CACHE, new TextEncoder().encode(json), CACHE_BUCKET);
}

/** The cached JSON, or null if the file isn't a cache made with this passphrase. */
export function openCache(file: Uint8Array, passphrase: string): string | null {
  try {
    const h = decodeHeader(file);
    if (h.kind !== KIND_CACHE) return null;
    const key = deriveKeyNode(passphrase, { salt: h.salt, iterations: h.iterations });
    const d = createDecipheriv("aes-256-gcm", key, h.iv);
    d.setAAD(aadFor(file.slice(0, HEADER_BYTES)));
    d.setAuthTag(file.slice(file.length - TAG_BYTES));
    const plain = Buffer.concat([d.update(file.slice(HEADER_BYTES, file.length - TAG_BYTES)), d.final()]);
    return new TextDecoder().decode(unpad(new Uint8Array(plain)));
  } catch {
    return null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await runMain("quotes-cache", () => {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2), allowPositionals: true, options: { quotes: { type: "string" }, cache: { type: "string" } },
    });
    const mode = positionals[0];
    const quotes = resolveQuotesFile(values.quotes);
    const cache = resolve(values.cache ?? join(REPO_ROOT, "quotes-cache.enc"));
    const passphrase = process.env.SITE_PASSPHRASE ?? "";
    if (!passphrase || (mode !== "save" && mode !== "restore")) {
      console.error("usage: SITE_PASSPHRASE=… npm run quotes:cache -- save|restore");
      process.exitCode = 1;
    } else if (mode === "save") {
      if (existsSync(quotes)) {
        writeFileSync(cache, sealCache(readFileSync(quotes, "utf8"), passphrase));
        console.log("quotes-cache: saved (encrypted)");
      } else console.log("quotes-cache: no quotes.json to save");
    } else {
      const json = existsSync(cache) ? openCache(new Uint8Array(readFileSync(cache)), passphrase) : null;
      if (json !== null) {
        writeFileSync(quotes, json);
        console.log("quotes-cache: restored");
      } else console.log("quotes-cache: no usable cache; starting without previous quotes");
    }
  });
}
