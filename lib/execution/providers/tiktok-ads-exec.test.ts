// TikTok Ads — the act side, end to end through the generator, the engine
// and the due runner, against a recorded-shape fake Marketing API
// (lib/tiktok/fake.ts). No real network: the global fetch fails the test if
// it is ever touched, and every assertion about what was sent reads the
// fake's own call log.
//
// What these tests hold, each with a passing and a failing case:
//
//   · THE ROUTE. A TikTok proposal (detail.platform "tiktok") becomes a
//     tiktok_ads op from the approved row; a create or a go-live on TikTok,
//     or a change in the wrong direction, stays unroutable.
//   · THE GENERATOR. Fourteen loss-making measured days on a TikTok campaign
//     propose a pause, tagged tiktok; thirteen propose nothing.
//   · THE REAL-WRITE GATE. Off: the approved change is refused by name and
//     nothing is sent, not even a read. On: it executes.
//   · THE OPS AND UNDO. Pause sends DISABLE and undoes to ENABLE; a budget
//     raise is from the captured budget, in whole forints for HUF, and
//     undoes to the previous budget. An owner's later change stands.
//   · THE GUARDRAILS, again inside the executor: ±50%, TikTok's floor, the
//     owner's ceiling, a campaign outside the connected ad accounts, a
//     lifetime budget, a deleted campaign.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../../db";
import {
  accounts,
  businessProfiles,
  connections,
  executionAttempts,
  executions,
  fieldRecords,
  intakeEvents,
  metricObservations,
  modeDecisions,
  proposals,
  users,
  watchActivity,
} from "../../../db/schema";
import { adsPlan, dbTikTokAdsBackend } from "../../ads/executing";
import { proposeAdChanges } from "../../ads/proposals";
import { upsertObservations } from "../../connectors/service";
import { confidence } from "../../core/confidence";
import { createField } from "../../core/field";
import { fieldId } from "../../core/ids";
import { isoDateTime } from "../../core/iso";
import { bootstrapIntake } from "../../intake/service";
import { writeField } from "../../profile/field-store";
import type { LimitLlm } from "../../proposals/hard-limits";
import { approveProposal, createProposal } from "../../proposals/service";
import { fakeTikTok } from "../../tiktok/fake";
import { shiftDay } from "../../trust/series";
import { connectForExecution, expectedExecutionScopes } from "../connections";
import { runDueExecutions } from "../due";
import { undoExecution } from "../engine";
import { createTikTokAdsExecutor } from "./tiktok-ads";

const ADV = "7000000000001";
const OTHER_ADV = "7000000000009";
const CAMPAIGN = "1700000000001";
const noSleep = async () => undefined;
const TODAY = new Date().toISOString().slice(0, 10);

const realFetchUsed = vi.fn(async () => {
  throw new Error("a real fetch was attempted in a TikTok test");
});
const gateBefore = process.env.SESSION_D_REAL_WRITES;
const gate = (on: boolean) => {
  if (on) process.env.SESSION_D_REAL_WRITES = "on";
  else delete process.env.SESSION_D_REAL_WRITES;
};
beforeAll(() => {
  vi.stubGlobal("fetch", realFetchUsed);
});
beforeEach(() => gate(true));

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  expect(realFetchUsed).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  if (gateBefore === undefined) delete process.env.SESSION_D_REAL_WRITES;
  else process.env.SESSION_D_REAL_WRITES = gateBefore;
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  await db.delete(watchActivity).where(inArray(watchActivity.profile_id, ids));
  const runs = await db
    .select({ id: executions.id })
    .from(executions)
    .where(inArray(executions.profile_id, ids));
  if (runs.length > 0) {
    await db.delete(executionAttempts).where(
      inArray(
        executionAttempts.execution_id,
        runs.map((r) => r.id),
      ),
    );
  }
  await db.delete(executions).where(inArray(executions.profile_id, ids));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
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
  }
  await db.delete(connections).where(inArray(connections.account_id, accountIds));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

const scenario = {
  assumptions: [],
  base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — fixture",
} as never;

const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

async function business(advertisers: string[] = [ADV]) {
  const s = await bootstrapIntake();
  created.push(s);
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: "instant",
    watch_weeks: null,
    inputs: { reasons: ["test fixture"] },
    reasoning: "test fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 42 * 86_400_000).toISOString(),
  });
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `tiktok-${crypto.randomUUID()}@test.local`,
      display_name: "TikTok owner",
      role: "owner",
    })
    .returning({ id: users.id });
  const conn = await connectForExecution({
    accountId: s.account_id,
    provider: "tiktok_ads",
    secret: JSON.stringify({
      v: 1,
      access_token: "tt-fake-long-term-token",
      advertiser_ids: advertisers,
      scope_ids: [100, 200, 201, 44],
    }),
    verify: async () => ({ granted_scopes: expectedExecutionScopes("tiktok_ads") }),
  });
  return { ...s, user_id: u!.id, connection_id: conn.id };
}

type Biz = Awaited<ReturnType<typeof business>>;

async function tiktokProposal(b: Biz, detail: Record<string, unknown>) {
  const change = detail["change"];
  const p = await createProposal({
    profile_id: b.profile_id,
    module: "ads",
    originating_finding: `ads:tiktok:test:${crypto.randomUUID()}`,
    action: {
      kind:
        change === "pause" || change === "lower_budget"
          ? "paid_ads_decrease_or_pause"
          : "paid_ads_start_or_increase",
      summary: `Test ${String(change)}`,
      detail: { execute_on_approval: true, platform: "tiktok", ...detail },
    },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: "fixture" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await approveProposal({ proposalId: p.id, userId: b.user_id, profileId: b.profile_id });
  return p.id;
}

function harness(advertisers: Record<string, string> = { [ADV]: "EUR" }) {
  const tt = fakeTikTok({ advertisers });
  const exec = createTikTokAdsExecutor({
    fetch: tt.fetch,
    sleep: noSleep,
    backend: dbTikTokAdsBackend(),
  });
  const run = (b: Biz) =>
    runDueExecutions({ profileId: b.profile_id, sleep: noSleep, providers: { tiktok_ads: exec } });
  const campaign = (id: string, c: Partial<Parameters<typeof tt.campaigns.set>[1]> = {}) =>
    tt.campaigns.set(id, {
      advertiser_id: ADV,
      campaign_name: "Autumn menu",
      operation_status: "ENABLE",
      budget_mode: "BUDGET_MODE_DAY",
      budget: 100,
      ...c,
    });
  return { tt, exec, run, campaign };
}

const executionFor = async (proposalId: string) =>
  (await db.select().from(executions).where(eq(executions.proposal_id, proposalId)))[0];
const proposalRow = async (id: string) =>
  (await db.select().from(proposals).where(eq(proposals.id, id)))[0]!;

async function setCeiling(profileId: string, amount_minor: number, currency: string) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<{ amount_minor: number; currency: string }>({
      id: fieldId("marketing.monthly_ad_ceiling"),
      value: { amount_minor, currency },
      status: "answered",
      confidence: confidence(0.8),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

/* ── the route ── */

describe("TikTok Ads — adsPlan routes a TikTok proposal to the tiktok_ads executor", () => {
  const row = (kind: string, detail: Record<string, unknown>) => ({
    module: "ads",
    action: { kind, summary: "s", detail },
  });

  it("maps pause, resume and a budget change, from the row's own detail", () => {
    expect(
      adsPlan(
        row("paid_ads_decrease_or_pause", {
          platform: "tiktok",
          change: "pause",
          campaign_ref: CAMPAIGN,
        }),
      ),
    ).toEqual({
      plan: { provider: "tiktok_ads", op: "pause_campaign", params: { campaign_id: CAMPAIGN } },
    });
    expect(
      adsPlan(
        row("paid_ads_start_or_increase", {
          platform: "tiktok",
          change: "resume",
          campaign_ref: CAMPAIGN,
        }),
      ),
    ).toMatchObject({
      plan: { provider: "tiktok_ads", op: "resume_campaign" },
    });
    expect(
      adsPlan(
        row("paid_ads_start_or_increase", {
          platform: "tiktok",
          change: "raise_budget",
          campaign_ref: CAMPAIGN,
          share: 0.2,
          currency: "EUR",
        }),
      ),
    ).toEqual({
      plan: {
        provider: "tiktok_ads",
        op: "set_daily_budget",
        params: { campaign_id: CAMPAIGN, share: 0.2, currency: "EUR" },
      },
    });
    // A Meta proposal (no platform) still goes to Meta.
    expect(
      adsPlan(row("paid_ads_decrease_or_pause", { change: "pause", campaign_ref: "120000001" })),
    ).toMatchObject({
      plan: { provider: "meta_ads" },
    });
  });

  it("leaves unroutable what ScaleX doesn't do on TikTok, or doesn't add up", () => {
    for (const d of [
      { platform: "tiktok", change: "create_paused", name: "x" },
      { platform: "tiktok", change: "run_ad", ad: {} },
      {
        platform: "tiktok",
        change: "raise_budget",
        campaign_ref: CAMPAIGN,
        share: -0.2,
        currency: "EUR",
      },
      { platform: "tiktok", change: "pause", campaign_ref: "act_1" },
      { platform: "snapchat", change: "pause", campaign_ref: CAMPAIGN },
    ]) {
      const kind =
        d.change === "pause" ? "paid_ads_decrease_or_pause" : "paid_ads_start_or_increase";
      expect(adsPlan(row(kind, d)), JSON.stringify(d)).toHaveProperty("unroutable");
    }
  });
});

/* ── the generator, the gate, the ops ── */

async function seedDays(b: Biz, n: number, spendMinor: number, valueMinor: number) {
  const obs = [];
  for (let i = 1; i <= n; i++) {
    const day = shiftDay(TODAY, -i);
    const dims = { currency: "EUR", campaign_ref: CAMPAIGN, campaign_name: "Autumn menu" };
    obs.push(
      {
        metric_key: "ad_spend.campaign.daily" as const,
        period_date: day,
        dimensions: dims,
        value_minor: spendMinor,
        observed_at: new Date().toISOString(),
      },
      {
        metric_key: "ad_purchase_value.campaign.daily" as const,
        period_date: day,
        dimensions: dims,
        value_minor: valueMinor,
        observed_at: new Date().toISOString(),
      },
    );
  }
  await upsertObservations(b.connection_id, "tiktok_ads", obs);
}

describe("TikTok Ads — a pause from measured days, through the gate, and back", () => {
  it("13 loss-making days propose nothing; 14 propose a pause tagged tiktok", async () => {
    const b = await business();
    await seedDays(b, 13, 2000, 1000);
    expect((await proposeAdChanges(b.profile_id, { limitLlm: noLimits })).created).toHaveLength(0);
    await seedDays(b, 14, 2000, 1000);
    const out = await proposeAdChanges(b.profile_id, { limitLlm: noLimits });
    expect(out.created).toHaveLength(1);
    const detail = (out.created[0]!.action as { detail: Record<string, unknown> }).detail;
    expect(detail).toMatchObject({
      platform: "tiktok",
      change: "pause",
      campaign_ref: CAMPAIGN,
      currency: "EUR",
    });
    expect(String(detail["attribution"])).toContain("TikTok");
    expect(out.created[0]!.originating_finding).toMatch(/^ads:tiktok:1700000000001:pause:/);
  });

  it("gate off: refused by name, nothing sent, still approved; gate on: DISABLE, then undo to ENABLE", async () => {
    const b = await business();
    const h = harness();
    h.campaign(CAMPAIGN);
    const id = await tiktokProposal(b, { change: "pause", campaign_ref: CAMPAIGN });

    gate(false);
    const off = await h.run(b);
    expect(off.outcomes[0]).toMatchObject({ result: "refused" });
    expect(String(off.outcomes[0]?.detail ?? "")).toMatch(/TikTok ad management is switched off/);
    expect(h.tt.calls).toEqual([]);
    expect((await proposalRow(id)).status).toBe("approved");

    gate(true);
    const on = await h.run(b);
    expect(on.outcomes[0]).toMatchObject({ result: "executed" });
    expect(h.tt.campaigns.get(CAMPAIGN)?.operation_status).toBe("DISABLE");
    const writes = h.tt.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({
      advertiser_id: ADV,
      campaign_ids: [CAMPAIGN],
      operation_status: "DISABLE",
    });

    const ex = await executionFor(id);
    await undoExecution({ executionId: ex!.id, provider: h.exec, userId: b.user_id });
    expect(h.tt.campaigns.get(CAMPAIGN)?.operation_status).toBe("ENABLE");
    expect(h.tt.writes().every((c) => c.body?.["operation_status"] !== "DELETE")).toBe(true);
  });

  it("an undo leaves the owner's own later change standing", async () => {
    const b = await business();
    const h = harness();
    h.campaign(CAMPAIGN);
    const id = await tiktokProposal(b, { change: "pause", campaign_ref: CAMPAIGN });
    await h.run(b);
    // The owner turned it back on in Ads Manager, then off again by a rule: not SYB's DISABLE any more?
    h.tt.campaigns.get(CAMPAIGN)!.operation_status = "ENABLE";
    const ex = await executionFor(id);
    // Already what the undo would set: nothing to change, nothing sent.
    const before = h.tt.writes().length;
    await undoExecution({ executionId: ex!.id, provider: h.exec, userId: b.user_id });
    expect(h.tt.writes().length).toBe(before);
  });
});

describe("TikTok Ads — a budget raise, guarded inside the executor", () => {
  it("raises 20% from the captured budget, in whole forints, and undoes to the previous budget", async () => {
    const b = await business();
    const h = harness({ [ADV]: "HUF" });
    h.campaign(CAMPAIGN, { budget: 20_001 });
    const id = await tiktokProposal(b, {
      change: "raise_budget",
      campaign_ref: CAMPAIGN,
      share: 0.2,
      currency: "HUF",
    });
    const out = await h.run(b);
    expect(out.outcomes[0]).toMatchObject({ result: "executed" });
    const sent = h.tt.writes()[0]!.body!;
    expect(sent).toEqual({ advertiser_id: ADV, campaign_id: CAMPAIGN, budget: 24_001 });
    expect(Number.isInteger(sent["budget"])).toBe(true);
    const ex = await executionFor(id);
    await undoExecution({ executionId: ex!.id, provider: h.exec, userId: b.user_id });
    expect(h.tt.campaigns.get(CAMPAIGN)?.budget).toBe(20_001);
  });

  it("an undo leaves the owner's own later budget standing, and changes nothing", async () => {
    const b = await business();
    const h = harness();
    h.campaign(CAMPAIGN, { budget: 100 });
    const id = await tiktokProposal(b, {
      change: "raise_budget",
      campaign_ref: CAMPAIGN,
      share: 0.2,
      currency: "EUR",
    });
    await h.run(b);
    expect(h.tt.campaigns.get(CAMPAIGN)?.budget).toBe(120);
    h.tt.campaigns.get(CAMPAIGN)!.budget = 150; // the owner, in Ads Manager
    const before = h.tt.writes().length;
    const ex = await executionFor(id);
    await expect(
      undoExecution({ executionId: ex!.id, provider: h.exec, userId: b.user_id }),
    ).rejects.toThrow(/you've changed it since/);
    expect(h.tt.writes().length).toBe(before);
    expect(h.tt.campaigns.get(CAMPAIGN)?.budget).toBe(150);
  });

  it("refuses a change beyond ±50%, naming it; nothing is sent", async () => {
    const b = await business();
    const h = harness();
    h.campaign(CAMPAIGN);
    await tiktokProposal(b, {
      change: "raise_budget",
      campaign_ref: CAMPAIGN,
      share: 0.8,
      currency: "EUR",
    });
    const out = await h.run(b);
    expect(out.outcomes[0]?.result).not.toBe("executed");
    expect(String(out.outcomes[0]?.detail ?? "")).toMatch(/80% change is beyond the 50%/);
    expect(h.tt.writes()).toEqual([]);
  });

  it("refuses a cut under TikTok's campaign minimum, naming TikTok's number", async () => {
    const b = await business();
    const h = harness();
    h.campaign(CAMPAIGN, { budget: 60 });
    await tiktokProposal(b, {
      change: "lower_budget",
      campaign_ref: CAMPAIGN,
      share: -0.3,
      currency: "EUR",
    });
    const out = await h.run(b);
    expect(String(out.outcomes[0]?.detail ?? "")).toMatch(
      /under TikTok's minimum of €50\.00 a day/,
    );
    expect(h.tt.writes()).toEqual([]);
  });

  it("refuses a raise over the owner's monthly ceiling, naming both figures", async () => {
    const b = await business();
    await setCeiling(b.profile_id, 300_000, "EUR"); // €3,000 a month; the campaign alone is ~€3,000
    const h = harness();
    h.campaign(CAMPAIGN, { budget: 100 });
    await tiktokProposal(b, {
      change: "raise_budget",
      campaign_ref: CAMPAIGN,
      share: 0.2,
      currency: "EUR",
    });
    const out = await h.run(b);
    expect(String(out.outcomes[0]?.detail ?? "")).toMatch(/over your stated ceiling of €3,000\.00/);
    expect(h.tt.writes()).toEqual([]);
  });

  it("refuses a campaign with a lifetime budget, and one in an ad account it can't see", async () => {
    const b = await business();
    const h = harness();
    h.campaign(CAMPAIGN, { budget_mode: "BUDGET_MODE_TOTAL" });
    h.campaign("1700000000002", { advertiser_id: OTHER_ADV });
    await tiktokProposal(b, {
      change: "raise_budget",
      campaign_ref: CAMPAIGN,
      share: 0.2,
      currency: "EUR",
    });
    await tiktokProposal(b, { change: "pause", campaign_ref: "1700000000002" });
    const out = await h.run(b);
    const details = out.outcomes.map((o) => String(o.detail ?? ""));
    expect(details.some((d) => /BUDGET_MODE_TOTAL/.test(d))).toBe(true);
    expect(details.some((d) => /isn't in the connected TikTok ad accounts/.test(d))).toBe(true);
    expect(h.tt.writes()).toEqual([]);
  });

  it("never touches a deleted campaign", async () => {
    const b = await business();
    const h = harness();
    h.campaign(CAMPAIGN, {
      operation_status: "DISABLE",
      secondary_status: "CAMPAIGN_STATUS_DELETE",
    });
    await tiktokProposal(b, { change: "resume", campaign_ref: CAMPAIGN });
    const out = await h.run(b);
    expect(out.outcomes[0]?.result).not.toBe("executed");
    expect(h.tt.writes()).toEqual([]);
  });
});
