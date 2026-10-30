// A shopper's yes at checkout, recorded — I-47a (owner, 2026-10-30: "go
// ahead with I-47a too").
//
// Shopify keeps, per customer, whether they ticked "email me with news and
// offers" (defaultEmailAddress.marketingState). Read with the optional
// read_customers (I-47b), a cart's shopper comes with that tick. This turns
// the tick into a contact under rule 19, consent as a recorded fact:
//
//   · A shopper Shopify lists as SUBSCRIBED, who isn't among the contacts
//     and whose address isn't suppressed, becomes a contact with
//     explicit_consent. The source names the Shopify checkout and the
//     date, and the captured time is Shopify's own marketingUpdatedAt
//     (else the checkout's last update). The address is kept on the
//     contact, the one place PII lives, and is erasable there (rule 22).
//     PENDING (a double opt-in not yet confirmed) is not a yes.
//   · A contact SYB made from a Shopify checkout follows Shopify after
//     that. If Shopify stops listing them as subscribed, the contact moves
//     to no_consent, so they aren't emailed. If they subscribe again, they
//     move back.
//   · A contact the owner recorded or imported (I-47c, owner 2026-10-30:
//     "go ahead with I-47c too"). Their yes gives way only to a later
//     opt-out: if Shopify says the shopper UNSUBSCRIBED, and Shopify's time
//     for it is after the yes was recorded, the contact moves to
//     no_consent with that named as the source, and is Shopify's to follow
//     from then on. "Never subscribed" in Shopify isn't an opt-out, so it
//     changes nothing. An owner's no, unsure or implied is never raised by
//     Shopify's yes. That is counted and left as recorded.
//   · A suppressed address (unsubscribed from SYB's own email, or erased)
//     is never added or changed, whatever Shopify says.
//
// Counts only leave this module, never an address.

import { and, count, eq, inArray, like } from "drizzle-orm";
import type { DbOrTx } from "../../db";
import { db } from "../../db";
import { contactSuppressions, contacts } from "../../db/schema";
import type { ExternalCart } from "../connectors/provider";
import { emailHashCandidates, normalizeEmail } from "../crm/contacts";

/** The start of every consent source this module writes: what marks a contact as Shopify's to follow. */
export const SHOPIFY_CHECKOUT_SOURCE = "Shopify checkout";

const CHUNK = 500;

export interface CheckoutConsentOutcome {
  /** Shoppers who said yes, added as contacts with that consent. */
  added: number;
  /** Contacts made from a Shopify checkout whose consent followed Shopify's change. */
  followed: number;
  /** Contacts the owner recorded as a yes who later unsubscribed in Shopify: now no_consent (I-47c). */
  withdrawn: number;
  /** Contacts the owner recorded as not a yes whom Shopify lists as subscribed: left as recorded. */
  differs: number;
}

/** Pure: whether a contact's consent came from a Shopify checkout, so it follows Shopify. */
export function isShopifyConsent(source: string): boolean {
  return source.startsWith(`${SHOPIFY_CHECKOUT_SOURCE} `);
}

/** Pure: the consent source for a shopper's state at a date (YYYY-MM-DD). */
const OVER_OWNER_YES = "after the yes you recorded";

/** For /carts: how many contacts said yes at Shopify's checkout, and how many owner yeses an opt-out ended. */
export async function checkoutConsentCounts(
  accountId: string,
): Promise<{ said_yes: number; withdrawn: number }> {
  const n = async (status: "explicit_consent" | "no_consent", pattern: string) =>
    (
      await db
        .select({ n: count() })
        .from(contacts)
        .where(
          and(
            eq(contacts.account_id, accountId),
            eq(contacts.consent_status, status),
            like(contacts.consent_source, pattern),
          ),
        )
    )[0]?.n ?? 0;
  return {
    said_yes: await n("explicit_consent", `${SHOPIFY_CHECKOUT_SOURCE} %`),
    withdrawn: await n("no_consent", `${SHOPIFY_CHECKOUT_SOURCE} %${OVER_OWNER_YES}`),
  };
}

export function checkoutSource(subscribed: boolean, day: string, overOwnerYes = false): string {
  if (overOwnerYes) {
    return `${SHOPIFY_CHECKOUT_SOURCE} ${day}: unsubscribed from email marketing in Shopify, ${OVER_OWNER_YES}`;
  }
  return subscribed
    ? `${SHOPIFY_CHECKOUT_SOURCE} ${day}: said yes to email marketing (Shopify lists them as subscribed)`
    : `${SHOPIFY_CHECKOUT_SOURCE} ${day}: Shopify no longer lists them as subscribed to email marketing`;
}

interface Shopper {
  email: string;
  subscribed: boolean;
  /** Shopify says they opted out (UNSUBSCRIBED), not merely never subscribed. */
  unsubscribed: boolean;
  /** When the shopper's state was last set, as Shopify says, else the checkout's last update. */
  at: string;
  first_seen_at: string;
}

/**
 * Pure: one entry per address, from the carts that carry a shopper and a
 * tick. Where one address appears on several carts, the latest state wins.
 */
export function shoppersOf(carts: readonly ExternalCart[]): Shopper[] {
  const by = new Map<string, Shopper>();
  for (const c of carts) {
    if (!c.email || c.email.trim() === "" || c.accepts_marketing === null) continue;
    const email = normalizeEmail(c.email);
    const at = c.marketing_updated_at ?? c.updated_at;
    const seen = by.get(email);
    const first_seen_at =
      seen && Date.parse(seen.first_seen_at) < Date.parse(c.started_at)
        ? seen.first_seen_at
        : c.started_at;
    if (!seen || Date.parse(at) > Date.parse(seen.at)) {
      by.set(email, {
        email,
        subscribed: c.accepts_marketing,
        unsubscribed: c.marketing_state === "UNSUBSCRIBED",
        at,
        first_seen_at,
      });
    } else {
      seen.first_seen_at = first_seen_at;
    }
  }
  return [...by.values()];
}

/** Record what one read's shoppers said at checkout. Counts only come back. */
export async function recordCheckoutConsent(
  accountId: string,
  carts: readonly ExternalCart[],
  executor: DbOrTx = db,
): Promise<CheckoutConsentOutcome> {
  const out: CheckoutConsentOutcome = { added: 0, followed: 0, withdrawn: 0, differs: 0 };
  const shoppers = shoppersOf(carts);
  if (shoppers.length === 0) return out;

  const suppressed = new Set<string>();
  const forms = new Map(shoppers.map((s) => [s.email, emailHashCandidates(s.email)]));
  const allHashes = [...new Set([...forms.values()].flat())];
  for (let i = 0; i < allHashes.length; i += CHUNK) {
    const rows = await executor
      .select({ hash: contactSuppressions.email_hash })
      .from(contactSuppressions)
      .where(
        and(
          eq(contactSuppressions.account_id, accountId),
          inArray(contactSuppressions.email_hash, allHashes.slice(i, i + CHUNK)),
        ),
      );
    for (const r of rows) suppressed.add(r.hash);
  }

  const existing = new Map<string, typeof contacts.$inferSelect>();
  const emails = shoppers.map((s) => s.email);
  for (let i = 0; i < emails.length; i += CHUNK) {
    const rows = await executor
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.account_id, accountId),
          inArray(contacts.email, emails.slice(i, i + CHUNK)),
        ),
      );
    for (const r of rows) if (r.email) existing.set(r.email, r);
  }

  for (const s of shoppers) {
    if (forms.get(s.email)!.some((h) => suppressed.has(h))) continue;
    const contact = existing.get(s.email);
    const day = s.at.slice(0, 10);
    if (!contact) {
      if (!s.subscribed) continue;
      const added = await executor
        .insert(contacts)
        .values({
          account_id: accountId,
          email: s.email,
          consent_status: "explicit_consent",
          consent_source: checkoutSource(true, day),
          consent_captured_at: s.at,
          first_seen_at: s.first_seen_at,
        })
        .onConflictDoNothing()
        .returning({ id: contacts.id });
      // A contact made a moment ago by another path is theirs: left as it is.
      out.added += added.length;
      continue;
    }
    const isYes = contact.consent_status === "explicit_consent";
    if (isYes === s.subscribed) continue;
    // A state older than the one recorded is not a change.
    const later = Date.parse(s.at) > Date.parse(contact.consent_captured_at);
    if (!isShopifyConsent(contact.consent_source)) {
      if (s.subscribed) {
        out.differs += 1;
      } else if (s.unsubscribed && later) {
        await executor
          .update(contacts)
          .set({
            consent_status: "no_consent",
            consent_source: checkoutSource(false, day, true),
            consent_captured_at: s.at,
          })
          .where(and(eq(contacts.id, contact.id), eq(contacts.account_id, accountId)));
        out.withdrawn += 1;
      }
      continue;
    }
    if (!later) continue;
    await executor
      .update(contacts)
      .set({
        consent_status: s.subscribed ? "explicit_consent" : "no_consent",
        consent_source: checkoutSource(s.subscribed, day),
        consent_captured_at: s.at,
      })
      .where(and(eq(contacts.id, contact.id), eq(contacts.account_id, accountId)));
    out.followed += 1;
  }
  return out;
}
