// Idea 47, I-47.3 — the abandoned-cart segment and its win-back proposal.
//
//   · The segment: carts left 1–7 days ago (UTC days, boundaries both ways),
//     never finished, no later order; matched to contacts by the keyed hash.
//   · The gate: only explicit consent with no suppression is proposed
//     (rule 19), decided per contact every time; everyone else is counted.
//   · The path: the existing customer-email proposal, with the watch, the
//     hard limits and the once-per-day key; a contact at most once in 30 days.
//   · The draft: the products left behind, never the person; the greeting
//     and the AI disclosure put in by code. The model is injected.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  abandonedCheckouts,
  accounts,
  businessProfiles,
  connections,
  contactSuppressions,
  contacts,
  contentItems,
  fieldRecords,
  intakeEvents,
  modeDecisions,
  proposals,
  users,
} from "../../db/schema";
import { shiftDay } from "../anomaly/baseline";
import type { DraftLlm } from "../content/draft";
import type { ContactRow } from "../crm/contacts";
import { addContact } from "../crm/contacts";
import { CART_GREETING, draftCampaign } from "../crm/campaign-draft";
import { proposeFromSegments } from "../crm/segment-proposals";
import { bootstrapIntake } from "../intake/service";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal } from "../proposals/service";
import type { ExternalCart } from "../connectors/provider";
import type { StoredCart } from "./load";
import { loadCartFacts } from "./load";
import { abandonedCartSegment } from "./segment";
import { storeCarts } from "./store";

const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

/* ── pure ── */

const TODAY = "2026-10-29";
let seq = 0;
function stored(daysAgo: number, over: Partial<StoredCart> = {}): StoredCart {
  seq += 1;
  const day = shiftDay(TODAY, -daysAgo);
  return {
    ref: `c${seq}`,
    day,
    started_at: `${day}T10:00:00.000Z`,
    completed: false,
    total_minor: 5_000,
    currency: "EUR",
    lines: [{ product_ref: "P/mug", title: "Mug", quantity: 1, unit_price_minor: 3_400 }],
    lines_truncated: false,
    shopper: `h:${seq}`,
    reach: "emailable",
    connection_id: "conn",
    provider: "shopify",
    contact_id: `k${seq}`,
    ...over,
  };
}

const contactOf = (id: string, over: Partial<ContactRow> = {}): ContactRow =>
  ({ id, account_id: "a", email: "x", last_purchase_at: null, ...over }) as ContactRow;

describe("the segment, pure", () => {
  it("takes carts left 1 to 7 days ago, not today's and not the 8th day's", () => {
    const carts = [0, 1, 7, 8].map((d) => stored(d));
    const seg = abandonedCartSegment({ today: TODAY, carts, contacts: new Map() }, new Set());
    expect(seg.emailable_ids).toEqual([carts[1]!.contact_id, carts[2]!.contact_id].sort());
  });

  it("leaves out a finished cart, a later finished cart of theirs, and a purchase on record since", () => {
    const finished = stored(2, { completed: true });
    const later = stored(3, { shopper: "h:same", contact_id: "k:same" });
    const laterDone = stored(2, {
      shopper: "h:same",
      contact_id: "k:same",
      completed: true,
      started_at: `${shiftDay(TODAY, -2)}T12:00:00.000Z`,
    });
    const bought = stored(4, { contact_id: "k:bought" });
    const kept = stored(5);
    const seg = abandonedCartSegment(
      {
        today: TODAY,
        carts: [finished, later, laterDone, bought, kept],
        contacts: new Map([
          ["k:bought", contactOf("k:bought", { last_purchase_at: `${TODAY}T08:00:00.000Z` })],
        ]),
      },
      new Set(),
    );
    expect(seg.contact_ids).toEqual([kept.contact_id]);
  });

  it("counts who can't be emailed in words, and names products from the emailable carts only", () => {
    const yes = stored(1, {
      lines: [{ product_ref: "P/bowl", title: "Bowl", quantity: 1, unit_price_minor: 8_900 }],
    });
    const carts = [
      yes,
      stored(2, { reach: "no_consent" }),
      stored(3, { reach: "suppressed" }),
      stored(4, { reach: "not_contact", contact_id: null }),
      stored(5, { reach: "no_email", contact_id: null, shopper: null }),
      stored(6, { reach: "emailable", contact_id: "k:recent" }),
    ];
    const seg = abandonedCartSegment(
      { today: TODAY, carts, contacts: new Map() },
      new Set(["k:recent"]),
    );
    expect(seg.emailable_ids).toEqual([yes.contact_id]);
    expect(seg.excluded).toEqual({ no_email: 0, no_consent: 1, suppressed: 1 });
    expect(seg.recently_proposed).toBe(1);
    expect(seg.unmatched_carts).toBe(2);
    expect(seg.products).toEqual([{ ref: "P/bowl", provider: "shopify", title: "Bowl", carts: 1 }]);
    expect(seg.evidence.join(" ")).toMatch(
      /2 carts of the same days are from shoppers who aren't your contacts or left no address I can read, so they aren't emailed/,
    );
  });
});

/* ── through the proposal path, against the database ── */

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  await db.delete(abandonedCheckouts).where(inArray(abandonedCheckouts.account_id, accountIds));
  await db.delete(connections).where(inArray(connections.account_id, accountIds));
  await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(contacts).where(inArray(contacts.account_id, accountIds));
  await db.delete(contactSuppressions).where(inArray(contactSuppressions.account_id, accountIds));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

const DAY_MS = 86_400_000;

/**
 * A shop whose carts carry their shoppers' emails, as a store that shares
 * them would (Shopify doesn't to SYB: I-47b). Five carts of the last week.
 */
async function shop(opts: { watching?: boolean } = {}) {
  const s = await bootstrapIntake();
  created.push(s);
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `i47-${crypto.randomUUID()}@test.local`,
      display_name: "Carts owner",
      role: "owner",
    })
    .returning({ id: users.id });
  if (opts.watching) {
    await db.insert(modeDecisions).values({
      profile_id: s.profile_id,
      mode: "watching",
      watch_weeks: 4,
      inputs: {},
      reasoning: "fixture",
      confidence: "0.800",
      review_at: new Date(Date.now() + 28 * DAY_MS).toISOString(),
    });
  }
  const [conn] = await db
    .insert(connections)
    .values({ account_id: s.account_id, provider: "shopify", granted_scopes: ["read_orders"] })
    .returning({ id: connections.id });
  const tag = crypto.randomUUID().slice(0, 8);
  const yes = await addContact(s.account_id, {
    email: `yes-${tag}@example.com`,
    consent: { status: "explicit_consent", source: "checkout box" },
  });
  const unsure = await addContact(s.account_id, {
    email: `unsure-${tag}@example.com`,
    consent: { status: "unsure", source: "old list" },
  });
  const now = new Date();
  const ago = (d: number) => new Date(now.getTime() - d * DAY_MS).toISOString();
  const cart = (email: string | null, days: number): ExternalCart => ({
    ref: `gid://shopify/AbandonedCheckout/${crypto.randomUUID()}`,
    started_at: ago(days),
    updated_at: ago(days),
    completed_at: null,
    total_minor: 8_900,
    currency: "EUR",
    lines: [
      {
        product_ref: "gid://shopify/Product/2",
        title: "Large Serving Bowl",
        quantity: 1,
        unit_price_minor: 8_900,
      },
    ],
    lines_truncated: false,
    email,
    accepts_marketing: true, // Shopify's tick: stored, never consent
  });
  await storeCarts(
    { id: conn!.id, account_id: s.account_id },
    {
      carts: [
        cart(`yes-${tag}@example.com`, 2),
        cart(`unsure-${tag}@example.com`, 3),
        cart(`stranger-${tag}@example.com`, 3), // ticked Shopify's box, but isn't a contact
        cart(null, 4),
        cart(`yes-${tag}@example.com`, 10), // too old for a reminder
      ],
    },
    now,
  );
  return { ...s, user_id: u!.id, yes, unsure, now };
}

describe("the win-back proposal", () => {
  it("proposes only for the consented contact, by id, naming the product and never the person", async () => {
    const b = await shop();
    const out = await proposeFromSegments(b.profile_id, {
      now: b.now,
      limitLlm: noLimits,
      only: "abandoned_cart",
    });
    expect(out.created).toHaveLength(1);
    const p = out.created[0]!;
    expect(p.originating_finding).toBe(`crm:cart:${b.now.toISOString().slice(0, 10)}`);
    const action = p.action as { kind: string; summary: string; detail: Record<string, unknown> };
    expect(action.kind).toBe("customer_email");
    expect(action.summary).toBe("Remind 1 shopper who left a cart this week and said yes to email");
    expect(action.detail.contact_ids).toEqual([b.yes.id]);
    expect(action.detail.in_segment).toBe(2); // the unsure contact is in, not emailable
    expect(action.detail.products).toEqual(["Large Serving Bowl"]);
    expect(action.detail.unmatched_carts).toBe(2);
    expect(JSON.stringify(p)).not.toMatch(/@example\.com|yes-|unsure-|stranger-/);

    // Once a day; and the next day the same contact isn't proposed again (30 days).
    const again = await proposeFromSegments(b.profile_id, {
      now: b.now,
      limitLlm: noLimits,
      only: "abandoned_cart",
    });
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual([
      { segment: "abandoned_cart", reason: "already proposed today" },
    ]);
    const tomorrow = new Date(b.now.getTime() + DAY_MS);
    const next = await proposeFromSegments(b.profile_id, {
      now: tomorrow,
      limitLlm: noLimits,
      only: "abandoned_cart",
    });
    expect(next.created).toEqual([]);
    expect(next.skipped[0]?.reason).toMatch(/already proposed a reminder in the last 30 days/);
  });

  it("the monthly run doesn't propose cart reminders unasked", async () => {
    const b = await shop();
    const out = await proposeFromSegments(b.profile_id, { now: b.now, limitLlm: noLimits });
    const refs = [...out.created, ...out.blocked].map((p) => p.originating_finding);
    expect(refs.some((r) => r?.startsWith("crm:cart:"))).toBe(false);
  });

  it("while watching, nothing is proposed, in the owner's words with a day", async () => {
    const b = await shop({ watching: true });
    const out = await proposeFromSegments(b.profile_id, {
      now: b.now,
      limitLlm: noLimits,
      only: "abandoned_cart",
    });
    expect(out.created).toEqual([]);
    expect(out.skipped[0]?.reason).toMatch(
      /^I'm watching until \d{1,2} [A-Z][a-z]{2}, and I propose nothing before then\.$/,
    );
  });

  it("the facts never carry an address, and Shopify's tick isn't consent", async () => {
    const b = await shop();
    const facts = await loadCartFacts(b.account_id, b.now);
    expect(JSON.stringify(facts.carts)).not.toMatch(/@example\.com/);
    const stranger = facts.carts.filter((c) => c.reach === "not_contact");
    expect(stranger).toHaveLength(1); // ticked the box at checkout; still not emailable
  });

  it("the draft names the products, greets in code, and is disclosed", async () => {
    const b = await shop();
    const out = await proposeFromSegments(b.profile_id, {
      now: b.now,
      limitLlm: noLimits,
      only: "abandoned_cart",
    });
    const p = out.created[0]!;
    await approveProposal({ proposalId: p.id, userId: b.user_id, profileId: b.profile_id });
    let brief = "";
    const llm: DraftLlm = async ({ user }) => {
      brief = user;
      return { text: "Your bowl is still waiting for you, ready to go whenever you are." };
    };
    const { draft } = await draftCampaign(p.id, { draftLlm: llm, limitLlm: noLimits });
    expect(brief).toContain("Large Serving Bowl");
    expect(brief).toMatch(/Never name or describe the person/);
    // Review 2026-10-30: one email for every shopper says "such as", never "they left X".
    expect(brief).toMatch(/items from the shop, such as Large Serving Bowl/);
    expect(brief).toMatch(/never say or imply the reader left all of these/);
    expect(brief).not.toMatch(/they left Large Serving Bowl/);
    expect((p.action as { detail: { what: string } }).detail.what).toMatch(
      /reminding them of items from your shop, such as Large Serving Bowl\.$/,
    );
    expect(brief).not.toMatch(/@example\.com/);
    expect(draft.body.startsWith(`${CART_GREETING}\n\n`)).toBe(true);
    expect(draft.body).toContain("Written with AI assistance.");
    const [row] = await db.select().from(proposals).where(eq(proposals.id, p.id));
    expect(row?.status).toBe("approved");
  });
});
