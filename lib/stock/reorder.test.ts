// Phase 5 Session A — stock-out warnings and reorder notes, against the
// database, with the global fetch stubbed to fail if touched and no model
// anywhere (the hard-limit parse is a stand-in seam). What must hold:
//   · cover reads the owner's own supplier: delivery time and minimum
//     order from 1.4.1.3, through the offer the product is matched to;
//   · a warning lands in the watch log once a week per item, watched or not;
//   · a reorder note is a PENDING stock_reorder_note with its arithmetic,
//     rounded up to the minimum order, and nothing executes (rule 27):
//     approved and due, the runner leaves it unrouted, with no execution row;
//   · the guards apply: the owner's manual limits ride along, three declines
//     silence the kind, a watched business gets no note (rule 15), and a
//     second run this month proposes nothing new.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  executions,
  fieldRecords,
  intakeEvents,
  metricObservations,
  modeDecisions,
  offers,
  proposals,
  suppliers,
  users,
  watchActivity,
} from "../../db/schema";
import { mappingKey } from "../connectors/mapping";
import type { Observation } from "../connectors/provider";
import { upsertObservations } from "../connectors/service";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { runDueExecutions } from "../execution/due";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal } from "../proposals/service";
import { shiftDay } from "./assess";
import { loadCover } from "./cover-load";
import { REORDER_KIND, proposeReorders } from "./reorder";
import { STOCK_WARNING_KIND, logStockWarnings } from "./warnings";

const TODAY = "2026-10-27";
const NOW = new Date(`${TODAY}T08:00:00Z`);

const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });
const manualAndDiscount: LimitLlm = async () => ({
  text: JSON.stringify({
    limits: [
      { code: "no_discounts", quote: "We never discount." },
      { code: "other", quote: "Ask me before ordering anything over €2,000." },
    ],
  }),
  calls: [],
});

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

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.account_id, accountIds));
  if (conns.length > 0) {
    await db.delete(metricObservations).where(
      inArray(
        metricObservations.connection_id,
        conns.map((c) => c.id),
      ),
    );
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
  }
  await db.delete(executions).where(inArray(executions.profile_id, ids));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(watchActivity).where(inArray(watchActivity.profile_id, ids));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
  await db.delete(suppliers).where(inArray(suppliers.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(offers).where(inArray(offers.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

async function answer(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.8),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

const MUG = "gid://shopify/Product/1";
const PLATE = "gid://shopify/Product/2";

/**
 * A stocked shop: a mug selling 3 a day with 12 left (about 4 days), matched
 * to an offer whose clay supplier takes 7 days with a minimum order of 50;
 * a plate selling 1 a day with 200 left. 120 days measured.
 */
async function shop(opts: { mode?: "instant" | "watching"; supplier?: boolean } = {}) {
  const s = await bootstrapIntake();
  created.push(s);
  await answer(s.profile_id, "identity.sells", [{ code: "physical_products" }]);
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: opts.mode ?? "instant",
    watch_weeks: opts.mode === "watching" ? 6 : null,
    inputs: {},
    reasoning: "fixture",
    confidence: "0.800",
    review_at: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
  });
  const [offer] = await db
    .insert(offers)
    .values({ profile_id: s.profile_id, kind: "physical" })
    .returning({ id: offers.id });
  await answer(s.profile_id, `offers.${offer!.id}.name`, "Blue Mug");
  await answer(s.profile_id, mappingKey(offer!.id, "shopify"), { product_ref: MUG });
  if (opts.supplier ?? true) {
    const [sup] = await db
      .insert(suppliers)
      .values({ profile_id: s.profile_id })
      .returning({ id: suppliers.id });
    await answer(s.profile_id, `suppliers.${sup!.id}.name`, "Midland Clay");
    await answer(s.profile_id, `suppliers.${sup!.id}.lead_time_days`, 7);
    await answer(s.profile_id, `suppliers.${sup!.id}.moq`, 50);
    await answer(s.profile_id, `suppliers.${sup!.id}.supplies_offers`, [{ code: offer!.id }]);
  }

  const [conn] = await db
    .insert(connections)
    .values({ account_id: s.account_id, provider: "shopify" })
    .returning({ id: connections.id });
  const obs: Observation[] = [];
  const at = NOW.toISOString();
  for (let i = 1; i <= 120; i++) {
    const day = shiftDay(TODAY, -i);
    obs.push({
      metric_key: "orders.daily",
      period_date: day,
      dimensions: {},
      value_num: 4,
      observed_at: at,
    });
    for (const [ref, u] of [
      [MUG, 3],
      [PLATE, 1],
    ] as const) {
      obs.push({
        metric_key: "units.daily",
        period_date: day,
        dimensions: { product_ref: ref },
        value_num: u,
        observed_at: at,
      });
    }
  }
  const snap = (ref: string, name: string, q: number, cost: number) => {
    const dims = { product_ref: ref, item_name: name };
    obs.push({
      metric_key: "stock.on_hand",
      period_date: TODAY,
      dimensions: dims,
      value_num: q,
      observed_at: at,
    });
    obs.push({
      metric_key: "stock.value_at_cost",
      period_date: TODAY,
      dimensions: { ...dims, currency: "EUR" },
      value_minor: q * cost,
      observed_at: at,
    });
  };
  snap(MUG, "Blue Mug", 12, 980);
  snap(PLATE, "Dinner Plate", 200, 1_250);
  await upsertObservations(conn!.id, "shopify", obs);
  return s;
}

async function ownerOf(accountId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      account_id: accountId,
      email: `reorder-${crypto.randomUUID()}@test.local`,
      display_name: "Stock owner",
      role: "owner",
    })
    .returning({ id: users.id });
  return u!.id;
}

const kindOf = (p: typeof proposals.$inferSelect) => (p.action as { kind: string }).kind;
const detailOf = (p: typeof proposals.$inferSelect) =>
  (p.action as { detail: Record<string, unknown> }).detail;

describe("P5-02 cover reads the owner's own supplier", () => {
  it("takes the delivery time and minimum order through the matched offer", async () => {
    const s = await shop();
    const view = await loadCover(s.account_id, s.profile_id, NOW);
    const mug = view.rows.find((r) => r.item.ref === MUG)!;
    expect(mug.cover.lead).toMatchObject({ days: 7, basis: "stated", moq: 50 });
    expect(mug.cover.lead.source_field).toMatch(/^suppliers\.[0-9a-f-]{36}\.lead_time_days$/);
    expect(mug.cover.warning?.flag).toBe("ACT NOW");
    expect(mug.cover.warning?.sentence).toMatch(
      /^Blue Mug runs out in about \d–\d days; Midland Clay takes 7 days\.$/,
    );
    // The plate is unmatched: the default delivery time, ASSUMED, and plenty of cover.
    const plate = view.rows.find((r) => r.item.ref === PLATE)!;
    expect(plate.cover.lead.basis).toBe("assumed");
    expect(plate.cover.warning).toBeNull();
    expect(view.warnings.map((r) => r.item.ref)).toEqual([MUG]);
    // A year isn't measured: no season is counted, and it says so.
    expect(view.boost).toBeNull();
    expect(view.season_note).toMatch(/^No season counted/);
  });

  it("without a supplier on file the default stands in, named ASSUMED", async () => {
    const s = await shop({ supplier: false });
    const view = await loadCover(s.account_id, s.profile_id, NOW);
    const mug = view.rows.find((r) => r.item.ref === MUG)!;
    expect(mug.cover.lead).toMatchObject({ days: 14, basis: "assumed", source_field: null });
    expect(mug.cover.warning?.sentence).toContain("a delivery takes 14 days (ASSUMED)");
  });
});

describe("P5-02 warnings into the watch log", () => {
  it("logs each warned item once a week, with the figures it rests on", async () => {
    const s = await shop({ mode: "watching" });
    expect(await logStockWarnings(s.profile_id, NOW)).toBe(1);
    const rows = await db
      .select()
      .from(watchActivity)
      .where(
        and(eq(watchActivity.profile_id, s.profile_id), eq(watchActivity.kind, STOCK_WARNING_KIND)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatch(/^Blue Mug runs out in about/);
    expect(rows[0]!.meta).toMatchObject({
      name: "Blue Mug",
      on_hand: 12,
      lead_days: 7,
      lead_basis: "stated",
      reorder_quantity: 50,
    });
    // The same week again: nothing new. Next week: said again.
    expect(await logStockWarnings(s.profile_id, new Date(NOW.getTime() + 3_600_000))).toBe(0);
    expect(await logStockWarnings(s.profile_id, new Date(NOW.getTime() + 7 * 86_400_000))).toBe(1);
  });
});

describe("P5-03 reorder notes", () => {
  it("proposes a pending note with its arithmetic, up to the minimum order — and executes nothing", async () => {
    const s = await shop();
    const run = await proposeReorders(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(run.created).toHaveLength(1);
    const note = run.created[0]!;
    expect(note.status).toBe("pending");
    expect(note.module).toBe("stock");
    expect(kindOf(note)).toBe(REORDER_KIND);
    expect((note.action as { summary: string }).summary).toBe(
      "Reorder 50 × Blue Mug from Midland Clay — a note for you, not an order",
    );
    const d = detailOf(note);
    expect(d.note_only).toBe(true);
    // 3 a day × 7 days = 21, + the fast end's margin, rounded up to the minimum of 50.
    expect(d.reorder).toMatchObject({ quantity: 50, moq: 50, rounded_to_moq: true });
    expect(d.arithmetic).toMatch(
      /^3\.0 a day \(up to 3\.\d\) over 7 days = 21, \+ \d+ safety margin \(the fast end of the range\) = \d+; Midland Clay's minimum order is 50, so 50\.$/,
    );
    expect((d.reorder as { cost: unknown }).cost).toEqual({
      amount_minor: 50 * 980,
      currency: "EUR",
    });
    expect(d.sending).toContain("I never place, change or cancel an order");
    expect(note.reversibility).toMatchObject({ level: "easy" });
    // Provenance: the delivery time cites the owner's own fact.
    const assumptions = (note.scenario as { assumptions: { source_field: string | null }[] })
      .assumptions;
    expect(assumptions.some((a) => /\.lead_time_days$/.test(a.source_field ?? ""))).toBe(true);
    expect(assumptions.some((a) => /\.moq$/.test(a.source_field ?? ""))).toBe(true);

    // Idempotent this month.
    const again = await proposeReorders(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(again.created).toHaveLength(0);
    expect(again.skipped[0]?.reason).toBe("already proposed this month");

    // Approved and due, the runner leaves it unrouted: no execution row, ever.
    const owner = await ownerOf(s.account_id);
    await approveProposal({
      proposalId: note.id,
      userId: owner,
      executeNotBefore: new Date(Date.now() - 60_000).toISOString(),
    });
    const due = await runDueExecutions({ profileId: s.profile_id, sleep: async () => {} });
    expect(due.unroutable).toBe(1);
    expect(due.executed).toBe(0);
    const ran = await db
      .select({ id: executions.id })
      .from(executions)
      .where(eq(executions.proposal_id, note.id));
    expect(ran).toHaveLength(0);
    const [after] = await db.select().from(proposals).where(eq(proposals.id, note.id));
    expect(after!.status).toBe("approved");
  });

  it("the owner's manual limits ride along; a limit on another kind doesn't block it", async () => {
    const s = await shop();
    await answer(s.profile_id, "goals.owner_boundaries", "We never discount. Ask me first.");
    const run = await proposeReorders(s.profile_id, { now: NOW, limitLlm: manualAndDiscount });
    expect(run.blocked).toHaveLength(0);
    expect(run.created).toHaveLength(1);
    expect(detailOf(run.created[0]!).manual_limits).toEqual([
      "Ask me before ordering anything over €2,000.",
    ]);
  });

  it("three declined reorder notes silence the kind, saying why", async () => {
    const s = await shop();
    const owner = await ownerOf(s.account_id);
    for (const n of [1, 2, 3]) {
      await db.insert(proposals).values({
        profile_id: s.profile_id,
        module: "stock",
        originating_finding: `fixture:reorder-decline-${n}`,
        action: { kind: REORDER_KIND, summary: `older note ${n}` },
        scenario: {},
        reversibility: { level: "easy", if_you_change_your_mind: "" },
        status: "rejected",
        decided_by: owner,
        decided_at: NOW.toISOString(),
        rejection_reason: "I order on my own schedule",
        expires_at: NOW.toISOString(),
      });
    }
    const run = await proposeReorders(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(run.created).toHaveLength(0);
    expect(run.skipped[0]?.reason).toMatch(/declined reorder notes 3 times/);
  });

  it("a watched business gets no note (rule 15), though its warning is logged", async () => {
    const s = await shop({ mode: "watching" });
    const run = await proposeReorders(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(run.created).toHaveLength(0);
    expect(run.skipped[0]?.reason).toMatch(/still watching/);
    expect(await logStockWarnings(s.profile_id, NOW)).toBe(1);
  });
});
