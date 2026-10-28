// Feature 36 — the simulator against the database. What must hold: the
// inputs are read from the business's own records (and a gap stays a
// gap); "Propose this" makes the NORMAL proposal for the kind, pending,
// through that kind's own gates, with the simulated scenario on it — and
// executes nothing (rule 12): no execution row, and the only decision-log
// entry is the proposal's own.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  channels,
  connections,
  contacts,
  decisionLog,
  executions,
  fieldRecords,
  intakeEvents,
  metricObservations,
  modeDecisions,
  profileSnapshots,
  proposals,
} from "../../db/schema";
import { adsPlan } from "../ads/executing";
import { importContacts } from "../crm/import";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { proposalQueue } from "../proposals/service";
import { shiftDay } from "../trust/series";
import { crossCheckLine, gatherInputs } from "./inputs";
import { simulateOption } from "./model";
import { proposeFromSegments } from "../crm/segment-proposals";
import { proposeFromSimulation } from "./propose";
import type { SimulationRecord } from "./scenario";

const TODAY = "2026-10-22";
const NOW = new Date(`${TODAY}T09:00:00Z`);
const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });
const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const step = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch {
      // best effort: a row another table still points at stays, as in the other suites
    }
  };
  for (const s of created) {
    const conns = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    if (conns.length > 0) {
      await step(() =>
        db.delete(metricObservations).where(
          inArray(
            metricObservations.connection_id,
            conns.map((c) => c.id),
          ),
        ),
      );
    }
    await step(() => db.delete(connections).where(eq(connections.account_id, s.account_id)));
    await step(() => db.delete(contacts).where(eq(contacts.account_id, s.account_id)));
    await step(() => db.delete(proposals).where(eq(proposals.profile_id, s.profile_id)));
    await step(() => db.delete(modeDecisions).where(eq(modeDecisions.profile_id, s.profile_id)));
    await step(() =>
      db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, s.profile_id)),
    );
    await step(() => db.delete(intakeEvents).where(eq(intakeEvents.profile_id, s.profile_id)));
    await step(() => db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id)));
    await step(() => db.delete(channels).where(eq(channels.profile_id, s.profile_id)));
    await step(() => db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id)));
    await step(() => db.delete(accounts).where(eq(accounts.id, s.account_id)));
  }
});

async function owner(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
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

/** A business in care, with one measured Meta campaign, a stated margin and a social channel. */
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
  await db.update(accounts).set({ reporting_currency: "EUR" }).where(eq(accounts.id, s.account_id));
  await owner(s.profile_id, "costs.gross_margin", 40);
  const [ch] = await db
    .insert(channels)
    .values({ profile_id: s.profile_id })
    .returning({ id: channels.id });
  await owner(s.profile_id, `channels.${ch!.id}.type`, "social_organic");
  const [conn] = await db
    .insert(connections)
    .values({ account_id: s.account_id, provider: "meta_ads" })
    .returning({ id: connections.id });
  const rows = [];
  for (let i = 1; i <= 28; i++) {
    for (const [metric, v] of [
      ["ad_spend.campaign.daily", 1_000],
      ["ad_purchase_value.campaign.daily", 3_000],
    ] as const) {
      rows.push({
        connection_id: conn!.id,
        provider: "meta_ads",
        metric_key: metric,
        dimensions: { campaign_ref: "530000001", campaign_name: "Brand", currency: "EUR" },
        dimension_key: JSON.stringify({ campaign_ref: "530000001", currency: "EUR" }),
        period_date: shiftDay(TODAY, -i),
        value_minor: v,
        currency: "EUR",
        observed_at: NOW.toISOString(),
      });
    }
  }
  await db.insert(metricObservations).values(rows);
  return s;
}

const RAISE = { kind: "ads", change: "raise", campaign_ref: "530000001", share: 0.2 } as const;

async function nothingExecuted(proposalId: string) {
  expect(await db.select().from(executions).where(eq(executions.proposal_id, proposalId))).toEqual(
    [],
  );
  const log = await db.select().from(decisionLog).where(eq(decisionLog.ref_id, proposalId));
  expect(log.map((l) => l.kind)).toEqual(["proposal"]);
}

describe("the inputs, from the business's own records", () => {
  it("reads the campaign, the stated margin and the channel — and leaves what isn't there missing", async () => {
    const b = await business();
    const x = await gatherInputs(b.profile_id, NOW);
    expect(x.currency).toBe("EUR");
    expect(x.margin.stated_pct).toBe(40);
    expect(x.margin.stated_basis).toBe("STATED");
    expect(x.ads.connected).toBe(true);
    expect(x.ads.campaigns).toHaveLength(1);
    expect(x.ads.campaigns[0]!.days).toHaveLength(28);
    expect(x.content.social_channels).toBe(1);
    expect(x.email.past).toEqual([]);
    expect(x.cross_check.ads.line).toMatch(/^Not measured yet/);

    // Nothing measured on the site and no customer list: missing, never a number.
    const content = simulateOption({ kind: "content" }, x);
    expect(content.measures.orders.status).toBe("missing");
    const email = simulateOption({ kind: "email", segment: "lapsed" }, x);
    expect(email.measures.revenue.status).toBe("missing");
    expect(email.proposable.ok).toBe(false);
  });
});

describe('"Propose this" — the normal proposal, pending, executing nothing', () => {
  it("a raise goes through the ads path with the simulated scenario attached", async () => {
    const b = await business();
    const out = await proposeFromSimulation(b.profile_id, RAISE, { now: NOW, limitLlm: noLimits });
    expect(out.skipped).toBeNull();
    expect(out.proposal?.status).toBe("pending");
    const [row] = await db.select().from(proposals).where(eq(proposals.id, out.proposal!.id));
    expect(row!.module).toBe("ads");
    expect(row!.requires_approval).toBe(true);
    expect(row!.action).toMatchObject({
      kind: "paid_ads_start_or_increase",
      detail: { change: "raise_budget", share: 0.2, campaign_ref: "530000001" },
    });
    const scenario = row!.scenario as {
      downside_case: { profit_delta_monthly: { amount_minor: number; currency: string } | null };
      upside_case: { profit_delta_monthly: { amount_minor: number; currency: string } | null };
      simulation: SimulationRecord;
    };
    // €10/day × 20% × 28 = €56 more; × ROAS 3 × 40% − €56 = €11.20.
    expect(scenario.downside_case.profit_delta_monthly).toEqual({
      amount_minor: 1_120,
      currency: "EUR",
    });
    expect(Number.isSafeInteger(scenario.upside_case.profit_delta_monthly!.amount_minor)).toBe(
      true,
    );
    expect(scenario.simulation).toMatchObject({
      version: 1,
      as_of: TODAY,
      option: RAISE,
      key_rate: { name: "roas", range: { low: 3, high: 3 } },
    });
    // The runner would route it as the generator's own (P3-22b) — once a human approves it.
    expect(adsPlan(row!)).toMatchObject({ plan: { op: "set_daily_budget" } });
    await nothingExecuted(row!.id);
    expect((await proposalQueue(b.profile_id)).pending.map((p) => p.id)).toContain(row!.id);

    // The path's own dedupe still holds.
    const again = await proposeFromSimulation(b.profile_id, RAISE, {
      now: NOW,
      limitLlm: noLimits,
    });
    expect(again.proposal).toBeNull();
    expect(again.skipped).toBe("already proposed this month");
  });

  it("a win-back goes through the segment path — that segment only — behind the consent gate", async () => {
    const b = await business();
    await owner(b.profile_id, "customers.marketing_consent_status", "explicit_consent");
    await importContacts(
      b.account_id,
      [
        "email,name,last order date,orders,total spent",
        "l1@example.com,L1,2026-01-10,2,80",
        "l2@example.com,L2,2025-12-01,1,40",
        "v1@example.com,V1,2026-10-01,5,500",
      ].join("\n"),
      { status: "explicit_consent", statement: "checkout checkbox" },
      { currency: "EUR" },
    );
    const out = await proposeFromSimulation(
      b.profile_id,
      { kind: "email", segment: "lapsed" },
      { now: NOW, limitLlm: noLimits },
    );
    expect(out.proposal?.status).toBe("pending");
    const rows = await db.select().from(proposals).where(eq(proposals.profile_id, b.profile_id));
    // Only the segment asked for: the thank-you is not proposed alongside it.
    expect(rows.map((r) => r.originating_finding)).toEqual(["crm:winback:2026-10"]);
    const scenario = rows[0]!.scenario as { simulation: SimulationRecord };
    // No past campaign: the bought-again rate is a named gap, not a number.
    expect(scenario.simulation.measures.orders).toBeUndefined();
    expect(scenario.simulation.missing.join(" ")).toMatch(
      /Bought again after it: one sent win-back/,
    );
    expect(JSON.stringify(rows[0]!.scenario)).not.toContain("@example.com");
    await nothingExecuted(rows[0]!.id);
  });

  it("a cut carries a negative share, routed as a lower budget", async () => {
    const b = await business();
    const out = await proposeFromSimulation(
      b.profile_id,
      { kind: "ads", change: "lower", campaign_ref: "530000001", share: 0.3 },
      { now: NOW, limitLlm: noLimits },
    );
    const [row] = await db.select().from(proposals).where(eq(proposals.id, out.proposal!.id));
    expect(row!.action).toMatchObject({
      kind: "paid_ads_decrease_or_pause",
      detail: { change: "lower_budget", share: -0.3 },
    });
    expect(adsPlan(row!)).toMatchObject({ plan: { params: { share: -0.3 } } });
    await nothingExecuted(row!.id);
  });

  it("a content calendar goes through the content path, four weeks, with the simulation", async () => {
    const b = await business();
    const out = await proposeFromSimulation(
      b.profile_id,
      { kind: "content" },
      { now: NOW, limitLlm: noLimits },
    );
    expect(out.proposal?.status).toBe("pending");
    const [row] = await db.select().from(proposals).where(eq(proposals.id, out.proposal!.id));
    expect(row!.module).toBe("content");
    expect((row!.action as { summary: string }).summary).toMatch(/^A 4-week content calendar/);
    const scenario = row!.scenario as {
      simulation: SimulationRecord;
      base_case: { statement: string };
    };
    expect(scenario.simulation.missing.join(" ")).toMatch(/Reach per post/);
    expect(scenario.base_case.statement).toMatch(/Not worked out/);
    await nothingExecuted(row!.id);
  });

  it("a new campaign, or a watched business, proposes nothing and says why", async () => {
    const b = await business();
    const fresh = await proposeFromSimulation(
      b.profile_id,
      { kind: "ads", change: "new", daily_budget_minor: 1_000, currency: "EUR" },
      { now: NOW, limitLlm: noLimits },
    );
    expect(fresh.proposal).toBeNull();
    expect(fresh.skipped).toMatch(/Run this as an ad/);

    const watched = await business("watching");
    const out = await proposeFromSimulation(watched.profile_id, RAISE, {
      now: NOW,
      limitLlm: noLimits,
    });
    expect(out.proposal).toBeNull();
    expect(out.skipped).toMatch(/I'm watching until/);
    expect(
      await db.select().from(proposals).where(eq(proposals.profile_id, watched.profile_id)),
    ).toEqual([]);
  });

  it("the content and email paths respect the watch too (review 2026-10-23, #21)", async () => {
    const watched = await business("watching");
    const out = await proposeFromSimulation(
      watched.profile_id,
      { kind: "content" },
      { now: NOW, limitLlm: noLimits },
    );
    expect(out.proposal).toBeNull();
    expect(out.skipped).toMatch(/I'm watching until/);
    // The segment generator itself, before any segment is even read.
    const segments = await proposeFromSegments(watched.profile_id, {
      now: NOW,
      limitLlm: noLimits,
    });
    expect(segments.created).toEqual([]);
    expect(segments.skipped[0]?.reason).toMatch(/I'm watching until/);
    expect(
      await db.select().from(proposals).where(eq(proposals.profile_id, watched.profile_id)),
    ).toEqual([]);
  });

  it("proposing the same content calendar twice queues one (review 2026-10-23, #21)", async () => {
    const b = await business();
    const first = await proposeFromSimulation(
      b.profile_id,
      { kind: "content" },
      { now: NOW, limitLlm: noLimits },
    );
    expect(first.proposal?.status).toBe("pending");
    const second = await proposeFromSimulation(
      b.profile_id,
      { kind: "content" },
      { now: NOW, limitLlm: noLimits },
    );
    expect(second.proposal).toBeNull();
    expect(second.skipped).toMatch(/already waiting in your queue/);
    const rows = await db.select().from(proposals).where(eq(proposals.profile_id, b.profile_id));
    expect(rows.filter((r) => r.module === "content")).toHaveLength(1);
  });
});

describe("the cross-check sentence", () => {
  it("says not measured yet until a simulated proposal has been read back, then counts", () => {
    expect(
      crossCheckLine({ noun: "email campaigns", simulated: 0, checked: 0, inside: 0 }).line,
    ).toBe("Not measured yet: none of my past email campaigns carried a predicted range to check.");
    expect(
      crossCheckLine({ noun: "email campaigns", simulated: 2, checked: 0, inside: 0 }).line,
    ).toMatch(
      /^Not measured yet: my last 2 email campaigns with a predicted range haven't been read back yet/,
    );
    expect(
      crossCheckLine({ noun: "email campaigns", simulated: 3, checked: 3, inside: 2 }).line,
    ).toBe("My last 3 email campaigns landed inside their predicted range 2 times.");
    expect(crossCheckLine({ noun: "ad changes", simulated: 1, checked: 1, inside: 0 }).line).toBe(
      "My last ad change landed outside its predicted range.",
    );
    expect(
      crossCheckLine({
        noun: "ad changes",
        simulated: 0,
        checked: 0,
        inside: 0,
        verdicts: { helped: 1, did_nothing: 2, backfired: 0 },
      }).line,
    ).toMatch(/The readback so far: 1 helped, 2 did nothing, 0 backfired\.$/);
  });
});
