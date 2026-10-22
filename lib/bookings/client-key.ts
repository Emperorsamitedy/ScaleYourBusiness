// The client key — enough to see that a client came back, never who they are.
//
// A bookings export carries names, emails and phones; Square carries a
// customer id. None of it is stored (rule 22's spirit: PII erasable,
// telemetry PII-free). What is stored is HMAC-SHA256 under a key derived
// from the server secret for this one purpose, over the account, the kind
// of identity and its normalised value. Without the secret it can't be
// reversed or matched across accounts; with it, the same client yields the
// same key on every import, which is all rebooking needs. Erasing a
// customer (lib/crm/contacts.ts) recomputes the key from their email and
// phone and clears it.

import { createHmac } from "node:crypto";
import { derivedKey } from "../core/derived-key";
import type { ClientIdentity } from "./types";

const LABEL = "bookings-client-v1";

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
  const value = normaliseIdentity(identity);
  if (value === null) return null;
  const namespace = identity.kind === "id" ? `id:${scope}` : identity.kind;
  return createHmac("sha256", derivedKey(LABEL))
    .update(`${accountId}\u0000${namespace}\u0000${value}`)
    .digest("hex");
}
