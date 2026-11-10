// The price book — the multi-market spec Part B's tests:
//   · editing a price_book row leaves every existing subscription price unchanged
//   · enabling a price book without the §11.4 quotas fails a startup check
// plus resolution, the billing/VAT mismatch rule, and the reviewed change.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  intakeEvents,
  priceBook,
  priceBookChanges,
  subscriptions,
  usageQuotas,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import {
  PriceBookError,
  enablePriceBook,
  lockSubscription,
  priceBookStartupCheck,
  quotasConfirmed,
  resolvePrice,
  revisePrice,
} from "./price-book";
import { QUOTA_METRICS, quotaState } from "./usage";

const created: { account_id: string; profile_id: string }[] = [];
// A user-assigned code (never a real country), with its own rows for the suite.
const QX = "QX";
const added: string[] = [];

beforeAll(async () => {
  // The suite's own country starts clean each run (its changelog rows stay).
  await db.delete(priceBook).where(eq(priceBook.country, QX));
  const rows = await db
    .insert(priceBook)
    .values([
      {
        tier: "act",
        country: QX,
        currency: "HUF",
        list_amount_minor: 3_500_000,
        ppp_index: "0.52",
        effective_from: "2026-01-01",
        enabled: true,
      },
      {
        tier: "watch",
        country: QX,
        currency: "HUF",
        list_amount_minor: 1_150_000,
        ppp_index: "0.52",
        effective_from: "2026-01-01",
        enabled: false,
      },
    ])
    .returning({ id: priceBook.id });
  added.push(...rows.map((r) => r.id));
});

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length) await db.delete(subscriptions).where(inArray(subscriptions.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
  // price_book rows stay: their changelog is append-only and names them.
  await db.update(priceBook).set({ enabled: false }).where(eq(priceBook.country, QX));
});

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  return s.profile_id;
}

describe("§B.1 — prices are data", () => {
  it("resolves a country's own enabled row, else the default row", async () => {
    expect(await resolvePrice("act", QX, "2026-11-10")).toMatchObject({
      currency: "HUF",
      list_amount_minor: 3_500_000,
    });
    // QX's Watch row is off, so the default prices it.
    expect(await resolvePrice("watch", QX, "2026-11-10")).toMatchObject({
      country: "*",
      currency: "EUR",
      list_amount_minor: 4_900,
    });
  });

  it("Hungary's rows are seeded, rounded to 500 Ft, and off", async () => {
    const hu = await db.select().from(priceBook).where(eq(priceBook.country, "HU"));
    const byTier = new Map(hu.map((r) => [r.tier, r]));
    expect(byTier.get("watch")).toMatchObject({
      list_amount_minor: 1_150_000,
      currency: "HUF",
      ppp_index: "0.52",
      enabled: false,
    });
    expect(byTier.get("act")?.list_amount_minor).toBe(3_500_000);
    expect(byTier.get("autonomous")?.list_amount_minor).toBe(6_900_000);
    expect(byTier.get("extra_business")?.list_amount_minor).toBe(700_000);
    expect(byTier.get("full_diagnosis")?.list_amount_minor).toBe(1_150_000);
    for (const r of hu) expect(r.list_amount_minor % 50_000, r.tier).toBe(0);
  });
});

describe("§B.3 — the price locks at signup, for life", () => {
  it("editing a price_book row leaves every existing subscription price unchanged", async () => {
    const sub = await lockSubscription({
      profileId: await business(),
      tier: "act",
      billingCountry: QX,
      vatCountry: QX,
    });
    expect(sub).toMatchObject({
      currency: "HUF",
      price_amount_minor: 3_500_000,
      needs_review: false,
    });

    const next = await revisePrice({
      tier: "act",
      country: QX,
      amountMinor: 3_812_345,
      pppIndex: "0.55",
      effectiveFrom: "2026-11-11",
      reviewedBy: "Owner",
      reason: "annual PPP review",
    });
    expect(next.list_amount_minor).toBe(3_800_000); // rounded to 500 Ft
    added.push(next.id);
    const [still] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id));
    expect(still?.price_amount_minor).toBe(3_500_000);

    // And the database refuses to change a locked price, even by hand.
    const error = await db
      .update(subscriptions)
      .set({ price_amount_minor: 1 })
      .where(eq(subscriptions.id, sub.id))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(String((error as { cause?: { message?: string } })?.cause?.message)).toMatch(
      /locked at signup/,
    );
  });

  it("a billing/VAT country mismatch is flagged and never gets the cheaper rate", async () => {
    const sub = await lockSubscription({
      profileId: await business(),
      tier: "act",
      billingCountry: QX,
      vatCountry: "DE",
    });
    expect(sub.needs_review).toBe(true);
    // DE falls to the default row (PPP 1.00), dearer than QX's 0.52/0.55: the default prices it.
    expect(sub).toMatchObject({ currency: "EUR", price_amount_minor: 14_900 });
  });

  it("a price row's amount can't be edited — a change is a new row with a changelog entry", async () => {
    const error = await db
      .update(priceBook)
      .set({ list_amount_minor: 1 })
      .where(eq(priceBook.id, added[0]!))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(String((error as { cause?: { message?: string } })?.cause?.message)).toMatch(
      /never changes/,
    );
    const log = await db
      .select()
      .from(priceBookChanges)
      .where(inArray(priceBookChanges.price_book_id, added));
    expect(log.some((l) => l.reviewed_by === "Owner" && l.reason === "annual PPP review")).toBe(
      true,
    );
  });

  it("refuses an unreviewed change", async () => {
    await expect(
      revisePrice({
        tier: "act",
        country: QX,
        amountMinor: 1,
        pppIndex: "0.5",
        effectiveFrom: "2027-01-01",
        reviewedBy: " ",
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(PriceBookError);
  });
});

describe("§B.4 — no country's prices go live without the quotas", () => {
  it("the seeded quotas are placeholders, unconfirmed, soft at 80 % of hard", async () => {
    const rows = await db.select().from(usageQuotas);
    expect(rows).toHaveLength(9);
    expect(await quotasConfirmed()).toBe(false);
    for (const r of rows) expect(r.monthly_soft).toBe(Math.floor((r.monthly_hard * 8) / 10));
    expect(new Set(rows.map((r) => r.metric))).toEqual(new Set(QUOTA_METRICS));
  });

  it("enabling a price book refuses while any quota is unconfirmed", async () => {
    await expect(enablePriceBook(QX, "Owner")).rejects.toThrow(/quotas must be confirmed/);
    const [watch] = await db
      .select()
      .from(priceBook)
      .where(and(eq(priceBook.country, QX), eq(priceBook.tier, "watch")));
    expect(watch?.enabled).toBe(false);
  });

  it("the startup check fails while a country's prices are on and the quotas aren't confirmed", async () => {
    // QX's Act row is enabled (seeded above) and the quotas are unconfirmed.
    expect(await priceBookStartupCheck()).toMatch(/QX.*unconfirmed/);
  });

  it("quotaState: within, soft notice, hard stop", () => {
    const q = { metric: "video_renders" as const, monthly_soft: 8, monthly_hard: 10 };
    expect(quotaState(7, q)).toBe("within");
    expect(quotaState(8, q)).toBe("soft");
    expect(quotaState(10, q)).toBe("hard");
  });
});
