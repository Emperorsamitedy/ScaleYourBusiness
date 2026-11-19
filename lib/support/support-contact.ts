// The support tier's one contact write — Phase 4 Session C (P4-09, P4-11).
//
// A stranger who emails the inbox, or leaves an address in the chat so a
// person can answer, becomes a contact. Rule 19 decides how:
//   · an unknown address lands with consent "unsure" and provenance that
//     says what happened — a support request is not marketing consent;
//   · an existing contact's consent is NEVER changed by writing in;
//   · a suppressed address (unsubscribed or erased) is not recreated: the
//     suppression outranks the email, and the caller is told so.
//
// Rule 21 keeps lib/crm out of the stranger tier's import graph, so this
// is a narrow insert written directly against the database rather than a
// call to lib/crm/contacts.addContact. The suppression hash is derived
// the same way lib/crm does it (HKDF over the server secret, label
// "syb-suppression-v1", then HMAC); a test pins the two to each other,
// and every check also matches the legacy plain sha256 form.

import { createHash, createHmac, hkdfSync } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { contactSuppressions, contacts } from "../../db/schema";

let suppressionKey: Buffer | null = null;

// CONNECTOR_KEY only, as lib/core/derived-key's stableKey (rule 21 keeps
// this tier off that import): a suppression must match for ever, and
// COOKIE_SECRET may be set later. While it is unset the two are identical.
function key(): Buffer {
  if (!suppressionKey) {
    const material = process.env.CONNECTOR_KEY || "";
    if (material === "") {
      throw new Error('Missing CONNECTOR_KEY — the "syb-suppression-v1" key can\'t be derived');
    }
    suppressionKey = Buffer.from(
      hkdfSync("sha256", Buffer.from(material, "utf8"), Buffer.alloc(0), "syb-suppression-v1", 32),
    );
  }
  return suppressionKey;
}

/** The form a suppression written while COOKIE_SECRET was set carries; null otherwise. Matching only. */
function cookieEraHash(email: string): string | null {
  const cookie = process.env.COOKIE_SECRET;
  if (!cookie || cookie === process.env.CONNECTOR_KEY) return null;
  const k = Buffer.from(
    hkdfSync("sha256", Buffer.from(cookie, "utf8"), Buffer.alloc(0), "syb-suppression-v1", 32),
  );
  return `h1:${createHmac("sha256", k).update(normaliseAddress(email)).digest("hex")}`;
}

export function normaliseAddress(email: string): string {
  return email.trim().toLowerCase();
}

/** The keyed form the suppression list stores ("h1:…") — identical to lib/crm's emailHash. */
export function suppressionHash(email: string): string {
  return `h1:${createHmac("sha256", key()).update(normaliseAddress(email)).digest("hex")}`;
}

function legacyHash(email: string): string {
  return createHash("sha256").update(normaliseAddress(email)).digest("hex");
}

/** The suppression reason for this address on this account, or null. */
export async function suppressionFor(accountId: string, email: string): Promise<string | null> {
  const [row] = await db
    .select({ reason: contactSuppressions.reason })
    .from(contactSuppressions)
    .where(
      and(
        eq(contactSuppressions.account_id, accountId),
        inArray(
          contactSuppressions.email_hash,
          [suppressionHash(email), cookieEraHash(email), legacyHash(email)].filter(
            (h): h is string => h !== null,
          ),
        ),
      ),
    );
  return row?.reason ?? null;
}

export type SupportContactOutcome =
  | { kind: "existing"; contact_id: string }
  | { kind: "created"; contact_id: string }
  | { kind: "suppressed"; reason: string }
  /**
   * Review 2026-10-23 (#18): the address belongs to an existing contact,
   * but the sender couldn't be verified, so the ticket is NOT tied to them
   * — a forged From must not put a real customer's name on a stranger's
   * ticket. The contact row is not touched either.
   */
  | { kind: "unlinked" };

/** The database, or a transaction on it — the contact write can join the caller's. */
export type SupportExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type SupportTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Review 2026-10-23 (#19): one per-account lock, held to the end of the
 * caller's transaction, that serialises support writes carrying a
 * customer's address (an inbound email's filing, a chat address) against
 * a contact's erasure (lib/crm/contacts.ts takes the same lock). Whoever
 * waits reads after the other committed: the erasure sees the new ticket
 * and takes it, or the filing sees the new suppression and honours it.
 */
export async function lockSupportWrites(tx: SupportTx, accountId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`support-writes:${accountId}`}))`);
}

/**
 * The contact behind a support address: found, created as "unsure", or
 * refused because the address is suppressed. Found contacts get their
 * last activity stamped and nothing else — consent is untouched. With
 * `linkExisting` false (an unverified sender), an existing contact is
 * never returned: the address is treated as one we don't know.
 */
export async function contactForSupport(
  args: {
    accountId: string;
    email: string;
    name: string | null;
    /** Provenance in words, e.g. "emailed support 2026-10-19 — a support request is not marketing consent". */
    source: string;
    at: string;
    /** False when the sender is unverified: never tie the ticket to a contact that already exists. */
    linkExisting: boolean;
  },
  q: SupportExecutor = db,
): Promise<SupportContactOutcome> {
  const email = normaliseAddress(args.email);
  const find = async () => {
    const [row] = await q
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.account_id, args.accountId), eq(contacts.email, email)));
    return row ?? null;
  };
  const existing = await find();
  if (existing && !args.linkExisting) {
    const suppressed = await suppressionFor(args.accountId, email);
    return suppressed ? { kind: "suppressed", reason: suppressed } : { kind: "unlinked" };
  }
  if (existing) {
    await q.update(contacts).set({ last_activity_at: args.at }).where(eq(contacts.id, existing.id));
    return { kind: "existing", contact_id: existing.id };
  }
  const suppressed = await suppressionFor(args.accountId, email);
  if (suppressed) return { kind: "suppressed", reason: suppressed };
  const [row] = await q
    .insert(contacts)
    .values({
      account_id: args.accountId,
      email,
      name: args.name?.trim() || null,
      consent_status: "unsure",
      consent_source: args.source,
      consent_captured_at: args.at,
      first_seen_at: args.at,
      last_activity_at: args.at,
    })
    .onConflictDoNothing()
    .returning({ id: contacts.id });
  if (row) return { kind: "created", contact_id: row.id };
  // Another delivery created it a moment ago: use theirs, consent untouched
  // (an unverified sender still doesn't get tied to it).
  const raced = await find();
  if (!raced) throw new Error("the support contact could not be recorded");
  if (!args.linkExisting) return { kind: "unlinked" };
  return { kind: "existing", contact_id: raced.id };
}

/** Provenance for an emailed-in contact. */
export function emailedSource(at: string): string {
  return `emailed support ${at.slice(0, 10)}: a support request is not marketing consent`;
}

/** Provenance for an address given in the website chat. */
export function chatAddressSource(at: string): string {
  return `gave this address in the website chat ${at.slice(0, 10)} so a person could reply: used only to answer that question, not marketing consent`;
}
