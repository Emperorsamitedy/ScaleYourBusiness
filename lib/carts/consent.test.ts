// I-47a — a shopper's yes at Shopify's checkout, recorded as consent.
//
// What must hold:
//   · A SUBSCRIBED shopper who isn't a contact becomes one with explicit
//     consent, named to the Shopify checkout and Shopify's own time. Not
//     subscribed, pending or unknown adds no one.
//   · A suppressed address (unsubscribed or erased) is never added.
//   · A contact SYB made from a checkout follows Shopify both ways.
//   · A contact the owner recorded (I-47c): a yes gives way only to a
//     later UNSUBSCRIBED in Shopify; a no is never raised, only counted.
//   · The gate (canEmailForMarketing) agrees with what was recorded.

import "dotenv/config";

import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  contactSuppressions,
  contacts,
  fieldRecords,
  intakeEvents,
} from "../../db/schema";
import type { ExternalCart } from "../connectors/provider";
import { addContact, canEmailForMarketing, emailHash } from "../crm/contacts";
import { bootstrapIntake } from "../intake/service";
import {
  SHOPIFY_CHECKOUT_SOURCE,
  checkoutSource,
  followShopify,
  followedContactEmails,
  isShopifyConsent,
  recordCheckoutConsent,
  shoppersOf,
} from "./consent";

const created: { account_id: string; profile_id: string }[] = [];
afterAll(async () => {
  const accountIds = created.map((s) => s.account_id);
  const ids = created.map((s) => s.profile_id);
  if (accountIds.length === 0) return;
  await db.delete(contacts).where(inArray(contacts.account_id, accountIds));
  await db.delete(contactSuppressions).where(inArray(contactSuppressions.account_id, accountIds));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

async function account() {
  const s = await bootstrapIntake();
  created.push(s);
  return s.account_id;
}

const cart = (over: Partial<ExternalCart>): ExternalCart => ({
  ref: `gid://shopify/AbandonedCheckout/${crypto.randomUUID()}`,
  started_at: "2026-10-27T10:00:00.000Z",
  updated_at: "2026-10-27T10:05:00.000Z",
  completed_at: null,
  total_minor: 5_000,
  currency: "EUR",
  lines: [],
  lines_truncated: false,
  email: null,
  accepts_marketing: null,
  marketing_updated_at: null,
  marketing_state: null,
  ...over,
});

const contactsOf = (accountId: string) =>
  db.select().from(contacts).where(eq(contacts.account_id, accountId));

describe("the pure parts", () => {
  it("one entry per address; the latest state wins, the first cart dates them", () => {
    const s = shoppersOf([
      cart({
        email: "Ana@Example.com",
        accepts_marketing: false,
        started_at: "2026-10-20T09:00:00.000Z",
        marketing_updated_at: "2026-10-01T00:00:00.000Z",
      }),
      cart({
        email: "ana@example.com",
        accepts_marketing: true,
        marketing_updated_at: "2026-10-26T08:00:00.000Z",
      }),
      cart({ email: "nobody@example.com", accepts_marketing: null }),
      cart({ email: null, accepts_marketing: true }),
    ]);
    expect(s).toEqual([
      {
        email: "ana@example.com",
        subscribed: true,
        unsubscribed: false,
        stated_at: "2026-10-26T08:00:00.000Z",
        at: "2026-10-26T08:00:00.000Z",
        first_seen_at: "2026-10-20T09:00:00.000Z",
        opt_in: null,
      },
    ]);
  });

  // Review 2026-11-01: it says what Shopify lists, not that they ticked a box at this checkout.
  it("names the checkout read, the day and the opt-in level, and knows its own sources", () => {
    expect(checkoutSource(true, "2026-10-26")).toBe(
      "Shopify checkout 2026-10-26: Shopify lists them as subscribed to email marketing (how they opted in isn't recorded; their setting in Shopify, which they or the shop can change)",
    );
    expect(checkoutSource(true, "2026-10-26", false, "CONFIRMED_OPT_IN")).toMatch(
      /\(confirmed opt-in; /,
    );
    expect(checkoutSource(true, "2026-10-26")).not.toMatch(/said yes|ticked/);
    expect(isShopifyConsent(checkoutSource(false, "2026-10-26"))).toBe(true);
    expect(isShopifyConsent("import batch 1: owner attests")).toBe(false);
    expect(isShopifyConsent(SHOPIFY_CHECKOUT_SOURCE)).toBe(false);
  });
});

describe("recording the checkout's yes", () => {
  it("adds a subscribed shopper with explicit consent and Shopify's time; no one else", async () => {
    const id = await account();
    const out = await recordCheckoutConsent(id, [
      cart({
        email: "Yes@Example.com",
        accepts_marketing: true,
        marketing_updated_at: "2026-10-26T08:00:00.000Z",
      }),
      cart({ email: "no@example.com", accepts_marketing: false }),
      cart({ email: "unread@example.com", accepts_marketing: null }),
    ]);
    expect(out).toEqual({ added: 1, followed: 0, withdrawn: 0, differs: 0 });
    const rows = await contactsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: "yes@example.com",
      name: null,
      phone: null,
      consent_status: "explicit_consent",
      consent_source: checkoutSource(true, "2026-10-26"),
    });
    expect(Date.parse(rows[0]!.consent_captured_at)).toBe(Date.parse("2026-10-26T08:00:00.000Z"));
    expect(Date.parse(rows[0]!.first_seen_at)).toBe(Date.parse("2026-10-27T10:00:00.000Z"));
    expect((await canEmailForMarketing(rows[0]!)).allowed).toBe(true);
  });

  it("falls back to the checkout's own last update when Shopify gives no time", async () => {
    const id = await account();
    await recordCheckoutConsent(id, [cart({ email: "a@example.com", accepts_marketing: true })]);
    const [row] = await contactsOf(id);
    expect(Date.parse(row!.consent_captured_at)).toBe(Date.parse("2026-10-27T10:05:00.000Z"));
  });

  it("never adds a suppressed address, whatever Shopify says", async () => {
    const id = await account();
    await db.insert(contactSuppressions).values([
      { account_id: id, email_hash: emailHash("left@example.com"), reason: "unsubscribed" },
      { account_id: id, email_hash: emailHash("gone@example.com"), reason: "erasure" },
    ]);
    const out = await recordCheckoutConsent(id, [
      cart({ email: "left@example.com", accepts_marketing: true }),
      cart({ email: "GONE@example.com", accepts_marketing: true }),
    ]);
    expect(out.added).toBe(0);
    expect(await contactsOf(id)).toHaveLength(0);
  });

  it("a contact made from a checkout follows Shopify both ways, and an older state is no change", async () => {
    const id = await account();
    await recordCheckoutConsent(id, [
      cart({
        email: "flip@example.com",
        accepts_marketing: true,
        marketing_updated_at: "2026-10-20T00:00:00.000Z",
      }),
    ]);
    const off = await recordCheckoutConsent(id, [
      cart({
        email: "flip@example.com",
        accepts_marketing: false,
        marketing_updated_at: "2026-10-25T00:00:00.000Z",
      }),
    ]);
    expect(off).toEqual({ added: 0, followed: 1, withdrawn: 0, differs: 0 });
    let [row] = await contactsOf(id);
    expect(row).toMatchObject({
      consent_status: "no_consent",
      consent_source: checkoutSource(false, "2026-10-25"),
    });
    expect((await canEmailForMarketing(row!)).allowed).toBe(false);

    const stale = await recordCheckoutConsent(id, [
      cart({
        email: "flip@example.com",
        accepts_marketing: true,
        marketing_updated_at: "2026-10-21T00:00:00.000Z",
      }),
    ]);
    expect(stale.followed).toBe(0);

    const on = await recordCheckoutConsent(id, [
      cart({
        email: "flip@example.com",
        accepts_marketing: true,
        marketing_updated_at: "2026-10-28T00:00:00.000Z",
      }),
    ]);
    expect(on.followed).toBe(1);
    [row] = await contactsOf(id);
    expect(row!.consent_status).toBe("explicit_consent");
  });

  it("an owner's no is never raised by Shopify's yes; it is counted and left", async () => {
    const id = await account();
    await addContact(id, {
      email: "owner-no@example.com",
      consent: { status: "no_consent", source: "asked not to be emailed" },
    });
    await addContact(id, {
      email: "agree@example.com",
      consent: { status: "explicit_consent", source: "newsletter form" },
    });
    const out = await recordCheckoutConsent(id, [
      cart({
        email: "owner-no@example.com",
        accepts_marketing: true,
        marketing_state: "SUBSCRIBED",
      }),
      cart({ email: "agree@example.com", accepts_marketing: true, marketing_state: "SUBSCRIBED" }),
    ]);
    expect(out).toEqual({ added: 0, followed: 0, withdrawn: 0, differs: 1 });
    const rows = await contactsOf(id);
    expect(rows.find((r) => r.email === "owner-no@example.com")).toMatchObject({
      consent_status: "no_consent",
      consent_source: "asked not to be emailed",
    });
  });

  // I-47c (owner, 2026-10-30): a later opt-out in Shopify ends the owner's yes.
  it("an owner's yes gives way to a later unsubscribe in Shopify, and only to that", async () => {
    const id = await account();
    const yes = (email: string) =>
      addContact(id, {
        email,
        consent: { status: "explicit_consent", source: "signed up in the shop" },
      });
    await yes("later@example.com");
    await yes("earlier@example.com");
    await yes("never@example.com");
    const recordedAt = (await contactsOf(id))[0]!.consent_captured_at;
    const after = new Date(Date.parse(recordedAt) + 60_000).toISOString();
    const before = new Date(Date.parse(recordedAt) - 86_400_000).toISOString();

    const out = await recordCheckoutConsent(id, [
      cart({
        email: "later@example.com",
        accepts_marketing: false,
        marketing_state: "UNSUBSCRIBED",
        marketing_updated_at: after,
      }),
      // An opt-out from before the owner's yes: the yes is newer, it stands.
      cart({
        email: "earlier@example.com",
        accepts_marketing: false,
        marketing_state: "UNSUBSCRIBED",
        marketing_updated_at: before,
      }),
      // Never subscribed in Shopify isn't an opt-out.
      cart({
        email: "never@example.com",
        accepts_marketing: false,
        marketing_state: "NOT_SUBSCRIBED",
        marketing_updated_at: after,
      }),
    ]);
    expect(out).toEqual({ added: 0, followed: 0, withdrawn: 1, differs: 0 });
    const rows = await contactsOf(id);
    const by = (e: string) => rows.find((r) => r.email === e)!;
    expect(by("later@example.com")).toMatchObject({
      consent_status: "no_consent",
      consent_source: checkoutSource(false, after.slice(0, 10), true),
    });
    expect((await canEmailForMarketing(by("later@example.com"))).allowed).toBe(false);
    expect(by("earlier@example.com").consent_status).toBe("explicit_consent");
    expect(by("never@example.com").consent_status).toBe("explicit_consent");

    // From then on the contact is Shopify's to follow: subscribing again brings the yes back.
    const back = await recordCheckoutConsent(id, [
      cart({
        email: "later@example.com",
        accepts_marketing: true,
        marketing_state: "SUBSCRIBED",
        marketing_updated_at: new Date(Date.parse(after) + 60_000).toISOString(),
      }),
    ]);
    expect(back.followed).toBe(1);
    expect(
      (await contactsOf(id)).find((r) => r.email === "later@example.com")!.consent_status,
    ).toBe("explicit_consent");
  });

  it("a read with no shopper does nothing", async () => {
    const id = await account();
    expect(await recordCheckoutConsent(id, [cart({})])).toEqual({
      added: 0,
      followed: 0,
      withdrawn: 0,
      differs: 0,
    });
  });
});

// Review 2026-11-01, finding 4: an owner's yes ends only on Shopify's own, later time.
describe("an owner's yes needs Shopify's own time to end", () => {
  it("an UNSUBSCRIBED with no time of Shopify's, on a checkout touched later, changes nothing", async () => {
    const id = await account();
    await addContact(id, {
      email: "kept@example.com",
      consent: { status: "explicit_consent", source: "signed up in the shop" },
    });
    const out = await recordCheckoutConsent(id, [
      cart({
        email: "kept@example.com",
        accepts_marketing: false,
        marketing_state: "UNSUBSCRIBED",
        marketing_updated_at: null,
        updated_at: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    ]);
    expect(out.withdrawn).toBe(0);
    expect((await contactsOf(id))[0]!.consent_status).toBe("explicit_consent");
  });
});

// Review 2026-11-01, finding 1: a contact made from a checkout keeps following Shopify after its cart ages out.
describe("re-checking the contacts made from a checkout", () => {
  it("lists only contacts made from a checkout, not those this read saw", async () => {
    const id = await account();
    await recordCheckoutConsent(id, [
      cart({ email: "old@example.com", accepts_marketing: true }),
      cart({ email: "fresh@example.com", accepts_marketing: true }),
    ]);
    await addContact(id, {
      email: "owners@example.com",
      consent: { status: "explicit_consent", source: "newsletter form" },
    });
    expect(await followedContactEmails(id, ["fresh@example.com"])).toEqual(["old@example.com"]);
    expect((await followedContactEmails(id, [], 1)).length).toBe(1);
  });

  it("an unsubscribe found later moves them to no consent, with or without Shopify's time", async () => {
    const id = await account();
    await recordCheckoutConsent(id, [
      cart({
        email: "a@example.com",
        accepts_marketing: true,
        marketing_updated_at: "2026-08-01T00:00:00.000Z",
      }),
      cart({
        email: "b@example.com",
        accepts_marketing: true,
        marketing_updated_at: "2026-08-01T00:00:00.000Z",
      }),
    ]);
    const now = new Date("2026-11-01T06:00:00.000Z");
    const out = await followShopify(
      id,
      [
        {
          email: "A@example.com",
          state: "UNSUBSCRIBED",
          updated_at: "2026-10-15T00:00:00.000Z",
          opt_in_level: null,
        },
        { email: "b@example.com", state: "NOT_SUBSCRIBED", updated_at: null, opt_in_level: null },
      ],
      undefined,
      now,
    );
    expect(out).toEqual({ added: 0, followed: 2, withdrawn: 0, differs: 0 });
    const rows = await contactsOf(id);
    const by = (e: string) => rows.find((r) => r.email === e)!;
    expect(by("a@example.com").consent_status).toBe("no_consent");
    expect(Date.parse(by("a@example.com").consent_captured_at)).toBe(
      Date.parse("2026-10-15T00:00:00.000Z"),
    );
    expect(by("b@example.com").consent_status).toBe("no_consent");
    expect(Date.parse(by("b@example.com").consent_captured_at)).toBe(now.getTime());
    expect((await canEmailForMarketing(by("a@example.com"))).allowed).toBe(false);
  });

  it("never adds anyone, never touches an owner's contact, and raises only on Shopify's later time", async () => {
    const id = await account();
    await recordCheckoutConsent(id, [
      cart({
        email: "down@example.com",
        accepts_marketing: false,
        marketing_state: "UNSUBSCRIBED",
      }),
    ]);
    await recordCheckoutConsent(id, [
      cart({
        email: "back@example.com",
        accepts_marketing: true,
        marketing_updated_at: "2026-08-01T00:00:00.000Z",
      }),
    ]);
    await followShopify(id, [
      {
        email: "back@example.com",
        state: "UNSUBSCRIBED",
        updated_at: "2026-09-01T00:00:00.000Z",
        opt_in_level: null,
      },
    ]);
    await addContact(id, {
      email: "owner-no@example.com",
      consent: { status: "no_consent", source: "asked not to be emailed" },
    });
    const out = await followShopify(id, [
      {
        email: "stranger@example.com",
        state: "SUBSCRIBED",
        updated_at: "2026-10-01T00:00:00.000Z",
        opt_in_level: null,
      },
      {
        email: "owner-no@example.com",
        state: "SUBSCRIBED",
        updated_at: "2026-10-01T00:00:00.000Z",
        opt_in_level: null,
      },
      // No time of Shopify's: not enough to raise.
      { email: "back@example.com", state: "SUBSCRIBED", updated_at: null, opt_in_level: null },
    ]);
    expect(out).toEqual({ added: 0, followed: 0, withdrawn: 0, differs: 1 });
    const later = await followShopify(id, [
      {
        email: "back@example.com",
        state: "SUBSCRIBED",
        updated_at: "2026-10-20T00:00:00.000Z",
        opt_in_level: "CONFIRMED_OPT_IN",
      },
    ]);
    expect(later.followed).toBe(1);
    const rows = await contactsOf(id);
    expect(rows.find((r) => r.email === "stranger@example.com")).toBeUndefined();
    expect(rows.find((r) => r.email === "owner-no@example.com")!.consent_status).toBe("no_consent");
    const back = rows.find((r) => r.email === "back@example.com")!;
    expect(back.consent_status).toBe("explicit_consent");
    expect(back.consent_source).toMatch(/confirmed opt-in/);
  });
});
