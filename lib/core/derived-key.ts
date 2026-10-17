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
