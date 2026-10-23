// The client key — enough to see that a client came back, never who they are.
//
// A bookings export carries names, emails and phones; Square carries a
// customer id. None of it is stored (rule 22's spirit: PII erasable,
// telemetry PII-free). What is stored is HMAC-SHA256 over the account, the
// kind of identity and its normalised value. Without the key it can't be
// reversed or matched across accounts; with it, the same client yields the
// same key on every import, which is all rebooking needs. Erasing a
// customer (lib/crm/contacts.ts) recomputes the key from their email and
// phone, clears it, and remembers it so a re-import can't put it back
// (lib/bookings/erase.ts).
//
// THE KEY (review 2026-10-23, #11). Its own stable derivation:
//
//     HKDF-SHA256(ikm = CONNECTOR_KEY, salt = empty, info = "bookings-client-v1", 32 bytes)
//
// CONNECTOR_KEY only — never COOKIE_SECRET. The shared derivedKey() helper
// prefers COOKIE_SECRET when set, so setting that "optional" variable later
// would have changed every client key and orphaned the rows imported
// before it: erasure could no longer find them. CONNECTOR_KEY can't rotate
// without re-encrypting every connection secret, so it is the stable root.
// With COOKIE_SECRET unset (the deployed default), this is byte-for-byte
// the key rows were made with, so nothing moves. Where COOKIE_SECRET WAS
// set, rows imported before this change carry the old key: erasure also
// tries that legacy key (clientKeyCandidates), and the next import of the
// same file re-keys them in place (the upsert rewrites client_key).

import { createHmac, hkdfSync } from "node:crypto";
import { env } from "../env";
import type { ClientIdentity } from "./types";

const LABEL = "bookings-client-v1";

let current: Buffer | null = null;

function derive(material: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(material, "utf8"), Buffer.alloc(0), LABEL, 32));
}

/** The bookings client HMAC key: HKDF over CONNECTOR_KEY, label "bookings-client-v1". Never logged. */
function bookingsKey(): Buffer {
  current ??= derive(env.CONNECTOR_KEY);
  return current;
}

/** The key rows imported before 2026-10-23 carry when COOKIE_SECRET was set then; none otherwise. */
function legacyKey(): Buffer | null {
  const cookie = process.env.COOKIE_SECRET;
  return cookie ? derive(cookie) : null;
}

/** The identity in the one spelling every source agrees on, or null when it identifies nobody. */
export function normaliseIdentity(identity: ClientIdentity): string | null {
  const v = identity.value.trim();
  if (v === "") return null;
  switch (identity.kind) {
    case "email": {
      const e = v.toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
    }
    case "phone": {
      const digits = v.replace(/\D/g, "");
      // Fewer than 6 digits is an extension or a typo, not a person.
      return digits.length >= 6 ? digits : null;
    }
    case "id":
      return v.length <= 200 ? v : null;
  }
}

function keyed(key: Buffer, accountId: string, identity: ClientIdentity, scope: string) {
  const value = normaliseIdentity(identity);
  if (value === null) return null;
  const namespace = identity.kind === "id" ? `id:${scope}` : identity.kind;
  return createHmac("sha256", key)
    .update(`${accountId}\u0000${namespace}\u0000${value}`)
    .digest("hex");
}

/**
 * The keyed hash, or null when the identity identifies nobody. `scope`
 * namespaces ids: a Fresha client 42 and a Square customer 42 are not the
 * same person, while an email is the same email in every system.
 */
export function clientKey(
  accountId: string,
  identity: ClientIdentity,
  scope: string,
): string | null {
  return keyed(bookingsKey(), accountId, identity, scope);
}

/** Every key this identity's rows may carry: the current one, and the legacy one if any. */
export function clientKeyCandidates(
  accountId: string,
  identity: ClientIdentity,
  scope: string,
): string[] {
  const legacy = legacyKey();
  const keys = [
    keyed(bookingsKey(), accountId, identity, scope),
    legacy ? keyed(legacy, accountId, identity, scope) : null,
  ];
  return [...new Set(keys.filter((k): k is string => k !== null))];
}
