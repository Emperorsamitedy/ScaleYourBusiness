// The staff key — how a removed person is remembered without their name.
// P6-06 (TASKS-PHASE6.md, rule 28 amended; rule 22).
//
// Removing a person clears their name from every appointment. The usual
// next step is the owner importing an overlapping export, which carries the
// name again; without a memory of the removal it would come straight back.
// What is remembered is HMAC-SHA256 over the account and the normalised
// name, under its own key, exactly as lib/bookings/client-key.ts does for
// clients: it can't be reversed or matched across accounts, and the same
// name yields the same key on every import.
//
// THE KEY: HKDF-SHA256(ikm = CONNECTOR_KEY, salt = empty, info =
// "bookings-staff-v1", 32 bytes). CONNECTOR_KEY only, for the reason
// client-key.ts gives: it can't rotate without re-encrypting every secret,
// so it is the stable root.

import { createHmac, hkdfSync } from "node:crypto";
import { env } from "../env";

const LABEL = "bookings-staff-v1";

let current: Buffer | null = null;

function staffHmacKey(): Buffer {
  current ??= Buffer.from(
    hkdfSync("sha256", Buffer.from(env.CONNECTOR_KEY, "utf8"), Buffer.alloc(0), LABEL, 32),
  );
  return current;
}

/**
 * Pure: the one spelling a person's name is matched by — trimmed, inner
 * spaces collapsed, lower-cased. "Aoife", " aoife " and "AOIFE" are one
 * person; "Aoife B." is another. Null when it names nobody.
 */
export function normaliseStaff(ref: string): string | null {
  const v = ref.trim().replace(/\s+/g, " ").toLowerCase();
  return v === "" ? null : v;
}

/** The keyed hash of a person's name in this account, or null for an empty name. */
export function staffKey(accountId: string, ref: string): string | null {
  const v = normaliseStaff(ref);
  if (v === null) return null;
  return createHmac("sha256", staffHmacKey())
    .update(`${accountId}\u0000staff\u0000${v}`)
    .digest("hex");
}
