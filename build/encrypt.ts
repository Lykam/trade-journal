// npm run encrypt -- [--dist DIR] [--history-dir DIR] [--playbook-dir DIR] [--quotes FILE] [--regime FILE]
//
// Encrypt the data bundle and Playbook images into dist/ (SPEC §2 Encryption,
// §7 Deploy step 4, Q34) with Node `crypto`; the browser decrypts with
// WebCrypto (src/core/crypto.ts).
//
// - Key: PBKDF2-SHA256 over SITE_PASSPHRASE with the salt and iteration count
//   in build/kdf.json. The salt is random but fixed (salts are public), so the
//   key a browser remembers keeps working across deploys; edit kdf.json to
//   force every device to re-enter the passphrase.
// - dist/data.enc: gzipped JSON, padded to a 64 KiB bucket.
// - dist/img/<name>.enc: each image padded to a 32 KiB bucket, named by an HMAC
//   of its path and content under a key derived from the passphrase, plus
//   random decoys up to a multiple of 16 files, so dist/ reveals neither names
//   nor the image count.
//
// Output never includes data, names or real counts (CI logs are public).
import { createCipheriv, createHash, createHmac, hkdfSync, pbkdf2Sync, randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { REPO_ROOT } from "../cli/lib/history";
import {
  aadFor, DATA_BUCKET, encodeHeader, IMAGE_BUCKET, IMAGE_COUNT_BUCKET, IV_BYTES, KIND_DATA, KIND_IMAGE, KIND_SCAN, pad, PBKDF2_ITERATIONS,
  SALT_BYTES, SCAN_BUCKET, SCAN_COUNT_BUCKET,
} from "../src/core/crypto";
import type { DataBundle } from "../src/core/types";
import { type BundleImage, type BundleScanDay, bundleData, resolveSources } from "./bundle-data";
import { isPublicLog, PublicError, runMain } from "./public-log";

export const MIN_PASSPHRASE = 16;

export interface KdfParams {
  salt: Uint8Array;
  iterations: number;
}

export function readKdfParams(file = join(REPO_ROOT, "build", "kdf.json")): KdfParams {
  const j = JSON.parse(readFileSync(file, "utf8")) as { salt: string; iterations: number };
  const salt = new Uint8Array(Buffer.from(j.salt, "hex"));
  if (salt.length !== SALT_BYTES) throw new PublicError(`kdf.json: salt must be ${SALT_BYTES} bytes of hex`);
  if (!Number.isInteger(j.iterations) || j.iterations < PBKDF2_ITERATIONS) throw new PublicError(`kdf.json: iterations must be at least ${PBKDF2_ITERATIONS}`);
  return { salt, iterations: j.iterations };
}

export function deriveKeyNode(passphrase: string, kdf: KdfParams): Uint8Array {
  return new Uint8Array(pbkdf2Sync(passphrase.normalize("NFC"), kdf.salt, kdf.iterations, 32, "sha256"));
}

/** Encrypt one payload into the file format of src/core/crypto.ts. */
export function encryptPayload(key: Uint8Array, kdf: KdfParams, kind: number, payload: Uint8Array, bucket: number, name = ""): Uint8Array {
  const header = encodeHeader({ kind, iterations: kdf.iterations, salt: kdf.salt, iv: new Uint8Array(randomBytes(IV_BYTES)) });
  const iv = header.slice(header.length - IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aadFor(header, name));
  const body = Buffer.concat([cipher.update(pad(payload, bucket)), cipher.final(), cipher.getAuthTag()]);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

/** Image file names: HMAC-SHA256 of path + content under a key derived (HKDF) from the data key, so they are stable per image but unguessable. */
export function imageNamer(key: Uint8Array): (img: BundleImage) => string {
  const nameKey = Buffer.from(hkdfSync("sha256", key, new Uint8Array(0), "trade-journal image names v1", 32));
  return (img) => {
    const digest = createHash("sha256").update(img.bytes).digest("hex");
    return createHmac("sha256", nameKey).update(`${img.path}\0${digest}`).digest("hex").slice(0, 32);
  };
}

/** Scan-day file names: same construction as imageNamer, its own HKDF info string so the two name spaces never collide. */
export function scanNamer(key: Uint8Array): (s: BundleScanDay) => string {
  const nameKey = Buffer.from(hkdfSync("sha256", key, new Uint8Array(0), "trade-journal scan names v1", 32));
  return (s) => {
    const digest = createHash("sha256").update(s.bytes).digest("hex");
    return createHmac("sha256", nameKey).update(`${s.date}\0${digest}`).digest("hex").slice(0, 32);
  };
}

export interface EncryptResult {
  /** Files written to img/, decoys included (the only count that is public anyway). */
  imgFiles: number;
  /** Files written to scans/, decoys included. */
  scanFiles: number;
}

/** Decoys of random size, encrypted like the real files in dir, up to the next multiple of countBucket — so the real count never shows. */
function writeDecoys(dir: string, key: Uint8Array, kdf: KdfParams, kind: number, bucket: number, countBucket: number, written: Set<string>) {
  const total = Math.max(1, Math.ceil(written.size / countBucket)) * countBucket;
  while (written.size < total) {
    const n = randomBytes(16).toString("hex");
    if (written.has(n)) continue;
    written.add(n);
    writeFileSync(join(dir, `${n}.enc`), encryptPayload(key, kdf, kind, new Uint8Array(randomInt(1, 8) * bucket - 4), bucket, n));
  }
}

/** Writes data.enc, img/*.enc and scans/*.enc into distDir, replacing any previous img/ and scans/. */
export function encryptBundle(
  bundle: DataBundle,
  images: BundleImage[],
  scanDays: BundleScanDay[],
  passphrase: string,
  distDir: string,
  kdf: KdfParams = readKdfParams(),
): EncryptResult {
  if (passphrase.length < MIN_PASSPHRASE) throw new PublicError(`SITE_PASSPHRASE must be at least ${MIN_PASSPHRASE} characters`);
  const key = deriveKeyNode(passphrase, kdf);
  const name = imageNamer(key);
  const imgDir = join(distDir, "img");
  rmSync(imgDir, { recursive: true, force: true });
  mkdirSync(imgDir, { recursive: true });

  const imageFiles: Record<string, string> = {};
  const writtenImages = new Set<string>();
  for (const img of images) {
    const n = name(img);
    imageFiles[img.path] = n;
    if (writtenImages.has(n)) continue;
    writtenImages.add(n);
    writeFileSync(join(imgDir, `${n}.enc`), encryptPayload(key, kdf, KIND_IMAGE, img.bytes, IMAGE_BUCKET, n));
  }
  writeDecoys(imgDir, key, kdf, KIND_IMAGE, IMAGE_BUCKET, IMAGE_COUNT_BUCKET, writtenImages);

  const scanName = scanNamer(key);
  const scanDir = join(distDir, "scans");
  rmSync(scanDir, { recursive: true, force: true });
  mkdirSync(scanDir, { recursive: true });

  const watchlistScanHistoryFiles: Record<string, string> = {};
  const writtenScans = new Set<string>();
  for (const s of scanDays) {
    const n = scanName(s);
    watchlistScanHistoryFiles[s.date] = n;
    if (writtenScans.has(n)) continue;
    writtenScans.add(n);
    writeFileSync(join(scanDir, `${n}.enc`), encryptPayload(key, kdf, KIND_SCAN, new Uint8Array(gzipSync(s.bytes, { level: 9 })), SCAN_BUCKET, n));
  }
  writeDecoys(scanDir, key, kdf, KIND_SCAN, SCAN_BUCKET, SCAN_COUNT_BUCKET, writtenScans);

  const json = JSON.stringify({ ...bundle, imageFiles, watchlistScanHistoryFiles } satisfies DataBundle);
  writeFileSync(join(distDir, "data.enc"), encryptPayload(key, kdf, KIND_DATA, new Uint8Array(gzipSync(json, { level: 9 })), DATA_BUCKET));
  return { imgFiles: writtenImages.size, scanFiles: writtenScans.size };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { dist: { type: "string" }, "history-dir": { type: "string" }, "playbook-dir": { type: "string" }, quotes: { type: "string" }, regime: { type: "string" } },
  });
  await runMain("encrypt", () => {
    const passphrase = process.env.SITE_PASSPHRASE ?? "";
    if (!passphrase) throw new PublicError("SITE_PASSPHRASE is not set");
    const dist = resolve(values.dist ?? join(REPO_ROOT, "dist"));
    if (!existsSync(join(dist, "index.html"))) throw new PublicError("the dist folder has no index.html (run vite build first)");
    const { bundle, images, scanDays } = bundleData(
      resolveSources({ historyDir: values["history-dir"], playbookDir: values["playbook-dir"], quotesFile: values.quotes, regimeFile: values.regime }),
    );
    const r = encryptBundle(bundle, images, scanDays, passphrase, dist);
    // Public logs get no counts at all, not even the padded one (Q35).
    console.log(
      isPublicLog()
        ? "encrypt: wrote data.enc, img/*.enc and scans/*.enc (padded with decoys)"
        : `encrypt: wrote data.enc, ${r.imgFiles} img/*.enc and ${r.scanFiles} scans/*.enc files (padded with decoys)`,
    );
  });
}
