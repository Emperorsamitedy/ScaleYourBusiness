// P5-07 / P5-08 against a real database: the intake answers 5.3e and 5.3f
// as Money through its normal path; the loader reads them, the costs and
// offers lists and one source's measured sales into a forecast; and the
// watch logs the first tight week once, again when it moves, and once
// when it clears. No network, no model.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  costItems,
  fieldRecords,
  intakeEvents,
  metricObservations,
  offers,
  watchActivity,
} from "../../db/schema";
import { canonicalDimensions } from "../connectors/service";
import { bootstrapIntake, submitAnswer, submitEntities } from "../intake/service";
import { readCurrentField } from "../profile/field-store";
import { addDays } from "../seasons/forecast";
import { CASH_WARNING_KIND, logCashWarning, watchLog } from "../watch/job";
import { TODAY, baseInputs, cost, daily, eur } from "./fixtures";
import { BUFFER_KEY, CASH_KEY } from "./keys";
import { loadCashInputs } from "./load";
import type { CashForecast } from "./model";
import { forecastCash } from "./model";

const NOW = new Date(`${TODAY}T09:00:00Z`);
const created: { account_id: string; profile_id: string }[] = [];

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network was called");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const s of created) {
    await db.delete(watchActivity).where(eq(watchActivity.profile_id, s.profile_id));
    const rows = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await db.delete(metricObservations).where(inArray(metricObservations.connection_id, ids));
    }
    await db.delete(connections).where(eq(connections.account_id, s.account_id));
    await db.delete(intakeEvents).where(eq(intakeEvents.profile_id, s.profile_id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(costItems).where(eq(costItems.profile_id, s.profile_id));
    await db.delete(offers).where(eq(offers.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

const money = (major: number) => ({ amount_major: major, currency: "EUR" });

async function observe(accountId: string, days: number, perDay: number, orders: number) {
  const [conn] = await db
    .insert(connections)
    .values({ account_id: accountId, provider: "stripe", purpose: "measure", status: "connected" })
    .returning({ id: connections.id });
  const rows = [];
  for (let i = days; i >= 1; i--) {
    const day = addDays(TODAY, -i);
    const dims = { currency: "EUR" };
    rows.push({
      connection_id: conn!.id,
      provider: "stripe",
      metric_key: "revenue.daily",
      dimensions: dims,
      dimension_key: canonicalDimensions(dims),
      period_date: day,
      value_minor: perDay,
      currency: "EUR",
      value_num: null,
      observed_at: NOW.toISOString(),
    });
    rows.push({
      connection_id: conn!.id,
      provider: "stripe",
      metric_key: "orders.daily",
      dimensions: {},
      dimension_key: canonicalDimensions({}),
      period_date: day,
      value_minor: null,
      currency: null,
      value_num: String(orders),
      observed_at: NOW.toISOString(),
    });
  }
  await db.insert(metricObservations).values(rows);
}

describe("P5-06/07 — the intake's answers become the forecast's inputs", () => {
  it("reads cash, buffer, provider, costs, offers and the measured series, read-only", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const answer = (qid: string, wire: unknown) =>
      submitAnswer(s.account_id, s.profile_id, qid, { kind: "value", wire });
    await answer("4.1", "yes");
    await answer("4.2a", ["card", "online_payment"]);
    await answer("4.2b", "stripe");
    await answer("5.3e", money(6400));
    await answer("5.3f", money(2500));
    await submitEntities(s.account_id, s.profile_id, "5.1", [
      { category: "rent", label: "Studio rent", amount: money(1450), cadence: "monthly" },
      { category: "loan_payments", label: "Bank loan", amount: money(400), cadence: "monthly" },
    ]);
    await submitEntities(s.account_id, s.profile_id, "5.2", [
      { category: "shipping", label: "Courier label", amount: money(7.4), cadence: "per_job" },
    ]);
    expect((await readCurrentField(s.profile_id, CASH_KEY))?.value).toEqual({
      amount_minor: 640_000,
      currency: "EUR",
    });
    expect((await readCurrentField(s.profile_id, BUFFER_KEY))?.status).toBe("answered");
    await observe(s.account_id, 120, 90_000, 12);

    const before = await db
      .select()
      .from(fieldRecords)
      .where(eq(fieldRecords.profile_id, s.profile_id));
    const inputs = await loadCashInputs(s.account_id, s.profile_id, NOW);
    const after = await db
      .select()
      .from(fieldRecords)
      .where(eq(fieldRecords.profile_id, s.profile_id));
    expect(after).toHaveLength(before.length); // nothing written

    expect(inputs.cash).toMatchObject({
      status: "known",
      fact: { amount_minor: 640_000, basis: "STATED" },
    });
    expect(inputs.buffer).toMatchObject({ status: "known", fact: { amount_minor: 250_000 } });
    expect(inputs.payout).toEqual({ provider: "stripe", methods: ["card", "online_payment"] });
    expect(inputs.revenue).toMatchObject({ source: "Stripe", provider: "stripe", currency: "EUR" });
    expect(inputs.revenue?.values.size).toBe(120);
    expect(inputs.volume?.noun).toBe("orders");
    expect(inputs.costs.map((c) => [c.label, c.category, c.list, c.cadence])).toEqual(
      expect.arrayContaining([
        ["Studio rent", "rent", "fixed", "monthly"],
        ["Bank loan", "loan_payments", "fixed", "monthly"],
        ["Courier label", "shipping", "variable", "per_job"],
      ]),
    );

    const f = forecastCash(inputs);
    expect(f.status).toBe("ready");
    if (f.status !== "ready") return;
    expect(f.debt_monthly).toBe(40_000);
    expect(f.payout.code).toBe("stripe");
    // €7.40 × 12 orders on €900 a day.
    expect(f.variable.ratio).toBeCloseTo((740 * 12) / 90_000, 10);
  });

  it("'I don't know' to cash today reaches the forecast as a refusal that says so", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await submitAnswer(s.account_id, s.profile_id, "4.1", { kind: "value", wire: "yes" });
    await submitAnswer(s.account_id, s.profile_id, "5.3e", { kind: "unknown" });
    await observe(s.account_id, 70, 50_000, 5);
    const f = forecastCash(await loadCashInputs(s.account_id, s.profile_id, NOW));
    expect(f.status === "refused" && f.reason).toBe("no_cash");
    expect(f.status === "refused" && f.headline).toMatch(/you don't know/);
  });
});

describe("P5-08 — the watch logs a tight week when it appears, moves or clears", () => {
  it("once, quiet while unchanged, again when it moves, once when it clears, never on a refusal", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const tight = (vatMajor: number): CashForecast =>
      forecastCash(
        baseInputs({
          revenue: daily(TODAY, 120, () => 10_000),
          costs: [cost("Rent", 1200, "monthly"), cost("VAT return", vatMajor, "quarterly")],
        }),
      );
    const fine = forecastCash(baseInputs());
    const refusal = forecastCash(baseInputs({ revenue: null }));

    expect(await logCashWarning(s.profile_id, NOW, async () => tight(9000))).toBe(true);
    expect(await logCashWarning(s.profile_id, NOW, async () => tight(9000))).toBe(false);
    expect(await logCashWarning(s.profile_id, NOW, async () => refusal)).toBe(false);
    expect(await logCashWarning(s.profile_id, NOW, async () => fine)).toBe(true);
    expect(await logCashWarning(s.profile_id, NOW, async () => fine)).toBe(false);
    expect(
      await logCashWarning(s.profile_id, NOW, async () => {
        throw new Error("boom");
      }),
    ).toBe(false);

    const log = (await watchLog(s.profile_id)).filter((e) => e.kind === CASH_WARNING_KIND);
    expect(log).toHaveLength(2);
    expect(log.map((e) => e.detail)).toEqual([
      "Cash: no week of the next 13 dips under your €2,000 buffer at the cautious end any more.",
      expect.stringMatching(
        /^Money could get tight in the week of 29 Dec: .* VAT return \(€9,000, quarterly\)/,
      ),
    ]);
  });

  it("the morning look writes a tight week only when none stands; Monday says what moved or cleared", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const tightOn = (today: string): CashForecast =>
      forecastCash(
        baseInputs({
          today,
          revenue: daily(today, 120, () => 10_000),
          costs: [cost("Rent", 1200, "monthly"), cost("VAT return", 9000, "quarterly")],
        }),
      );
    const fine = forecastCash(baseInputs());
    const morning = { appearing_only: true };
    const tomorrow = addDays(TODAY, 1);
    const cashLines = async () =>
      (await watchLog(s.profile_id)).filter((e) => e.kind === CASH_WARNING_KIND).length;

    // Nothing stands: the morning look writes the warning the day it appears.
    expect(await logCashWarning(s.profile_id, NOW, async () => tightOn(TODAY), morning)).toBe(true);
    expect(await cashLines()).toBe(1);

    // A day on, the forecast's weeks start a day later, so the tight week "moved".
    // The weekly beat would log that; the morning look does not, or it would be a line a day.
    const next = new Date(`${tomorrow}T09:00:00Z`);
    expect(await logCashWarning(s.profile_id, next, async () => tightOn(tomorrow), morning)).toBe(
      false,
    );
    // Nor does it say a warning cleared: that is Monday's line.
    expect(await logCashWarning(s.profile_id, next, async () => fine, morning)).toBe(false);
    expect(await cashLines()).toBe(1);

    // Monday's beat counts its weeks from its own day. The week that stands,
    // counted from another day, has not moved, and is not said again.
    expect(await logCashWarning(s.profile_id, next, async () => tightOn(tomorrow))).toBe(false);
    expect(await cashLines()).toBe(1);
    // A tight week that now comes two months sooner has moved: Monday says so,
    // and says once that it cleared.
    const sooner = forecastCash(
      baseInputs({
        today: tomorrow,
        cash: { status: "known", fact: eur(500) },
        revenue: daily(tomorrow, 120, () => 10_000),
        costs: [cost("Rent", 1200, "monthly"), cost("VAT return", 9000, "quarterly")],
      }),
    );
    expect(await logCashWarning(s.profile_id, next, async () => sooner)).toBe(true);
    expect(await logCashWarning(s.profile_id, next, async () => fine)).toBe(true);
    expect(await cashLines()).toBe(3);

    // Cleared, nothing stands again: the next tight week is the morning look's to write.
    expect(await logCashWarning(s.profile_id, next, async () => tightOn(tomorrow), morning)).toBe(
      true,
    );
    expect(await cashLines()).toBe(4);
  });

  it("a fresh business with nothing tight logs nothing", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    expect(await logCashWarning(s.profile_id, NOW, async () => forecastCash(baseInputs()))).toBe(
      false,
    );
    expect(eur(1).amount_minor).toBe(100);
  });
});
