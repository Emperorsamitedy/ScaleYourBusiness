// Ideas 46 and 48 against a real database: a shop's stored order baskets
// and a salon's imported visits mined for pairs, the pair's margin from
// the owner's own offers, the season series picked by the archetype's
// rules, and a pair drafted as a proposal — held before care, once a
// month, and never executed. No network, no model.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  bookingAppointments,
  bookingImports,
  businessProfiles,
  connections,
  decisionLog,
  fieldRecords,
  metricObservations,
  modeDecisions,
  offers,
  orderBaskets,
  profileSnapshots,
  proposals,
} from "../../db/schema";
import { shiftDay } from "../anomaly/baseline";
import { importBookings } from "../bookings/store";
import { mappingKey } from "../connectors/mapping";
import { canonicalDimensions } from "../connectors/service";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { money } from "../core/money";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { loadSeasons } from "../seasons/load";
import { fallbackName, loadBundles, pairKey } from "./load";
import { BUNDLES_MODULE, bundleRef, proposeBundle } from "./propose";

const NOW = new Date("2026-10-26T09:00:00Z");
const TODAY = "2026-10-26";
const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });
const created: { account_id: string; profile_id: string }[] = [];

let realFetchUsed = false;
beforeEach(() => {
  realFetchUsed = false;
  vi.stubGlobal("fetch", async () => {
    realFetchUsed = true;
    throw new Error("no real network in tests");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(realFetchUsed).toBe(false);
});

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.account_id, accountIds));
  const connIds = conns.map((c) => c.id);
  if (connIds.length > 0) {
    await db.delete(bookingAppointments).where(inArray(bookingAppointments.connection_id, connIds));
    await db.delete(bookingImports).where(inArray(bookingImports.connection_id, connIds));
    await db.delete(metricObservations).where(inArray(metricObservations.connection_id, connIds));
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
  }
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
  await db.delete(offers).where(inArray(offers.profile_id, ids));
  await db.delete(profileSnapshots).where(inArray(profileSnapshots.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

async function ownerSays(profileId: string, key: string, value: unknown) {
  const at = isoDateTime("2026-08-01T10:00:00Z");
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: 0.8,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note: null,
    }),
  );
}

async function inCare(profileId: string) {
  await db.insert(modeDecisions).values({
    profile_id: profileId,
    mode: "instant",
    watch_weeks: null,
    inputs: {},
    reasoning: "fixture",
    confidence: "0.800",
    review_at: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
  });
}

async function connection(accountId: string, provider: string): Promise<string> {
  const [row] = await db
    .insert(connections)
    .values({ account_id: accountId, provider, purpose: "measure", status: "connected" })
    .returning({ id: connections.id });
  return row!.id;
}

async function offer(profileId: string, name: string, price: number, cost: number | null) {
  const [row] = await db
    .insert(offers)
    .values({ profile_id: profileId, kind: "physical" })
    .returning();
  await ownerSays(profileId, `offers.${row!.id}.name`, name);
  await ownerSays(profileId, `offers.${row!.id}.price`, money(price, "EUR"));
  if (cost !== null)
    await ownerSays(profileId, `offers.${row!.id}.cost_to_deliver`, money(cost, "EUR"));
  return row!.id;
}

const SET = "gid://shopify/Product/5";
const VASE = "gid://shopify/Product/4";
const MUG = "gid://shopify/Product/1";

/** 200 orders over the last 100 days: 30 pour-over sets, 24 with a vase; 40 vases; the rest mugs. */
async function baskets(accountId: string, connectionId: string) {
  const rows: (typeof orderBaskets.$inferInsert)[] = [];
  const add = (n: number, refs: string[]) => {
    for (let i = 0; i < n; i++) {
      rows.push({
        account_id: accountId,
        connection_id: connectionId,
        order_ref: `o${rows.length}`,
        day: shiftDay(TODAY, -(1 + (rows.length % 100))),
        product_refs: refs,
        observed_at: NOW.toISOString(),
      });
    }
  };
  add(24, [VASE, SET].sort());
  add(6, [SET]);
  add(16, [VASE]);
  add(150, [MUG]);
  add(4, [MUG, VASE].sort());
  // Outside the window: never read.
  rows.push({
    account_id: accountId,
    connection_id: connectionId,
    order_ref: "old",
    day: shiftDay(TODAY, -400),
    product_refs: [MUG, SET].sort(),
    observed_at: NOW.toISOString(),
  });
  await db.insert(orderBaskets).values(rows);
}

async function revenueDays(connectionId: string, provider: string, days: number, perDay: number) {
  const rows = Array.from({ length: days }, (_, i) => {
    const dims = { currency: "EUR" };
    return {
      connection_id: connectionId,
      provider,
      metric_key: "revenue.daily",
      dimensions: dims,
      dimension_key: canonicalDimensions(dims),
      period_date: shiftDay(TODAY, -(days - i)),
      value_minor: perDay,
      currency: "EUR",
      value_num: null,
      observed_at: NOW.toISOString(),
    };
  });
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(metricObservations).values(rows.slice(i, i + 500));
  }
}

describe("a shop's orders", () => {
  it("mines the stored baskets of the window, names items by their offer, and prices the pair", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const conn = await connection(s.account_id, "shopify");
    await baskets(s.account_id, conn);
    const setOffer = await offer(s.profile_id, "Pour-Over Coffee Set", 11_800, 3_800);
    const vaseOffer = await offer(s.profile_id, "Bud Vase Trio", 4_800, 1_100);
    await ownerSays(s.profile_id, mappingKey(setOffer, "shopify"), {
      product_ref: SET,
      label_raw: "Set",
    });
    await ownerSays(s.profile_id, mappingKey(vaseOffer, "shopify"), {
      product_ref: VASE,
      label_raw: "Vase",
    });

    const view = await loadBundles(s.account_id, s.profile_id, NOW);
    expect(view.sources).toHaveLength(1);
    const src = view.sources[0]!;
    expect(src.kind).toBe("orders");
    expect(src.label).toBe("Shopify");
    if (src.result.status !== "mined") throw new Error(src.result.status);
    expect(src.result.baskets).toBe(200);
    // Mug + vase: 4 together is under the count line.
    expect(src.pairs).toHaveLength(1);
    const p = src.pairs[0]!;
    expect([p.a_name, p.b_name]).toEqual(["Pour-Over Coffee Set", "Bud Vase Trio"]);
    expect(p.together).toBe(24);
    expect(p.confidence).toBeCloseTo(0.8);
    expect(p.key).toBe(pairKey(conn, SET, VASE));
    expect(p.margin).toMatchObject({
      known: true,
      price_minor: 16_600,
      contribution_minor: 11_700,
      margin_pct: 70.5,
    });
    expect(p.sentence).toMatch(
      /together in 24 orders \(80% of orders with Pour-Over Coffee Set, 55% of those with Bud Vase Trio\)/,
    );
  });

  it("mines Square's till baskets, whose refs are the items' own names (I-48a)", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const conn = await connection(s.account_id, "square");
    const rows: (typeof orderBaskets.$inferInsert)[] = [];
    const add = (n: number, refs: string[]) => {
      for (let i = 0; i < n; i++) {
        rows.push({
          account_id: s.account_id,
          connection_id: conn,
          order_ref: `sq${rows.length}`,
          day: shiftDay(TODAY, -(1 + (rows.length % 100))),
          product_refs: refs,
          observed_at: NOW.toISOString(),
        });
      }
    };
    add(24, ["Croissant", "Latte"]);
    add(6, ["Latte"]);
    add(16, ["Croissant"]);
    add(150, ["Tea"]);
    add(4, ["Croissant", "Tea"]);
    await db.insert(orderBaskets).values(rows);

    const view = await loadBundles(s.account_id, s.profile_id, NOW);
    const src = view.sources.find((x) => x.kind === "orders");
    expect(src?.label).toBe("Square");
    if (src?.result.status !== "mined") throw new Error(String(src?.result.status));
    expect(src.result.baskets).toBe(200);
    expect(src.pairs).toHaveLength(1);
    expect([src.pairs[0]!.a_name, src.pairs[0]!.b_name].sort()).toEqual(["Croissant", "Latte"]);
    expect(src.pairs[0]!.together).toBe(24);
  });

  it("names an unmatched item by its name at Square, by its id elsewhere", () => {
    expect(fallbackName("square", "Flat white")).toBe("Flat white");
    expect(fallbackName("shopify", "gid://shopify/Product/5")).toBe("Product 5");
  });

  it("says so when no store keeps products, rather than mining nothing", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await connection(s.account_id, "stripe");
    const view = await loadBundles(s.account_id, s.profile_id, NOW);
    expect(view.sources).toEqual([]);
    expect(view.without_lines).toEqual(["Stripe"]);
  });
});

/** 60 days of a salon: per day 3 colour clients who add a treatment, 2 who don't, 10 cuts. */
function salonCsv(): string {
  const lines = ["Date,Time,Status,Service,Email,Price"];
  let c = 0;
  for (let d = 60; d >= 1; d--) {
    const day = shiftDay(TODAY, -d);
    const row = (service: string, client: number, price: string, status = "Completed") =>
      lines.push(`${day},10:00,${status},${service},c${client}@example.com,${price}`);
    for (let k = 0; k < 3; k++) {
      c++;
      row("Colour", c, "95.00");
      row("Treatment", c, "25.00");
    }
    for (let k = 0; k < 2; k++) row("Colour", ++c, "95.00");
    for (let k = 0; k < 10; k++) row("Cut & finish", ++c, "45.00");
    row("Colour", ++c, "95.00", "No-show");
  }
  return lines.join("\n");
}

describe("a salon's visits", () => {
  it("groups each client's day into a visit and finds the add-on", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await ownerSays(s.profile_id, "identity.business_type", { code: "salon_beauty" });
    await importBookings(
      s.account_id,
      salonCsv(),
      { platform: "generic", currency: "EUR", dateOrder: null },
      NOW,
    );
    const view = await loadBundles(s.account_id, s.profile_id, NOW);
    const src = view.sources.find((x) => x.kind === "visits")!;
    expect(src.label).toBe("your bookings export");
    if (src.result.status !== "mined") throw new Error(src.result.status);
    expect(src.result.baskets).toBe(60 * 15);
    expect(src.pairs.map((p) => [p.a_name, p.b_name])).toEqual([["Treatment", "Colour"]]);
    expect(src.pairs[0]!.confidence).toBe(1);
    expect(src.pairs[0]!.margin).toEqual({
      known: false,
      why: "no price on record for Treatment or Colour",
    });

    // The season forecast reads the same salon's booking revenue, and refuses: 60 days.
    const seasons = await loadSeasons(s.account_id, s.profile_id, NOW);
    expect(seasons.result.status).toBe("too_little");
    if (seasons.result.status === "too_little") {
      expect(seasons.result.series.noun).toBe("booking revenue");
      expect(seasons.result.series.source).toBe("your bookings export");
    }
  });
});

describe("the season series", () => {
  it("reads one source — the one with the most days — never two added together", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const shop = await connection(s.account_id, "shopify");
    const stripe = await connection(s.account_id, "stripe");
    await revenueDays(shop, "shopify", 380, 10_000);
    await revenueDays(stripe, "stripe", 90, 9_000);
    const view = await loadSeasons(s.account_id, s.profile_id, NOW);
    expect(view.result.status).toBe("ready");
    if (view.result.status !== "ready") return;
    expect(view.result.series.source).toBe("Shopify");
    // One source's €100 a day: a normal week of €700, not €1,330.
    expect(view.result.normal.median).toBe(70_000);
  });
});

describe("a pair, proposed", () => {
  async function shopWithPair() {
    const s = await bootstrapIntake();
    created.push(s);
    const conn = await connection(s.account_id, "shopify");
    await baskets(s.account_id, conn);
    return { ...s, key: pairKey(conn, SET, VASE) };
  }

  it("is held before the business is in care (rule 15)", async () => {
    const s = await shopWithPair();
    const run = await proposeBundle(s.profile_id, s.key, { now: NOW, limitLlm: noLimits });
    expect(run.status).toBe("held");
    expect(await db.select().from(proposals).where(eq(proposals.profile_id, s.profile_id))).toEqual(
      [],
    );
  });

  it("drafts one proposal with its log entry, once a month, with nothing to execute it", async () => {
    const s = await shopWithPair();
    await inCare(s.profile_id);
    const run = await proposeBundle(s.profile_id, s.key, { now: NOW, limitLlm: noLimits });
    expect(run.status).toBe("created");
    if (!("proposal" in run)) return;
    const p = run.proposal;
    expect(p.module).toBe(BUNDLES_MODULE);
    expect(p.status).toBe("pending");
    expect(p.originating_finding).toBe(bundleRef(s.key, NOW));
    const action = p.action as { kind: string; detail: { draft_only: boolean; what: string } };
    expect(action.kind).toBe("offer_change");
    expect(action.detail.draft_only).toBe(true);
    expect(action.detail.what).toMatch(/both at full price\. No discount/);
    const log = await db.select().from(decisionLog).where(eq(decisionLog.ref_id, p.id));
    expect(log.map((l) => l.kind)).toEqual(["proposal"]);

    const again = await proposeBundle(s.profile_id, s.key, { now: NOW, limitLlm: noLimits });
    expect(again.status).toBe("already");
  });

  it("refuses a pair that isn't among the ones shown", async () => {
    const s = await shopWithPair();
    await inCare(s.profile_id);
    const run = await proposeBundle(s.profile_id, `${s.key}x`, { now: NOW, limitLlm: noLimits });
    expect(run.status).toBe("not_found");
  });
});
