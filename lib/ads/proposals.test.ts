// P3-22a / P3-22c (generation side) — ad proposals from measured facts
// only. What must hold: a pause needs ROAS strictly below 1.0 over 14
// measured days; a raise needs ROAS at or above 3.0 over 28 days with 14
// measured; fewer than 14 measured days proposes nothing; a change beyond
// ±50% or over a stated ceiling is refused with the number named;
// proposals are deduped, limited, never executed, and never made while a
// business is being watched.

import "dotenv/config";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  fieldRecords,
  intakeEvents,
  metricObservations,
  modeDecisions,
  proposals,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { preboundPlan } from "../execution/due";
import { writeField } from "../profile/field-store";
import { bootstrapIntake } from "../intake/service";
import type { LimitLlm } from "../proposals/hard-limits";
import { shiftDay } from "../trust/series";
import type { CampaignSeries } from "./proposals";
import { ADS, adChangeFor, budgetGuard, proposeAdChanges } from "./proposals";

const TODAY = "2026-10-17";
const YESTERDAY = shiftDay(TODAY, -1);

/** n measured days ending yesterday, each spending `spend` and returning `value`. */
function series(n: number, spend: number, value: number, ref = "1"): CampaignSeries {
  return {
    campaign_ref: ref,
    campaign_name: `Campaign ${ref}`,
    currency: "EUR",
    days: Array.from({ length: n }, (_, i) => ({
      date: shiftDay(YESTERDAY, -i),
      spend_minor: spend,
      value_minor: value,
    })),
  };
}

describe("P3-22a — what the measured days call for", () => {
  it("pauses below 1.0 over 14 measured days — strictly below: 1.0 itself pays for itself", () => {
    expect(adChangeFor(series(14, 1_000, 990), TODAY)?.change).toBe("pause");
    expect(adChangeFor(series(14, 1_000, 1_000), TODAY)).toBeNull();
  });

  it("raises at 3.0 and above over 28 days — 2.99 is not enough", () => {
    expect(adChangeFor(series(20, 1_000, 3_000), TODAY)).toMatchObject({
      change: "raise_budget",
      share: ADS.raise_share,
    });
    expect(adChangeFor(series(20, 1_000, 2_990), TODAY)).toBeNull();
  });

  it("proposes nothing without 14 measured days behind it, however bad or good", () => {
    expect(adChangeFor(series(13, 1_000, 0), TODAY)).toBeNull();
    expect(adChangeFor(series(13, 1_000, 9_000), TODAY)).toBeNull();
  });

  it("days outside the window, or today's partial day, don't count", () => {
    const s = series(14, 1_000, 500);
    s.days.push({ date: TODAY, spend_minor: 99_999, value_minor: 0 }); // today: never whole
    const change = adChangeFor(s, TODAY);
    expect(change?.window.spend_minor).toBe(14_000);
  });
});

describe("P3-22c — guardrails at generation", () => {
  it("a change within ±50% passes; beyond it is refused, naming the number", () => {
    expect(budgetGuard({ share: 0.2, daily_spend_minor: 1_000, currency: "EUR" })).toBeNull();
    expect(budgetGuard({ share: 0.6, daily_spend_minor: 1_000, currency: "EUR" })).toBe(
      "a 60% change is beyond the 50% allowed in one approval",
    );
    expect(budgetGuard({ share: -0.6, daily_spend_minor: 1_000, currency: "EUR" })).toMatch(/-60%/);
  });

  it("a stated monthly ceiling refuses a raise that would cross it, with both figures", () => {
    // €10/day × 1.2 × 30 = €360/month, over a €300 ceiling.
    expect(
      budgetGuard({
        share: 0.2,
        daily_spend_minor: 1_000,
        currency: "EUR",
        monthly_ceiling_minor: 30_000,
      }),
    ).toMatch(/360.*over your stated ceiling of .*300/);
    expect(
      budgetGuard({
        share: 0.2,
        daily_spend_minor: 1_000,
        currency: "EUR",
        monthly_ceiling_minor: 40_000,
      }),
    ).toBeNull();
  });
});

/* ── end to end, against the database ── */

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
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

const NOW = new Date(`${TODAY}T08:00:00Z`);
const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });
const noPaidAds: LimitLlm = async () => ({
  text: JSON.stringify({ limits: [{ code: "no_paid_ads", quote: "we don't do paid ads" }] }),
  calls: [],
});

async function business(mode: "instant" | "watching" = "instant") {
  const s = await bootstrapIntake();
  created.push(s);
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode,
    watch_weeks: mode === "watching" ? 6 : null,
    inputs: {},
    reasoning: "fixture",
    confidence: "0.800",
    review_at: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
  });
  const [conn] = await db
    .insert(connections)
    .values({ account_id: s.account_id, provider: "meta_ads" })
    .returning({ id: connections.id });
  const campaign = async (
    ref: string,
    name: string,
    days: number,
    spend: number,
    value: number,
  ) => {
    const rows = [];
    for (let i = 1; i <= days; i++) {
      const date = shiftDay(TODAY, -i);
      for (const [metric, v] of [
        ["ad_spend.campaign.daily", spend],
        ["ad_purchase_value.campaign.daily", value],
      ] as const) {
        const dimensions = { campaign_ref: ref, campaign_name: name, currency: "EUR" };
        rows.push({
          connection_id: conn!.id,
          provider: "meta_ads",
          metric_key: metric,
          dimensions,
          dimension_key: JSON.stringify({ campaign_ref: ref, currency: "EUR" }),
          period_date: date,
          value_minor: v,
          currency: "EUR",
          observed_at: NOW.toISOString(),
        });
      }
    }
    await db.insert(metricObservations).values(rows);
  };
  return { ...s, campaign };
}

describe("P3-22a — proposeAdChanges", () => {
  it("a loss-maker gets a pause, a strong campaign a raise, a new one nothing — with the arithmetic, never pre-bound", async () => {
    const b = await business();
    await b.campaign("120000001", "Autumn menu", 14, 2_000, 1_200); // ROAS 0.6
    await b.campaign("120000002", "Brand", 20, 1_000, 3_500); // ROAS 3.5
    await b.campaign("120000003", "Launch", 10, 1_000, 0); // too new to judge

    const run = await proposeAdChanges(b.profile_id, { now: NOW, limitLlm: noLimits });
    expect(run.created.map((p) => (p.action as { kind: string }).kind).sort()).toEqual([
      "paid_ads_decrease_or_pause",
      "paid_ads_start_or_increase",
    ]);
    const pause = run.created.find(
      (p) => (p.action as { detail: { change: string } }).detail.change === "pause",
    )!;
    expect(pause.action).toMatchObject({
      summary: expect.stringContaining('Pause "Autumn menu"'),
      detail: {
        campaign_ref: "120000001",
        measured_days: 14,
        spend_minor: 28_000,
        value_minor: 16_800,
        currency: "EUR",
        roas: 0.6,
      },
    });
    expect(preboundPlan(pause)).toBeNull(); // nothing for the runner to execute yet
    expect(run.skipped.find((s) => s.ref === "120000003")?.reason).toMatch(
      /nothing the measured days/,
    );

    const again = await proposeAdChanges(b.profile_id, { now: NOW, limitLlm: noLimits });
    expect(again.created).toHaveLength(0);
  });

  it("a 'no paid ads' limit blocks the raise outright, and still lets a pause through", async () => {
    const b = await business();
    // Limits come from the owner's own stated boundaries (13.5), in their words.
    const at = isoDateTime(new Date().toISOString());
    await writeField(
      b.profile_id,
      createField<string>({
        id: fieldId("goals.owner_boundaries"),
        value: "We don't do paid ads.",
        status: "answered",
        confidence: confidence(0.8),
        source: { kind: "owner_input" },
        observed_at: at,
        recorded_at: at,
      }),
    );
    await b.campaign("220000001", "Loss", 14, 2_000, 1_000);
    await b.campaign("220000002", "Winner", 20, 1_000, 4_000);
    const run = await proposeAdChanges(b.profile_id, { now: NOW, limitLlm: noPaidAds });
    const status = (change: string) =>
      run.created.find((p) => (p.action as { detail: { change: string } }).detail.change === change)
        ?.status;
    expect(status("raise_budget")).toBe("blocked");
    expect(status("pause")).toBe("pending");
  });

  it("a business being watched gets nothing (rule 15)", async () => {
    const b = await business("watching");
    await b.campaign("320000001", "Loss", 14, 2_000, 0);
    const run = await proposeAdChanges(b.profile_id, { now: NOW, limitLlm: noLimits });
    expect(run.created).toHaveLength(0);
    expect(run.skipped[0]?.reason).toMatch(/still watching/);
  });
});
