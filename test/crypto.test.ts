// Node `crypto` encrypts (build/encrypt.ts); WebCrypto decrypts (src/core/crypto.ts),
// exactly as the browser does. Synthetic data only.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkEncFile, entropy } from "../build/check-dist";
import { deriveKeyNode, encryptBundle, encryptPayload, imageNamer, type KdfParams, MIN_PASSPHRASE, readKdfParams, safeMessage } from "../build/encrypt";
import { openCache, sealCache } from "../build/quotes-cache";
import {
  DATA_BUCKET, decodeHeader, decryptData, decryptFile, deriveKeyBytes, fromBase64, HEADER_BYTES, IMAGE_BUCKET, IMAGE_COUNT_BUCKET,
  IMAGE_NAME_RE, importAesKey, KIND_DATA, KIND_IMAGE, pad, PBKDF2_ITERATIONS, TAG_BYTES, toBase64, unpad, WrongKeyError,
} from "../src/core/crypto";
import type { DataBundle } from "../src/core/types";

const PASS = "correct horse battery staple synthetic";
const kdf: KdfParams = readKdfParams();
const bundle = {
  config: {}, symbols: {}, derived: { generated: true, generator: "test", trades: [], ideas: [] }, fills: [],
  overrides: { trades: {}, openingPositions: [] }, quotes: null,
  playbook: { reviews: [{ path: "Reviews/2025-01-02-FAKE.md", markdown: "# synthetic" }], images: ["Images/2025-01-02/FAKE-daily.png", "Images/2025-01-02/FAKE-intraday.png"] },
  loadedAt: "2025-01-02T00:00:00Z",
} as unknown as DataBundle;
const images = [
  { path: "Images/2025-01-02/FAKE-daily.png", bytes: new TextEncoder().encode("fake png bytes A") },
  { path: "Images/2025-01-02/FAKE-intraday.png", bytes: new Uint8Array(40_000).fill(7) },
];
let dir: string;
let key: CryptoKey;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tj-crypto-"));
  encryptBundle(bundle, images, PASS, dir, kdf);
  key = await importAesKey(await deriveKeyBytes(PASS, kdf.salt, kdf.iterations));
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("key derivation", () => {
  it("PBKDF2 in WebCrypto and Node give the same key", async () => {
    expect(toBase64(await deriveKeyBytes(PASS, kdf.salt, kdf.iterations))).toBe(toBase64(deriveKeyNode(PASS, kdf)));
  });

  it("kdf.json uses a 16-byte salt and at least 600k iterations", () => {
    expect(kdf.salt.length).toBe(16);
    expect(kdf.iterations).toBeGreaterThanOrEqual(PBKDF2_ITERATIONS);
  });
});

describe("encryptBundle → WebCrypto", () => {
  it("decrypts data.enc back to the bundle, with the image map added", async () => {
    const file = new Uint8Array(readFileSync(join(dir, "data.enc")));
    expect(decodeHeader(file)).toMatchObject({ kind: KIND_DATA, iterations: kdf.iterations });
    const out = await decryptData<DataBundle>(key, file);
    expect(out.playbook).toEqual(bundle.playbook);
    expect(Object.keys(out.imageFiles ?? {})).toEqual(images.map((i) => i.path));
  });

  it("decrypts each image from its hashed name", async () => {
    const out = await decryptData<DataBundle>(key, new Uint8Array(readFileSync(join(dir, "data.enc"))));
    for (const img of images) {
      const name = out.imageFiles![img.path]!;
      expect(name).toMatch(IMAGE_NAME_RE);
      const bytes = await decryptFile(key, new Uint8Array(readFileSync(join(dir, "img", `${name}.enc`))), KIND_IMAGE, name);
      expect(bytes).toEqual(img.bytes);
    }
  });

  it("pads the image file count with decoys and every file to its bucket", () => {
    const names = readdirSync(join(dir, "img"));
    expect(names.length).toBe(IMAGE_COUNT_BUCKET);
    for (const n of names) {
      expect(n).toMatch(/^[0-9a-f]{32}\.enc$/);
      expect((statSync(join(dir, "img", n)).size - HEADER_BYTES - TAG_BYTES) % IMAGE_BUCKET).toBe(0);
      expect(checkEncFile(readFileSync(join(dir, "img", n)), KIND_IMAGE)).toEqual([]);
    }
    expect((statSync(join(dir, "data.enc")).size - HEADER_BYTES - TAG_BYTES) % DATA_BUCKET).toBe(0);
    expect(checkEncFile(readFileSync(join(dir, "data.enc")), KIND_DATA)).toEqual([]);
  });

  it("a wrong passphrase fails with WrongKeyError", async () => {
    const wrong = await importAesKey(await deriveKeyBytes(`${PASS}!`, kdf.salt, kdf.iterations));
    await expect(decryptData(wrong, new Uint8Array(readFileSync(join(dir, "data.enc"))))).rejects.toBeInstanceOf(WrongKeyError);
  });

  it("detects tampering and a swapped image name", async () => {
    const file = new Uint8Array(readFileSync(join(dir, "data.enc")));
    file[HEADER_BYTES + 10]! ^= 1;
    await expect(decryptData(key, file)).rejects.toBeInstanceOf(WrongKeyError);
    const header = new Uint8Array(readFileSync(join(dir, "data.enc")));
    header[6]! ^= 1; // iterations are authenticated too
    await expect(decryptData(key, header)).rejects.toBeInstanceOf(WrongKeyError);
    const [a] = readdirSync(join(dir, "img"));
    await expect(decryptFile(key, new Uint8Array(readFileSync(join(dir, "img", a!))), KIND_IMAGE, "0".repeat(32))).rejects.toBeInstanceOf(WrongKeyError);
  });

  it("refuses a short passphrase", () => {
    expect(() => encryptBundle(bundle, [], "x".repeat(MIN_PASSPHRASE - 1), dir, kdf)).toThrow(/at least/);
  });
});

describe("format helpers", () => {
  it("pad / unpad round-trip and hide the exact size", () => {
    const p = new TextEncoder().encode("hello");
    expect(pad(p, 1024).length).toBe(1024);
    expect(pad(new Uint8Array(1021), 1024).length).toBe(2048);
    expect(unpad(pad(p, 1024))).toEqual(p);
  });

  it("base64 round-trips", () => {
    const b = new Uint8Array([0, 1, 254, 255, 128]);
    expect(fromBase64(toBase64(b))).toEqual(b);
  });

  it("image names depend on path and content, and are stable for the same key", () => {
    const k = deriveKeyNode(PASS, kdf);
    const name = imageNamer(k);
    const a = { path: "Images/a.png", bytes: new Uint8Array([1]) };
    expect(name(a)).toBe(imageNamer(k)(a));
    expect(name(a)).not.toBe(name({ ...a, bytes: new Uint8Array([2]) }));
    expect(name(a)).not.toBe(name({ ...a, path: "Images/b.png" }));
  });

  it("checkEncFile rejects plaintext and low-entropy files", () => {
    expect(checkEncFile(new TextEncoder().encode('{"trades":[]}'), KIND_DATA)).toEqual(["not an encrypted journal file"]);
    const k = deriveKeyNode(PASS, kdf);
    const good = encryptPayload(k, kdf, KIND_DATA, new Uint8Array(10), DATA_BUCKET);
    const flat = good.slice();
    flat.fill(0, HEADER_BYTES);
    expect(checkEncFile(flat, KIND_DATA)).toContain("low entropy (not ciphertext?)");
    expect(checkEncFile(good, KIND_IMAGE)).toContain("wrong kind");
    expect(entropy(good.subarray(HEADER_BYTES))).toBeGreaterThan(7.9);
  });

  it("safeMessage drops JSON.parse errors, which quote the input", () => {
    let err: unknown;
    try {
      JSON.parse('{"symbol": SECRET}');
    } catch (e) {
      err = e;
    }
    expect(safeMessage(err)).not.toContain("SECRET");
    expect(safeMessage(new Error("SITE_PASSPHRASE is not set"))).toBe("SITE_PASSPHRASE is not set");
  });
});

describe("quotes cache", () => {
  it("round-trips encrypted, and a different passphrase gets nothing", () => {
    const json = JSON.stringify({ asOf: "x", quotes: { FAKE: { price: 1, time: "x" } } });
    const sealed = sealCache(json, PASS, kdf);
    expect(new TextDecoder("latin1").decode(sealed)).not.toContain("FAKE");
    expect(openCache(sealed, PASS)).toBe(json);
    expect(openCache(sealed, `${PASS}?`)).toBeNull();
    expect(openCache(new TextEncoder().encode(json), PASS)).toBeNull();
  });
});
