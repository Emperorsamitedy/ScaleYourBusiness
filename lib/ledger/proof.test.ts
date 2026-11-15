// The Proof Ledger in full — the v1 build spec §3.7's acceptance criteria
// and Phase 1's gate (§12): "Database refuses a ledger update. Verify
// endpoint catches a single altered byte. A seeded loss shows as negative in
// the counter."

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  intakeEvents,
  ledgerChainHeads,
  ledgerEntries,
  ledgerTamperEvents,
  measurementPlans,
} from "../../db/schema";
import { money } from "../core/money";
import { bootstrapIntake } from "../intake/service";
import type { Entry } from "./chain";
import { entryHash, publishChainHead, verifyChain, verifyLedger } from "./chain";
import { closeDuePlans, closePlan, correctEntry, verdictOf } from "./close";
import { calibration, calibrationOf, headlineCounter } from "./counter";
import type { OpenPlanInput } from "./plans";
import {
  DESIGN_PREFERENCE,
  MeasurementRequiredError,
  chooseDesign,
  openPlan,
  planGrade,
  requireOpenPlan,
} from "./plans";

const created: { account_id: string; profile_id: string }[] = [];
let profileId = "";
let accountId = "";
const FUTURE = new Date("2100-01-01T00:00:00Z");

beforeAll(async () => {
  const s = await bootstrapIntake();
  created.push(s);
  profileId = s.profile_id;
  accountId = s.account_id;
});

afterAll(async () => {
  // Plans and entries stay: the ledger is permanent by design.
  for (const s of created) {
    await db.delete(connections).where(eq(connections.account_id, s.account_id));
    await db.delete(intakeEvents).where(eq(intakeEvents.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

function causeOf(error: unknown): string {
  const e = error as { message?: string; cause?: { message?: string } };
  return `${e.message ?? ""} ${e.cause?.message ?? ""}`;
}

function input(over: Partial<OpenPlanInput> = {}): OpenPlanInput {
  return {
    profileId,
    accountId,
    provider: "meta_ads",
    action_summary: "Raise the daily budget of the spring campaign by €10",
    hypothesis: "More reach brings more orders at the same cost per order",
    expected: {
      effect: money(50_000, "EUR"),
      low: money(20_000, "EUR"),
      high: money(80_000, "EUR"),
    },
    currency: "EUR",
    cost: money(10_000, "EUR"),
    reversible: true,
    rollback_token: "restore-budget-1",
    opened_by: "agent",
    station: 3,
    shadow: false,
    // Windows that have already ended, so plans can be closed in the test.
    now: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("§3.3 — designs, strongest first, downgraded only with a reason", () => {
  it("states the spec's table as data", () => {
    expect(DESIGN_PREFERENCE.meta_ads[0]).toBe("holdout_geo");
    expect(DESIGN_PREFERENCE.email_campaign[0]).toBe("holdout_audience");
    expect(DESIGN_PREFERENCE.hours_change[0]).toBe("switchback");
    expect(DESIGN_PREFERENCE.reorder[0]).toBe("matched_period");
    expect(DESIGN_PREFERENCE.chat_answer).toEqual(["unmeasurable"]);
  });

  it("never claims a holdout ScaleX doesn't run — it says pre/post, and why", () => {
    const { design, downgrade_reason } = chooseDesign("meta_ads");
    expect(design).toBe("pre_post_adjusted");
    expect(downgrade_reason).toMatch(/holdout geo isn't built/);
    expect(chooseDesign("chat_answer")).toEqual({ design: "unmeasurable", downgrade_reason: null });
  });

  it("grades a plan by its design and whether its metric is measured", () => {
    expect(planGrade("holdout_geo", true)).toBe("A");
    expect(planGrade("matched_period", true)).toBe("B");
    expect(planGrade("pre_post_adjusted", true)).toBe("C");
    expect(planGrade("holdout_geo", false)).toBe("D");
    expect(planGrade("unmeasurable", true)).toBe("D");
  });
});

describe("§3.1 / §3.2 — the plan, written first", () => {
  it("records the expectation as a range, the window, the design and the station", async () => {
    const { plan } = await openPlan(input({ now: new Date("2026-11-01T00:00:00Z") }));
    expect(plan).toMatchObject({
      capability: "meta_ads",
      primary_metric: "revenue",
      design: "pre_post_adjusted",
      expected_effect_minor: 50_000,
      expected_low_minor: 20_000,
      expected_high_minor: 80_000,
      cost_minor: 10_000,
      ladder_station_at_open: 3,
      opened_by: "agent",
      reversible: true,
      rollback_token: "restore-budget-1",
    });
    expect(Date.parse(plan.window_end) - Date.parse(plan.window_start)).toBe(28 * 86_400_000);
    // No revenue connector on this account: the plan rests on nothing measured.
    expect(plan.confidence_grade).toBe("D");
    expect(plan.control_definition).toMatchObject({ kind: "pre_period", days: 28 });
  });

  it("is C once a connector measures its metric", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await db.insert(connections).values({
      account_id: s.account_id,
      provider: "fixture",
      purpose: "measure",
      status: "connected",
      granted_scopes: ["read_revenue", "read_orders", "read_ad_spend"],
    });
    const { plan } = await openPlan(input({ profileId: s.profile_id, accountId: s.account_id }));
    expect(plan.confidence_grade).toBe("C");
  });

  it("one plan per proposal: a retry reads the plan it has", async () => {
    const proposalId = randomUUID();
    const a = await openPlan(input({ proposalId }));
    const b = await openPlan(input({ proposalId, now: new Date(Date.now() + 86_400_000) }));
    expect(b.reused).toBe(true);
    expect(b.plan.id).toBe(a.plan.id);
    expect(b.plan.window_end).toBe(a.plan.window_end);
  });

  it("refuses a range that doesn't hold its estimate, or two currencies", async () => {
    await expect(
      openPlan(
        input({
          expected: { effect: money(1, "EUR"), low: money(5, "EUR"), high: money(9, "EUR") },
        }),
      ),
    ).rejects.toThrow(/inside its range/);
    await expect(
      openPlan(
        input({
          expected: { effect: money(5, "EUR"), low: money(1, "HUF"), high: money(9, "EUR") },
        }),
      ),
    ).rejects.toThrow(/one currency/);
  });

  it("an irreversible action keeps no rollback token", async () => {
    const { plan } = await openPlan(input({ reversible: false, rollback_token: "x" }));
    expect(plan.rollback_token).toBeNull();
  });
});

describe("§3.7 — MeasurementRequiredError", () => {
  it("is raised with no plan, an unknown plan, or a closed one", async () => {
    await expect(requireOpenPlan(null)).rejects.toBeInstanceOf(MeasurementRequiredError);
    await expect(requireOpenPlan(randomUUID())).rejects.toBeInstanceOf(MeasurementRequiredError);
    const { plan } = await openPlan(input());
    await expect(requireOpenPlan(plan.id)).resolves.toMatchObject({ id: plan.id });
    await closePlan(plan.id, { inconclusive: "test" });
    await expect(requireOpenPlan(plan.id)).rejects.toBeInstanceOf(MeasurementRequiredError);
  });
});

describe("§3.7 — a plan can't be edited after it opens; attempts are tamper events", () => {
  it("window_end can't move: the update changes nothing and is logged", async () => {
    const { plan } = await openPlan(input());
    const moved = await db
      .update(measurementPlans)
      .set({ window_end: "2099-01-01T00:00:00Z" })
      .where(eq(measurementPlans.id, plan.id))
      .returning();
    expect(moved).toHaveLength(0);
    const [still] = await db
      .select()
      .from(measurementPlans)
      .where(eq(measurementPlans.id, plan.id));
    expect(still?.window_end).toBe(plan.window_end);
    const events = await db
      .select()
      .from(ledgerTamperEvents)
      .where(eq(ledgerTamperEvents.row_id, plan.id));
    expect(events.map((e) => e.op)).toEqual(["UPDATE"]);
    expect((events[0]?.attempted as { window_end: string }).window_end).toMatch(/^2099/);
  });

  it("a delete is refused the same way", async () => {
    const { plan } = await openPlan(input());
    await db.delete(measurementPlans).where(eq(measurementPlans.id, plan.id));
    const [still] = await db
      .select()
      .from(measurementPlans)
      .where(eq(measurementPlans.id, plan.id));
    expect(still?.id).toBe(plan.id);
    const events = await db
      .select()
      .from(ledgerTamperEvents)
      .where(and(eq(ledgerTamperEvents.row_id, plan.id), eq(ledgerTamperEvents.op, "DELETE")));
    expect(events).toHaveLength(1);
  });

  it("the tamper log itself can't be edited", async () => {
    const [any] = await db.select().from(ledgerTamperEvents).limit(1);
    const error = await db
      .delete(ledgerTamperEvents)
      .where(eq(ledgerTamperEvents.id, any!.id))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(causeOf(error)).toMatch(/append-only/);
  });
});

describe("verdicts — from the interval, never the point alone", () => {
  const plan = { design: "pre_post_adjusted" as const, expected_effect_minor: 50_000 };
  const o = (observed: number, low: number, high: number) => ({
    observed_minor: observed,
    low_minor: low,
    high_minor: high,
    method_notes: "t",
  });

  it("names each verdict", () => {
    expect(verdictOf(plan, o(40_000, 10_000, 70_000))).toBe("verified_gain");
    expect(verdictOf(plan, o(-30_000, -50_000, -10_000))).toBe("loss");
    expect(verdictOf(plan, o(1_000, -20_000, 20_000))).toBe("no_effect");
    expect(verdictOf(plan, o(1_000, -90_000, 90_000))).toBe("inconclusive");
    expect(verdictOf(plan, { inconclusive: "no data" })).toBe("inconclusive");
    expect(verdictOf({ ...plan, design: "unmeasurable" }, o(9, 1, 10))).toBe("inconclusive");
  });
});

describe("PHASE 1 GATE — the database refuses a ledger update", () => {
  it("UPDATE and DELETE on ledger_entries fail at the database", async () => {
    const { plan } = await openPlan(input());
    const entry = await closePlan(plan.id, {
      observed_minor: 30_000,
      low_minor: 5_000,
      high_minor: 55_000,
      method_notes: "before and after",
    });
    for (const attempt of [
      () =>
        db.update(ledgerEntries).set({ net_minor: 999_999 }).where(eq(ledgerEntries.id, entry.id)),
      () => db.delete(ledgerEntries).where(eq(ledgerEntries.id, entry.id)),
    ]) {
      const error = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(causeOf(error)).toMatch(/append-only/);
    }
    const [still] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.id, entry.id));
    expect(still?.net_minor).toBe(20_000);
  });

  it("an entry that doesn't extend the chain head is refused — no forks", async () => {
    const { plan } = await openPlan(input());
    const error = await db
      .insert(ledgerEntries)
      .values({
        seq: 1,
        plan_id: plan.id,
        profile_id: profileId,
        verdict: "inconclusive",
        currency: "EUR",
        method_notes: "forged",
        prev_hash: null,
        entry_hash: "f".repeat(64),
        created_at: new Date().toISOString(),
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(causeOf(error)).toMatch(/extend the chain head/);
  });

  it("a plan isn't scored before its window ends", async () => {
    const { plan } = await openPlan(input({ now: new Date() }));
    await expect(closePlan(plan.id, { inconclusive: "early" })).rejects.toThrow(/hasn't ended/);
  });

  it("a plan closes once; a correction is a new entry naming the original", async () => {
    const { plan } = await openPlan(input());
    const first = await closePlan(plan.id, { inconclusive: "data late" });
    await expect(closePlan(plan.id, { inconclusive: "again" })).rejects.toThrow(/already closed/);
    const fixed = await correctEntry(
      first.id,
      { observed_minor: 60_000, low_minor: 30_000, high_minor: 90_000, method_notes: "re-read" },
      "the connector's late days arrived",
    );
    expect(fixed.corrects_entry_id).toBe(first.id);
    expect(fixed.verdict).toBe("verified_gain");
    const both = await db.select().from(ledgerEntries).where(eq(ledgerEntries.plan_id, plan.id));
    expect(both).toHaveLength(2);
  });
});

describe("PHASE 1 GATE — verify catches a single altered byte", () => {
  it("the stored chain verifies", async () => {
    const verdict = await verifyLedger();
    expect(verdict.ok).toBe(true);
    expect(verdict.entries).toBeGreaterThan(0);
  });

  it("one byte changed anywhere breaks the chain at that entry", async () => {
    const rows = await db.select().from(ledgerEntries).orderBy(ledgerEntries.seq);
    expect(verifyChain(rows).ok).toBe(true);
    const target = Math.floor(rows.length / 2);
    const original = rows[target]!;

    const flip = (s: string) => s.slice(0, -1) + (s.endsWith("a") ? "b" : "a");
    const tampered: Entry[] = rows.map((r, i) =>
      i === target ? { ...r, method_notes: flip(r.method_notes) } : r,
    );
    expect(verifyChain(tampered)).toMatchObject({
      ok: false,
      first_break: { seq: original.seq, id: original.id, why: "hash" },
    });

    // A forger who also recomputes that entry's hash breaks the next link instead.
    if (target + 1 < rows.length) {
      const rehashed = { ...tampered[target]!, entry_hash: "" };
      rehashed.entry_hash = entryHash(rehashed);
      const forged = tampered.map((r, i) => (i === target ? rehashed : r));
      expect(verifyChain(forged)).toMatchObject({
        ok: false,
        first_break: { seq: rows[target + 1]!.seq, why: "link" },
      });
    }

    // A money figure changed by one unit is caught the same way.
    const moneyRow = rows.findIndex((r) => r.net_minor !== null);
    const withMoney = rows.map((r, i) =>
      i === moneyRow ? { ...r, net_minor: (r.net_minor ?? 0) + 1 } : r,
    );
    expect(verifyChain(withMoney)).toMatchObject({ ok: false, first_break: { why: "hash" } });
  });

  it("publishes the day's head once", async () => {
    const day = "1999-12-31";
    const first = await publishChainHead(day);
    const again = await publishChainHead(day);
    expect(again.published).toBe(false);
    const rows = await db.select().from(ledgerChainHeads).where(eq(ledgerChainHeads.day, day));
    expect(rows).toHaveLength(1);
    expect(first.head_hash === null || /^[0-9a-f]{64}$/.test(first.head_hash)).toBe(true);
  });
});

describe("PHASE 1 GATE — a seeded loss shows as negative in the counter (§3.4)", () => {
  it("losses are in the number; inconclusive and unmeasurable are counted apart", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await db.insert(connections).values({
      account_id: s.account_id,
      provider: "fixture",
      purpose: "measure",
      status: "connected",
      granted_scopes: ["read_revenue", "read_orders", "read_ad_spend"],
    });
    const at = { profileId: s.profile_id, accountId: s.account_id };

    const loss = (await openPlan(input(at))).plan;
    await closePlan(loss.id, {
      observed_minor: -40_000,
      low_minor: -60_000,
      high_minor: -20_000,
      method_notes: "orders fell after the change",
    });

    let counter = await headlineCounter(s.profile_id, { now: FUTURE });
    expect(counter.verified).toEqual([money(-50_000, "EUR")]); // −400 observed − 100 cost
    expect(counter.losses).toEqual([money(-50_000, "EUR")]);
    expect(counter.plan_ids).toEqual([loss.id]);

    const gain = (await openPlan(input(at))).plan;
    await closePlan(gain.id, {
      observed_minor: 90_000,
      low_minor: 60_000,
      high_minor: 120_000,
      method_notes: "orders rose",
    });
    const unclear = (await openPlan(input(at))).plan;
    await closePlan(unclear.id, {
      observed_minor: 5_000,
      low_minor: -200_000,
      high_minor: 210_000,
      method_notes: "too noisy",
    });
    const reply = (await openPlan(input({ ...at, provider: "google_business_reviews" }))).plan;
    await closePlan(reply.id, { inconclusive: "x" });
    const shadow = (await openPlan(input({ ...at, shadow: true, station: 2 }))).plan;
    await closePlan(shadow.id, {
      observed_minor: 500_000,
      low_minor: 400_000,
      high_minor: 600_000,
      method_notes: "what would have happened",
    });

    counter = await headlineCounter(s.profile_id, {
      now: FUTURE,
      fee: [money(4_900, "EUR")],
    });
    expect(counter.verified).toEqual([money(30_000, "EUR")]); // −500 + (900 − 100)
    expect(counter.losses).toEqual([money(-50_000, "EUR")]);
    expect(counter.not_yet_proven).toEqual({ inconclusive: 1, unmeasurable: 1 });
    expect(counter.fee).toEqual([money(4_900, "EUR")]);
    expect(counter.net_of_fee).toEqual([money(25_100, "EUR")]);
    expect(counter.plan_ids.sort()).toEqual([loss.id, gain.id].sort());
  });

  it("a plan resting only on owner-stated inputs (grade D) never reaches the number", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const { plan } = await openPlan(input({ profileId: s.profile_id, accountId: s.account_id }));
    expect(plan.confidence_grade).toBe("D");
    await closePlan(plan.id, {
      observed_minor: 90_000,
      low_minor: 60_000,
      high_minor: 120_000,
      method_notes: "x",
    });
    expect((await headlineCounter(s.profile_id, { now: FUTURE })).verified).toEqual([]);
  });

  it("a window that hasn't ended isn't counted yet", async () => {
    expect((await headlineCounter(profileId, { now: new Date("2000-01-01") })).verified).toEqual(
      [],
    );
  });
});

describe("§3.6 — the calibration score", () => {
  it("is the median absolute forecast error as a % of the expected effect", () => {
    const row = (expected: number, error: number, end: string) => ({
      plan: {
        id: randomUUID(),
        shadow: false,
        expected_effect_minor: expected,
        window_end: end,
      } as never,
      entry: { seq: 1, forecast_error_minor: error } as never,
    });
    const result = calibrationOf([
      row(10_000, 1_000, "2026-01-01"), // 10 %
      row(10_000, -3_000, "2026-01-02"), // 30 %
      row(20_000, 10_000, "2026-01-03"), // 50 %
    ]);
    expect(result).toEqual({ median_error_pct: 30, plans: 3 });
  });

  it("takes the trailing 20 only", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      plan: {
        id: randomUUID(),
        shadow: false,
        expected_effect_minor: 100,
        window_end: `2026-01-${String(i + 1).padStart(2, "0")}`,
      } as never,
      // The 5 oldest are wildly wrong; the latest 20 are 10 % off.
      entry: { seq: 1, forecast_error_minor: i < 5 ? 1_000 : 10 } as never,
    }));
    expect(calibrationOf(rows)).toEqual({ median_error_pct: 10, plans: 20 });
  });

  it("is computed per business and globally from the stored ledger", async () => {
    const mine = await calibration(profileId, FUTURE);
    const all = await calibration(null, FUTURE);
    expect(all.plans).toBeGreaterThanOrEqual(mine.plans);
  });
});

describe("closing due plans", () => {
  it("closes through the capability's measurer, inconclusive without one, open when it throws", async () => {
    const past = new Date("2026-01-01T00:00:00Z");
    const a = (await openPlan(input({ now: past }))).plan;
    const b = (await openPlan(input({ now: past, provider: "purchase_order" }))).plan;
    const c = (await openPlan(input({ now: past, provider: "email_campaign" }))).plan;
    const closed: string[] = [];
    const result = await closeDuePlans({
      only: [a.id, b.id, c.id],
      measurers: {
        meta_ads: async () => ({
          observed_minor: 1,
          low_minor: 0,
          high_minor: 2,
          method_notes: "t",
        }),
        email_campaign: async () => {
          throw new Error("connector down");
        },
      },
      onClosed: async (e) => {
        closed.push(e.plan_id);
      },
    });
    expect(result).toEqual({ closed: 2, left_open: 1 });
    expect(closed.sort()).toEqual([a.id, b.id].sort());
    const [bEntry] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.plan_id, b.id));
    expect(bEntry?.verdict).toBe("inconclusive");
    expect(bEntry?.method_notes).toMatch(/No way to measure purchase order yet/);
    const cEntries = await db
      .select()
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.plan_id, [c.id]));
    expect(cEntries).toHaveLength(0);
  });
});
