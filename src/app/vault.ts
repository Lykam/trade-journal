// Browser side of the encrypted site (SPEC §2 Encryption, Q34). Fetches
// data.enc, derives the key from the passphrase (WebCrypto), and keeps the
// derived key, never the passphrase, in sessionStorage, or in localStorage
// when "remember on this device" is on. Images decrypt to blob URLs on demand.
import {
  decodeHeader, decryptData, decryptFile, deriveKeyBytes, fromBase64, importAesKey, KIND_IMAGE, toBase64, WrongKeyError,
} from "../core/crypto";
import { imageType } from "../core/reviews/images";
import type { DataBundle } from "../core/types";

const STORAGE_KEY = "tj.key";

interface StoredKey {
  v: 1;
  salt: string;
  iterations: number;
  key: string;
}

type Where = "session" | "local";

function store(where: Where): Storage | null {
  try {
    return where === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function readStored(): { k: StoredKey; where: Where } | null {
  for (const where of ["session", "local"] as const) {
    try {
      const s = store(where)?.getItem(STORAGE_KEY);
      if (!s) continue;
      const k = JSON.parse(s) as StoredKey;
      if (k.v === 1 && typeof k.key === "string") return { k, where };
    } catch {
      /* unreadable entry: ignore it */
    }
  }
  return null;
}

function writeStored(k: StoredKey, remember: boolean) {
  clearStoredKey();
  try {
    store(remember ? "local" : "session")?.setItem(STORAGE_KEY, JSON.stringify(k));
  } catch {
    /* storage blocked: the key lives in memory for this page only */
  }
}

export function clearStoredKey() {
  for (const where of ["session", "local"] as const) {
    try {
      store(where)?.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to clear */
    }
  }
}

/** Whether the key is kept in localStorage ("remember on this device"). */
export function isRemembered(): boolean {
  return readStored()?.where === "local";
}

/** Moves the stored key between sessionStorage and localStorage. */
export function setRemembered(remember: boolean) {
  const s = readStored();
  if (s) writeStored(s.k, remember);
}

// The unlocked key and image map live in memory only.
let current: CryptoKey | null = null;
let imageFiles: Record<string, string> = {};
const imageUrls = new Map<string, Promise<string>>();

export class FetchError extends Error {
  override name = "FetchError";
}

/** The encrypted bundle, always fresh (Pages caches files for 10 minutes otherwise). */
export async function fetchEncrypted(): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.BASE_URL}data.enc`, { cache: "no-store" });
  } catch {
    throw new FetchError("Could not reach the site to load data.enc. Check your connection.");
  }
  if (!res.ok) throw new FetchError(`Could not load data.enc (HTTP ${res.status}). The site may not have been deployed yet.`);
  return new Uint8Array(await res.arrayBuffer());
}

async function open(file: Uint8Array, raw: Uint8Array): Promise<DataBundle> {
  const key = await importAesKey(raw);
  const bundle = await decryptData<DataBundle>(key, file);
  current = key;
  imageFiles = bundle.imageFiles ?? {};
  return bundle;
}

/**
 * Unlock with the key saved in this browser. null when there is none; throws
 * WrongKeyError when the saved key no longer opens the data (the passphrase or
 * salt changed), after clearing it.
 */
export async function unlockWithStored(file: Uint8Array): Promise<DataBundle | null> {
  const s = readStored();
  if (!s) return null;
  const h = decodeHeader(file);
  try {
    if (s.k.salt !== toBase64(h.salt) || s.k.iterations !== h.iterations) throw new WrongKeyError("key parameters changed");
    return await open(file, fromBase64(s.k.key));
  } catch (e) {
    clearStoredKey();
    throw e instanceof WrongKeyError ? e : new WrongKeyError("saved key unreadable");
  }
}

/** Derive the key from the passphrase and decrypt. A wrong passphrase throws WrongKeyError. */
export async function unlockWithPassphrase(file: Uint8Array, passphrase: string, remember: boolean): Promise<DataBundle> {
  const h = decodeHeader(file);
  const raw = await deriveKeyBytes(passphrase, h.salt, h.iterations);
  const bundle = await open(file, raw);
  writeStored({ v: 1, salt: toBase64(h.salt), iterations: h.iterations, key: toBase64(raw) }, remember);
  return bundle;
}

/** Forget the key everywhere and reload, which also drops the decrypted data and image URLs from memory. */
export function lock() {
  clearStoredKey();
  current = null;
  for (const p of imageUrls.values()) p.then(URL.revokeObjectURL, () => {});
  imageUrls.clear();
  window.location.reload();
}

export const hasEncryptedImage = (path: string) => current !== null && path in imageFiles;

/** A blob URL for a Playbook image, decrypted on first use. null when the image isn't in this deploy. */
export function encryptedImageUrl(path: string): Promise<string> | null {
  const name = imageFiles[path];
  if (!name || !current) return null;
  let p = imageUrls.get(name);
  if (!p) {
    const key = current;
    p = (async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}img/${name}.enc`);
      if (!res.ok) throw new FetchError(`HTTP ${res.status}`);
      const bytes = await decryptFile(key, new Uint8Array(await res.arrayBuffer()), KIND_IMAGE, name);
      return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: imageType(path) }));
    })();
    p.catch(() => imageUrls.delete(name));
    imageUrls.set(name, p);
  }
  return p;
}
