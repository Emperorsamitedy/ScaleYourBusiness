// Per-purpose keys from one server secret — the security review of 2026-10-17.
//
// HKDF over COOKIE_SECRET (or CONNECTOR_KEY, so no new variable is needed
// to deploy), with a distinct label per purpose, so no two uses ever share
// a key. Cached per label; never logged. The support tier derives its own
// visitor-hash key the same way rather than importing this, because rule
// 21's import fence keeps it to its own modules.

import { hkdfSync } from "node:crypto";

const cache = new Map<string, Buffer>();

export function derivedKey(label: string): Buffer {
  const hit = cache.get(label);
  if (hit) return hit;
  const material = process.env.COOKIE_SECRET || process.env.CONNECTOR_KEY;
  if (!material) {
    throw new Error(
      `Missing COOKIE_SECRET (or CONNECTOR_KEY) — the "${label}" key can't be derived`,
    );
  }
  const key = Buffer.from(
    hkdfSync("sha256", Buffer.from(material, "utf8"), Buffer.alloc(0), label, 32),
  );
  cache.set(label, key);
  return key;
}

/**
 * A key that must never change once data is keyed with it — the suppression
 * list, which has to keep matching an unsubscribe or erasure for ever
 * (rule 23). HKDF over CONNECTOR_KEY only: derivedKey() prefers COOKIE_SECRET,
 * so setting that "optional" variable later would have changed every keyed
 * suppression and let unsubscribed or erased addresses back in. CONNECTOR_KEY
 * can't rotate without re-encrypting every connection secret, so it is the
 * stable root. With COOKIE_SECRET unset (the deployed default) this is
 * byte-for-byte the key derivedKey() gives, so nothing already stored moves.
 */
const stableCache = new Map<string, Buffer>();

export function stableKey(label: string): Buffer {
  const hit = stableCache.get(label);
  if (hit) return hit;
  const material = process.env.CONNECTOR_KEY;
  if (!material) {
    throw new Error(`Missing CONNECTOR_KEY — the "${label}" key can't be derived`);
  }
  const key = Buffer.from(
    hkdfSync("sha256", Buffer.from(material, "utf8"), Buffer.alloc(0), label, 32),
  );
  stableCache.set(label, key);
  return key;
}

/**
 * The key rows may carry from a time COOKIE_SECRET was set and derivedKey()
 * keyed them with it; null when COOKIE_SECRET is unset or equals
 * CONNECTOR_KEY. Matching only — nothing new is ever written with it.
 */
export function cookieEraKey(label: string): Buffer | null {
  const cookie = process.env.COOKIE_SECRET;
  if (!cookie || cookie === process.env.CONNECTOR_KEY) return null;
  return Buffer.from(hkdfSync("sha256", Buffer.from(cookie, "utf8"), Buffer.alloc(0), label, 32));
}
