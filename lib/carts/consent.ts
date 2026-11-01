// A shopper's yes at checkout, recorded — I-47a (owner, 2026-10-30: "go
// ahead with I-47a too").
//
// Shopify keeps, per customer, whether they're subscribed to email
// marketing (defaultEmailAddress.marketingState). That is their CURRENT
// setting in Shopify: the shopper may have set it at a checkout, or the
// shop, or an import. The source says so, and names the opt-in level when
// Shopify gives it. Read with the optional read_customers (I-47b), a cart's
// shopper comes with that setting. This turns it into a contact under
// rule 19, consent as a recorded fact:
//
//   · A shopper Shopify lists as SUBSCRIBED, who isn't among the contacts
//     and whose address isn't suppressed, becomes a contact with
//     explicit_consent. The source names the Shopify checkout read and the
//     date, and the captured time is Shopify's own marketingUpdatedAt
//     (else the checkout's last update). The address is kept on the
//     contact, the one place PII lives, and is erasable there (rule 22).
//     PENDING (a double opt-in not yet confirmed) is not a yes.
//   · A contact SYB made this way follows Shopify after that. If Shopify
//     stops listing them as subscribed, the contact moves to no_consent, so
//     they aren't emailed. If they subscribe again (with Shopify's time for
//     it, later than the one recorded), they move back. Carts are read for
//     60 days only, so each sync also re-checks those contacts whose cart
//     the read didn't see (Provider.readMarketingStates, review
//     2026-11-01): an unsubscribe in Shopify is seen however long ago the
//     cart was.
//   · A contact the owner recorded or imported (I-47c, owner 2026-10-30:
//     "go ahead with I-47c too"). Their yes gives way only to a later
//     opt-out: Shopify says UNSUBSCRIBED, with Shopify's own time for it
//     after the yes was recorded (never the checkout's time). The contact
//     moves to no_consent with that named as the source, and is Shopify's
//     to follow from then on. "Never subscribed" in Shopify isn't an
//     opt-out, so it changes nothing. An owner's no, unsure or implied is
//     never raised by Shopify's yes. That is counted and left as recorded.
//   · A suppressed address (unsubscribed from SYB's own email, or erased)
//     is never added or changed, whatever Shopify says.
//
// Counts only leave this module, never an address.

import { and, count, eq, inArray, like, notInArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db";
import { db } from "../../db";
import { contactSuppressions, contacts } from "../../db/schema";
import type { ExternalCart, MarketingState } from "../connectors/provider";
import { emailHashCandidates, normalizeEmail } from "../crm/contacts";

/** The start of every consent source this module writes: what marks a contact as Shopify's to follow. */
export const SHOPIFY_CHECKOUT_SOURCE = "Shopify checkout";

const CHUNK = 500;
/** Contacts made from a Shopify checkout re-checked per sync, at most (review 2026-11-01). */
export const FOLLOW_PER_SYNC = 200;

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

const none = (): CheckoutConsentOutcome => ({ added: 0, followed: 0, withdrawn: 0, differs: 0 });

/** Pure: whether a contact's consent came from a Shopify checkout, so it follows Shopify. */
export function isShopifyConsent(source: string): boolean {
  return source.startsWith(`${SHOPIFY_CHECKOUT_SOURCE} `);
}

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

const OPT_IN_WORDS: Record<string, string> = {
  SINGLE_OPT_IN: "single opt-in",
  CONFIRMED_OPT_IN: "confirmed opt-in",
};

/**
 * Pure: the consent source for a shopper's Shopify setting on a day
 * (YYYY-MM-DD). It says what Shopify lists, not that the shopper ticked
 * a box at this checkout, since the shop or an import can set it too.
 */
export function checkoutSource(
  subscribed: boolean,
  day: string,
  overOwnerYes = false,
  optIn: string | null = null,
): string {
  if (overOwnerYes) {
    return `${SHOPIFY_CHECKOUT_SOURCE} ${day}: unsubscribed from email marketing in Shopify, ${OVER_OWNER_YES}`;
  }
  if (!subscribed) {
    return `${SHOPIFY_CHECKOUT_SOURCE} ${day}: Shopify no longer lists them as subscribed to email marketing`;
  }
  const level = (optIn && OPT_IN_WORDS[optIn]) ?? "how they opted in isn't recorded";
  return `${SHOPIFY_CHECKOUT_SOURCE} ${day}: Shopify lists them as subscribed to email marketing (${level}; their setting in Shopify, which they or the shop can change)`;
}

interface Shopper {
  email: string;
  subscribed: boolean;
  /** Shopify says they opted out (UNSUBSCRIBED), not merely never subscribed. */
  unsubscribed: boolean;
  /** Shopify's own time for the setting; null when it gives none. */
  stated_at: string | null;
  /** The time a new contact is dated by: Shopify's, else the checkout's last update. */
  at: string;
  /** Their first cart; null on a re-check, which never adds anyone. */
  first_seen_at: string | null;
  opt_in: string | null;
}

/**
 * Pure: one entry per address, from the carts that carry a shopper and a
 * setting. Where one address appears on several carts, the latest state
 * wins.
 */
export function shoppersOf(carts: readonly ExternalCart[]): Shopper[] {
  const by = new Map<string, Shopper>();
  for (const c of carts) {
    if (!c.email || c.email.trim() === "" || c.accepts_marketing === null) continue;
    const email = normalizeEmail(c.email);
    const stated = c.marketing_updated_at ?? null;
    const at = stated ?? c.updated_at;
    const seen = by.get(email);
    const first =
      seen?.first_seen_at && Date.parse(seen.first_seen_at) < Date.parse(c.started_at)
        ? seen.first_seen_at
        : c.started_at;
    if (!seen || Date.parse(at) > Date.parse(seen.at)) {
      by.set(email, {
        email,
        subscribed: c.accepts_marketing,
        unsubscribed: c.marketing_state === "UNSUBSCRIBED",
        stated_at: stated,
        at,
        first_seen_at: first,
        opt_in: c.marketing_opt_in_level ?? null,
      });
    } else {
      seen.first_seen_at = first;
    }
  }
  return [...by.values()];
}

/** Pure: re-checked settings as shoppers; an unread or unknown state is left out. */
export function shoppersOfStates(states: readonly MarketingState[], now: Date): Shopper[] {
  return states.flatMap((s) => {
    if (s.state === null) return [];
    return [
      {
        email: normalizeEmail(s.email),
        subscribed: s.state === "SUBSCRIBED",
        unsubscribed: s.state === "UNSUBSCRIBED",
        stated_at: s.updated_at,
        at: s.updated_at ?? now.toISOString(),
        first_seen_at: null,
        opt_in: s.opt_in_level,
      },
    ];
  });
}

/** Record what one read's shoppers said at checkout. Counts only come back. */
export async function recordCheckoutConsent(
  accountId: string,
  carts: readonly ExternalCart[],
  executor: DbOrTx = db,
  now: Date = new Date(),
): Promise<CheckoutConsentOutcome> {
  return applyShoppers(accountId, shoppersOf(carts), executor, now);
}

/**
 * Review 2026-11-01: the contacts made from a Shopify checkout that this
 * read didn't see, to re-check with Shopify, at most `limit`, picked at
 * random so each gets its turn when there are more. A suppressed address
 * is skipped when the result is applied.
 */
export async function followedContactEmails(
  accountId: string,
  seen: readonly string[],
  limit = FOLLOW_PER_SYNC,
  executor: DbOrTx = db,
): Promise<string[]> {
  const conditions = [
    eq(contacts.account_id, accountId),
    like(contacts.consent_source, `${SHOPIFY_CHECKOUT_SOURCE} %`),
    sql`${contacts.email} IS NOT NULL`,
  ];
  if (seen.length > 0) conditions.push(notInArray(contacts.email, [...seen]));
  const rows = await executor
    .select({ email: contacts.email })
    .from(contacts)
    .where(and(...conditions))
    .orderBy(sql`random()`)
    .limit(limit);
  return rows.flatMap((r) => (r.email ? [r.email] : []));
}

/** Apply re-checked Shopify settings to the contacts made from a checkout. Never adds anyone. */
export async function followShopify(
  accountId: string,
  states: readonly MarketingState[],
  executor: DbOrTx = db,
  now: Date = new Date(),
): Promise<CheckoutConsentOutcome> {
  return applyShoppers(accountId, shoppersOfStates(states, now), executor, now);
}

async function applyShoppers(
  accountId: string,
  shoppers: readonly Shopper[],
  executor: DbOrTx,
  now: Date,
): Promise<CheckoutConsentOutcome> {
  const out = none();
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

  const set = (id: string, values: Partial<typeof contacts.$inferInsert>) =>
    executor
      .update(contacts)
      .set(values)
      .where(and(eq(contacts.id, id), eq(contacts.account_id, accountId)));

  for (const s of shoppers) {
    if (forms.get(s.email)!.some((h) => suppressed.has(h))) continue;
    const contact = existing.get(s.email);
    if (!contact) {
      // Only a cart adds someone; a re-check never does.
      if (!s.subscribed || s.first_seen_at === null) continue;
      const added = await executor
        .insert(contacts)
        .values({
          account_id: accountId,
          email: s.email,
          consent_status: "explicit_consent",
          consent_source: checkoutSource(true, s.at.slice(0, 10), false, s.opt_in),
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
    // Shopify's own time, later than the one recorded. Never the checkout's.
    const statedLater =
      s.stated_at !== null && Date.parse(s.stated_at) > Date.parse(contact.consent_captured_at);

    if (!isShopifyConsent(contact.consent_source)) {
      if (s.subscribed) {
        out.differs += 1;
      } else if (s.unsubscribed && statedLater) {
        await set(contact.id, {
          consent_status: "no_consent",
          consent_source: checkoutSource(false, s.stated_at!.slice(0, 10), true),
          consent_captured_at: s.stated_at!,
        });
        out.withdrawn += 1;
      }
      continue;
    }

    if (s.subscribed) {
      // Up again only on Shopify's word with its own, later time.
      if (!statedLater) continue;
      await set(contact.id, {
        consent_status: "explicit_consent",
        consent_source: checkoutSource(true, s.stated_at!.slice(0, 10), false, s.opt_in),
        consent_captured_at: s.stated_at!,
      });
    } else {
      // Down on any newer word. Without Shopify's time, it is dated now: the safe direction.
      if (s.stated_at !== null && !statedLater) continue;
      const when = s.stated_at ?? now.toISOString();
      await set(contact.id, {
        consent_status: "no_consent",
        consent_source: checkoutSource(false, when.slice(0, 10)),
        consent_captured_at: when,
      });
    }
    out.followed += 1;
  }
  return out;
}

/** Pure: two outcomes added up. */
export function addOutcomes(
  a: CheckoutConsentOutcome,
  b: CheckoutConsentOutcome,
): CheckoutConsentOutcome {
  return {
    added: a.added + b.added,
    followed: a.followed + b.followed,
    withdrawn: a.withdrawn + b.withdrawn,
    differs: a.differs + b.differs,
  };
}
