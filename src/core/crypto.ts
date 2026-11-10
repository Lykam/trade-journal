// Encrypted bundle format (SPEC §2 Encryption, Q34). The build encrypts with
// Node `crypto` (build/encrypt.ts); the browser decrypts with WebCrypto here.
// Everything in this file is pure or WebCrypto-only, so it runs in both.
//
// File layout (data.enc and img/<name>.enc):
//   magic "TJE1" | kind (1 = data, 2 = image, 3 = cache) | iterations (u32 BE) | salt (16) | iv (12) | AES-256-GCM ciphertext + tag (16)
// The header is the GCM additional data, and an image also binds its own file
// name, so files can't be swapped or their parameters altered.
// Plaintext: payload length (u32 BE) | payload | zero padding up to a size bucket,
// so file sizes reveal only a coarse range. data.enc's payload is gzipped JSON.

export const MAGIC = [0x54, 0x4a, 0x45, 0x31]; // "TJE1"
export const KIND_DATA = 1;
export const KIND_IMAGE = 2;
/** The prices workflow's cached quotes.json (actions/cache is readable by other workflows, so it is stored encrypted). */
export const KIND_CACHE = 3;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + 1 + 4 + SALT_BYTES + IV_BYTES;
export const PBKDF2_ITERATIONS = 600_000;
/** Plaintext size buckets: data.enc pads to 64 KiB, each image to 32 KiB. */
export const DATA_BUCKET = 64 * 1024;
export const IMAGE_BUCKET = 32 * 1024;
/** Image files are padded with decoys to a multiple of this, so the file count is not the image count. */
export const IMAGE_COUNT_BUCKET = 16;
/** Image file names: 32 hex chars (128 bits of an HMAC), never derived from anything guessable. */
export const IMAGE_NAME_RE = /^[0-9a-f]{32}$/;

export interface Header {
  kind: number;
  iterations: number;
  salt: Uint8Array;
  iv: Uint8Array;
}

export function encodeHeader(h: Header): Uint8Array {
  if (h.salt.length !== SALT_BYTES || h.iv.length !== IV_BYTES) throw new Error("bad salt or iv length");
  const out = new Uint8Array(HEADER_BYTES);
  out.set(MAGIC, 0);
  out[4] = h.kind;
  new DataView(out.buffer).setUint32(5, h.iterations);
  out.set(h.salt, 9);
  out.set(h.iv, 9 + SALT_BYTES);
  return out;
}

/** Parses an encrypted file's header; throws on anything that isn't one of ours. */
export function decodeHeader(file: Uint8Array): Header {
  if (file.length < HEADER_BYTES + TAG_BYTES || MAGIC.some((b, i) => file[i] !== b)) throw new Error("not an encrypted journal file");
  const kind = file[4]!;
  if (kind !== KIND_DATA && kind !== KIND_IMAGE && kind !== KIND_CACHE) throw new Error("unknown encrypted file kind");
  const iterations = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(5);
  return { kind, iterations, salt: file.slice(9, 9 + SALT_BYTES), iv: file.slice(9 + SALT_BYTES, HEADER_BYTES) };
}

/** GCM additional data: the header, plus the file name for images. */
export function aadFor(header: Uint8Array, name = ""): Uint8Array {
  const n = new TextEncoder().encode(name);
  const out = new Uint8Array(header.length + n.length);
  out.set(header, 0);
  out.set(n, header.length);
  return out;
}

export function paddedSize(payloadBytes: number, bucket: number): number {
  return Math.max(1, Math.ceil((payloadBytes + 4) / bucket)) * bucket;
}

/** Length-prefixed payload, zero-padded to the bucket. */
export function pad(payload: Uint8Array, bucket: number): Uint8Array {
  const out = new Uint8Array(paddedSize(payload.length, bucket));
  new DataView(out.buffer).setUint32(0, payload.length);
  out.set(payload, 4);
  return out;
}

export function unpad(plain: Uint8Array): Uint8Array {
  if (plain.length < 4) throw new Error("truncated plaintext");
  const n = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0);
  if (n > plain.length - 4) throw new Error("bad payload length");
  return plain.slice(4, 4 + n);
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const subtle = () => globalThis.crypto.subtle;
/** WebCrypto wants ArrayBuffer-backed views; copies when a view is backed by something else. */
const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => (b.buffer instanceof ArrayBuffer ? (b as Uint8Array<ArrayBuffer>) : new Uint8Array(b));

/** PBKDF2-SHA256 → 32 raw key bytes. These bytes are what the browser keeps (never the passphrase). */
export async function deriveKeyBytes(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await subtle().importKey("raw", new TextEncoder().encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations }, base, 256);
  return new Uint8Array(bits);
}

/** A non-extractable AES-GCM key for decrypting. */
export function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", buf(raw), "AES-GCM", false, ["decrypt"]);
}

export class WrongKeyError extends Error {
  override name = "WrongKeyError";
}

/** Decrypts one file and returns its unpadded payload. A wrong key (or a tampered file) throws WrongKeyError. */
export async function decryptFile(key: CryptoKey, file: Uint8Array, expectKind: number, name = ""): Promise<Uint8Array> {
  const h = decodeHeader(file);
  if (h.kind !== expectKind) throw new Error("unexpected encrypted file kind");
  const aad = aadFor(file.slice(0, HEADER_BYTES), name);
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: "AES-GCM", iv: buf(h.iv), additionalData: buf(aad), tagLength: TAG_BYTES * 8 }, key, buf(file.slice(HEADER_BYTES)));
  } catch {
    throw new WrongKeyError("decryption failed");
  }
  return unpad(new Uint8Array(plain));
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([buf(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** data.enc → the bundle object. */
export async function decryptData<T>(key: CryptoKey, file: Uint8Array): Promise<T> {
  const payload = await decryptFile(key, file, KIND_DATA);
  return JSON.parse(new TextDecoder().decode(await gunzip(payload))) as T;
}

/**
 * A separate AES-GCM key for one purpose (e.g. sealing the GitHub token),
 * derived from the data key's raw bytes with HKDF-SHA256. Non-extractable.
 */
export async function deriveSubKey(raw: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", buf(raw), "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A small secret sealed with AES-GCM: JSON-safe, base64 fields. */
export interface Sealed {
  v: 1;
  iv: string;
  ct: string;
}

export async function seal(key: CryptoKey, plaintext: string, aad: string): Promise<Sealed> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad), tagLength: TAG_BYTES * 8 },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { v: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Throws WrongKeyError if the key or the additional data don't match. */
export async function unseal(key: CryptoKey, sealed: Sealed, aad: string): Promise<string> {
  try {
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv: buf(fromBase64(sealed.iv)), additionalData: new TextEncoder().encode(aad), tagLength: TAG_BYTES * 8 },
      key,
      buf(fromBase64(sealed.ct)),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new WrongKeyError("could not unseal");
  }
}
