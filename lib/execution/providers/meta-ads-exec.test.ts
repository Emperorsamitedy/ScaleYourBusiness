// P3-22b/c/d — the ad executor, end to end through the engine and the due
// runner, against a recorded-shape fake Marketing API. No real network: the
// global fetch fails the test if it is ever touched, and every assertion
// about what was sent reads the fake's own call log.
//
// What these tests hold:
//
//   · THE REAL-WRITE GATE. Off by default: an approved ad change is refused
//     by name, nothing is sent (not even a read), the proposal stays
//     approved. On: it executes. The emergency stop still overrides it.
//   · THE OPS (P3-22b). Pause and resume set status=PAUSED|ACTIVE; a budget
//     change sets daily_budget from the budget captured before attempt one;
//     a create is PAUSED, AUCTION, with its objective and special ad
//     categories. Every write is preceded by the identical validate_only
//     call and refused on any validation error before anything changes.
//   · UNDO. To the previous status and the previous budget; a create stays
//     irreversible, labelled before approval, never discovered after.
//   · THE GUARDRAILS (P3-22c), again inside the executor: ±50%, the owner's
//     ceiling, Meta's floor — each refusal naming its number. A HUF budget
//     goes to Meta in whole forints.
//   · THE TIER (P3-22d). ads_api_access_tier read on every call, logged,
//     stored on the connection; usage near the hourly limit defers.

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
import { metaError } from "../../connectors/providers/meta-fake";
import { confidence } from "../../core/confidence";
import { createField } from "../../core/field";
import { fieldId } from "../../core/ids";
import { isoDateTime } from "../../core/iso";
import type { AD_KINDS } from "../../ads/executing";
import { adsPlan, dbAdsBackend } from "../../ads/executing";
import { proposeAdChanges } from "../../ads/proposals";
import { bootstrapIntake } from "../../intake/service";
import { writeField } from "../../profile/field-store";
import type { LimitLlm } from "../../proposals/hard-limits";
import { approveProposal, createProposal } from "../../proposals/service";
import { shiftDay } from "../../trust/series";
import {
  connectForExecution,
  expectedExecutionScopes,
  listExecutionConnections,
} from "../connections";
import { runDueExecutions } from "../due";
import {
  ExecutionRefused,
  executeProposal,
  haltExecutions,
  resumeExecutions,
  undoExecution,
} from "../engine";
import type { MetaExecFetch, MetaExecRequestInit, MetaExecResponse } from "./meta";
import { VALIDATE_ONLY, adsHourlyCallLimit, createMetaExecution } from "./meta";

const TOKEN = "EAAFakeAdsSystemUserTokenForTests";
const ACT = "2000000002";
const OTHER_ACT = "2000000009";
const V = "/v26.0";
const noSleep = async () => undefined;
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);

/* ── no real network, anywhere in this file ── */

const realFetchUsed = vi.fn(async () => {
  throw new Error("a real fetch was attempted in a P3-22 test");
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

/* ── the fake Marketing API ── */

interface Campaign {
  name: string;
  account_id: string;
  status: string;
  objective: string;
  daily_budget: number | null;
}

interface Call {
  method: string;
  url: URL;
  init: MetaExecRequestInit;
  form: URLSearchParams;
}

interface FakeOptions {
  currency?: string;
  /** The ad account's reported min_daily_budget, in Meta's unit. */
  minDailyBudget?: number;
  /** ads_api_access_tier on every response (null = no tier header). */
  tier?: string | null;
  /** call_count % in the ads_management usage entry. */
  usage?: number;
  /** The dry run refuses (code 100) whenever this says so. */
  rejectDryRun?: (call: Call) => boolean;
  /** The real write lands, then its answer is lost — this many times. */
  loseAnswers?: number;
  respond?: (call: Call) => MetaExecResponse | null;
}

function fakeAds(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  const campaigns = new Map<string, Campaign>();
  let n = 0;
  let lost = 0;
  const headers = (): Record<string, string> => ({
    "x-business-use-case-usage": JSON.stringify({
      "9000000001": [
        {
          type: "ads_management",
          call_count: opts.usage ?? 4,
          total_cputime: 1,
          total_time: 1,
          estimated_time_to_regain_access: 0,
          ...(opts.tier === null ? {} : { ads_api_access_tier: opts.tier ?? "development_access" }),
        },
      ],
    }),
  });
  const ok = (body: unknown): MetaExecResponse => {
    const h = headers();
    return { status: 200, json: async () => body, header: (name) => h[name] ?? null };
  };

  const fetch: MetaExecFetch = async (raw, init) => {
    const url = new URL(raw);
    const form = new URLSearchParams(init.body ?? "");
    const call: Call = { method: init.method, url, init, form };
    calls.push(call);
    const forced = opts.respond?.(call) ?? null;
    if (forced !== null) return forced;
    if (url.origin !== "https://graph.facebook.com") throw new Error(`not Meta: ${url.origin}`);
    if (init.headers["authorization"] !== `Bearer ${TOKEN}`) {
      return metaError(190, "Invalid OAuth access token");
    }
    const path = url.pathname;
    const dryRun = form.get("execution_options") === VALIDATE_ONLY;
    const loseOne = () => {
      if (!dryRun && lost < (opts.loseAnswers ?? 0)) {
        lost += 1;
        throw new Error("socket hang up after the write");
      }
    };

    if (init.method === "GET" && path === `${V}/act_${ACT}`) {
      return ok({
        id: `act_${ACT}`,
        currency: opts.currency ?? "EUR",
        ...(opts.minDailyBudget !== undefined ? { min_daily_budget: opts.minDailyBudget } : {}),
      });
    }
    if (init.method === "POST" && path === `${V}/act_${ACT}/campaigns`) {
      if (dryRun && opts.rejectDryRun?.(call)) return metaError(100, "Invalid parameter");
      if (dryRun) return ok({ success: true });
      const id = `12000${String(++n).padStart(5, "0")}`;
      campaigns.set(id, {
        name: form.get("name") ?? "",
        account_id: ACT,
        status: form.get("status") ?? "",
        objective: form.get("objective") ?? "",
        daily_budget: form.get("daily_budget") ? Number(form.get("daily_budget")) : null,
      });
      loseOne();
      return ok({ id });
    }
    const id = decodeURIComponent(path.slice(V.length + 1));
    const c = campaigns.get(id);
    if (c && init.method === "GET") {
      return ok({
        id,
        name: c.name,
        account_id: c.account_id,
        status: c.status,
        objective: c.objective,
        ...(c.daily_budget !== null ? { daily_budget: String(c.daily_budget) } : {}),
      });
    }
    if (c && init.method === "POST") {
      if (dryRun && opts.rejectDryRun?.(call)) {
        return metaError(100, "Invalid parameter", 1885272);
      }
      if (!dryRun) {
        if (form.has("status")) c.status = form.get("status")!;
        if (form.has("daily_budget")) c.daily_budget = Number(form.get("daily_budget"));
        loseOne();
      }
      return ok({ success: true });
    }
    return metaError(100, "Unsupported request. Object does not exist or missing permissions", 33);
  };

  const writes = () =>
    calls.filter((c) => c.method === "POST" && c.form.get("execution_options") !== VALIDATE_ONLY);
  const dryRuns = () =>
    calls.filter((c) => c.method === "POST" && c.form.get("execution_options") === VALIDATE_ONLY);
  return { fetch, calls, campaigns, writes, dryRuns };
}

/* ── a business with a connected Meta ad account ── */

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  expect(realFetchUsed).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  if (gateBefore === undefined) delete process.env.SESSION_D_REAL_WRITES;
  else process.env.SESSION_D_REAL_WRITES = gateBefore;
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  // The decision log is append-only (rule 7): its rows outlive the test.
  await db.delete(watchActivity).where(inArray(watchActivity.profile_id, ids));
  const rows = await db
    .select({ id: executions.id })
    .from(executions)
    .where(inArray(executions.profile_id, ids));
  if (rows.length > 0) {
    await db.delete(executionAttempts).where(
      inArray(
        executionAttempts.execution_id,
        rows.map((r) => r.id),
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

async function business() {
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
      email: `p3-22-${crypto.randomUUID()}@test.local`,
      display_name: "P3-22 owner",
      role: "owner",
    })
    .returning({ id: users.id });
  await connectForExecution({
    accountId: s.account_id,
    provider: "meta_ads",
    secret: JSON.stringify({ access_token: TOKEN, ad_account_id: `act_${ACT}` }),
    verify: async () => ({ granted_scopes: expectedExecutionScopes("meta_ads") }),
  });
  return { ...s, user_id: u!.id };
}

type Biz = Awaited<ReturnType<typeof business>>;

/** An ad proposal as the generator shapes it, approved without a time (it runs on approval). */
async function adProposal(
  b: Biz,
  detail: Record<string, unknown>,
  opts: {
    kind?: (typeof AD_KINDS)[number];
    level?: "easy" | "moderate" | "hard";
    approve?: boolean;
  } = {},
) {
  const change = detail["change"];
  const kind =
    opts.kind ??
    (change === "pause" || change === "lower_budget"
      ? "paid_ads_decrease_or_pause"
      : "paid_ads_start_or_increase");
  const p = await createProposal({
    profile_id: b.profile_id,
    module: "ads",
    originating_finding: `ads:test:${crypto.randomUUID()}`,
    action: {
      kind,
      summary: `Test ${String(change)}`,
      detail: { execute_on_approval: true, ...detail },
    },
    scenario,
    reversibility: {
      level: opts.level ?? "easy",
      if_you_change_your_mind: "fixture",
    },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  if (opts.approve !== false) {
    await approveProposal({ proposalId: p.id, userId: b.user_id, profileId: b.profile_id });
  }
  return p.id;
}

function harness(opts: FakeOptions = {}) {
  const graph = fakeAds(opts);
  const exec = createMetaExecution({
    fetch: graph.fetch,
    sleep: noSleep,
    adsBackend: dbAdsBackend(),
  });
  const run = (b: Biz) =>
    runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { meta_ads: exec.ads },
    });
  const campaign = (id: string, c: Partial<Campaign> = {}) =>
    graph.campaigns.set(id, {
      name: "Autumn menu",
      account_id: ACT,
      status: "ACTIVE",
      objective: "OUTCOME_SALES",
      daily_budget: 1_000,
      ...c,
    });
  return { graph, exec, run, campaign };
}

const proposalRow = async (id: string) =>
  (await db.select().from(proposals).where(eq(proposals.id, id)))[0]!;
const executionFor = async (proposalId: string) =>
  (await db.select().from(executions).where(eq(executions.proposal_id, proposalId)))[0];
const watchLines = async (profileId: string) =>
  (
    await db
      .select({ detail: watchActivity.detail })
      .from(watchActivity)
      .where(eq(watchActivity.profile_id, profileId))
  ).map((r) => r.detail);

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

/* ── the route: from the approved row, never a client ── */

describe("P3-22b — adsPlan, the due runner's route for an ad proposal", () => {
  const row = (kind: string, detail: Record<string, unknown>) => ({
    module: "ads",
    action: { kind, summary: "s", detail },
  });

  it("maps each change to its op, from the proposal's own detail", () => {
    expect(
      adsPlan(row("paid_ads_decrease_or_pause", { change: "pause", campaign_ref: "120000001" })),
    ).toEqual({
      plan: { provider: "meta_ads", op: "pause_campaign", params: { campaign_id: "120000001" } },
    });
    expect(
      adsPlan(row("paid_ads_start_or_increase", { change: "resume", campaign_ref: "120000001" })),
    ).toMatchObject({ plan: { op: "resume_campaign" } });
    expect(
      adsPlan(
        row("paid_ads_start_or_increase", {
          change: "raise_budget",
          campaign_ref: "120000001",
          share: 0.2,
          currency: "EUR",
        }),
      ),
    ).toEqual({
      plan: {
        provider: "meta_ads",
        op: "set_daily_budget",
        params: { campaign_id: "120000001", share: 0.2, currency: "EUR" },
      },
    });
    expect(
      adsPlan(
        row("paid_ads_start_or_increase", {
          change: "create_paused",
          name: "Winter",
          objective: "OUTCOME_TRAFFIC",
          special_ad_categories: [],
        }),
      ),
    ).toMatchObject({ plan: { op: "create_campaign_paused" } });
  });

  it("refuses to guess: no campaign, a change under the wrong kind, a raise that lowers, no currency", () => {
    const unroutable = (r: ReturnType<typeof adsPlan>) => ("unroutable" in r ? r.unroutable : null);
    expect(unroutable(adsPlan(row("paid_ads_decrease_or_pause", { change: "pause" })))).toMatch(
      /names no Meta campaign/,
    );
    expect(
      unroutable(
        adsPlan(row("paid_ads_start_or_increase", { change: "pause", campaign_ref: "120000001" })),
      ),
    ).toMatch(/doesn't add up/);
    expect(
      unroutable(
        adsPlan(
          row("paid_ads_start_or_increase", {
            change: "raise_budget",
            campaign_ref: "120000001",
            share: -0.2,
            currency: "EUR",
          }),
        ),
      ),
    ).toMatch(/right direction/);
    expect(
      unroutable(
        adsPlan(
          row("paid_ads_start_or_increase", {
            change: "raise_budget",
            campaign_ref: "120000001",
            share: 0.2,
          }),
        ),
      ),
    ).toMatch(/no currency/);
    expect(unroutable(adsPlan(row("paid_ads_start_or_increase", { change: "delete" })))).toMatch(
      /no ad op makes a "delete" change/,
    );
    expect(unroutable(adsPlan({ module: "content", action: {} }))).toBe("not an ad proposal");
  });
});

/* ── the gate ── */

describe("THE REAL-WRITE GATE covers the ad ops", () => {
  it("off: refused by name, nothing sent, still approved; on: executed", async () => {
    const b = await business();
    const { graph, run, campaign } = harness();
    campaign("120000001");
    const id = await adProposal(b, { change: "pause", campaign_ref: "120000001" });

    gate(false);
    const off = await run(b);
    expect(off.refused).toBe(1);
    expect(off.outcomes[0]?.detail).toMatch(
      /^real_writes_off: Meta ad management is switched off until the two-week unattended test completes\. Nothing was sent; this stays approved/,
    );
    expect(graph.calls).toHaveLength(0); // not even a read
    expect((await proposalRow(id)).status).toBe("approved");
    expect(await executionFor(id)).toBeUndefined();

    gate(true);
    const on = await run(b);
    expect(on.executed).toBe(1);
    expect(graph.campaigns.get("120000001")?.status).toBe("PAUSED");
    expect((await proposalRow(id)).status).toBe("executed");
  });

  it("the emergency stop overrides an open gate", async () => {
    const b = await business();
    const { graph, run, campaign } = harness();
    campaign("120000002");
    await adProposal(b, { change: "pause", campaign_ref: "120000002" });
    await haltExecutions({ accountId: b.account_id, reason: "test" });
    expect((await run(b)).halted).toBe(1);
    expect(graph.calls).toHaveLength(0);
    await resumeExecutions(b.account_id);
    expect((await run(b)).executed).toBe(1);
  });

  it("an ad proposal approved without a time is scheduled for now; nothing else is (carriedSchedule)", async () => {
    const b = await business();
    const id = await adProposal(b, { change: "pause", campaign_ref: "120000003" });
    expect((await proposalRow(id)).execute_not_before).not.toBeNull();
    const plain = await createProposal({
      profile_id: b.profile_id,
      module: "ads",
      action: { kind: "paid_ads_decrease_or_pause", summary: "s", detail: {} },
      scenario,
      reversibility: { level: "easy", if_you_change_your_mind: "x" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await approveProposal({ proposalId: plain.id, userId: b.user_id, profileId: b.profile_id });
    expect((await proposalRow(plain.id)).execute_not_before).toBeNull();
  });
});

/* ── D3's done-when, clause one: generated, executed, undone ── */

describe("P3-22b — pause, from 14 seeded loss-making days, and undo to ACTIVE", () => {
  it("generated → approved → dry run → PAUSED → undone to ACTIVE, each step on the watch log", async () => {
    const b = await business();
    // The read side: a measure connection with 14 loss-making days for campaign 120000010.
    const [measure] = await db
      .insert(connections)
      .values({ account_id: b.account_id, provider: "meta_ads" })
      .returning({ id: connections.id });
    const rows = [];
    for (let i = 1; i <= 14; i++) {
      for (const [metric, v] of [
        ["ad_spend.campaign.daily", 2_000],
        ["ad_purchase_value.campaign.daily", 1_000],
      ] as const) {
        rows.push({
          connection_id: measure!.id,
          provider: "meta_ads",
          metric_key: metric,
          dimensions: { campaign_ref: "120000010", campaign_name: "Autumn menu", currency: "EUR" },
          dimension_key: JSON.stringify({ campaign_ref: "120000010", currency: "EUR" }),
          period_date: shiftDay(TODAY, -i),
          value_minor: v,
          currency: "EUR",
          observed_at: NOW.toISOString(),
        });
      }
    }
    await db.insert(metricObservations).values(rows);
    const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });
    const generated = await proposeAdChanges(b.profile_id, { now: NOW, limitLlm: noLimits });
    expect(generated.created).toHaveLength(1);
    const proposal = generated.created[0]!;
    expect(proposal.action).toMatchObject({
      kind: "paid_ads_decrease_or_pause",
      detail: { change: "pause", campaign_ref: "120000010", execute_on_approval: true },
    });
    await approveProposal({ proposalId: proposal.id, userId: b.user_id, profileId: b.profile_id });

    const { graph, run, campaign, exec } = harness();
    campaign("120000010");
    const summary = await run(b);
    expect(summary.executed).toBe(1);
    expect(graph.campaigns.get("120000010")?.status).toBe("PAUSED");

    // The dry run came first, identical but for execution_options.
    const posts = graph.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.form.toString())).toEqual([
      `status=PAUSED&execution_options=${encodeURIComponent(VALIDATE_ONLY)}`,
      "status=PAUSED",
    ]);
    for (const c of graph.calls) expect(c.url.toString()).not.toContain(TOKEN);

    const execution = await executionFor(proposal.id);
    expect(execution).toMatchObject({
      status: "succeeded",
      provider: "meta_ads",
      op: "pause_campaign",
    });
    expect(execution?.undo_payload).toEqual({
      campaign_id: "120000010",
      campaign_name: "Autumn menu",
      status: "ACTIVE",
    });
    expect(await watchLines(b.profile_id)).toContain('Paused "Autumn menu" on Meta.');

    // A second run is a no-op.
    const before = graph.calls.length;
    expect((await run(b)).due).toBe(0);
    expect(graph.calls).toHaveLength(before);

    // Undo — even with the gate off (it only removes what an open gate let out).
    gate(false);
    const dryRunsBefore = graph.dryRuns().length;
    const row = await undoExecution({
      executionId: execution!.id,
      userId: b.user_id,
      expectedProfileId: b.profile_id,
      provider: exec.ads,
    });
    expect(row.status).toBe("undone");
    expect(graph.campaigns.get("120000010")?.status).toBe("ACTIVE");
    expect(graph.dryRuns()).toHaveLength(dryRunsBefore + 1); // undo is a write too: dry run first
    expect(await watchLines(b.profile_id)).toContain(
      'Undid: "Autumn menu" is active on Meta again.',
    );
    expect(realFetchUsed).toHaveBeenCalledTimes(0);
  });

  it("resume sets ACTIVE and undoes to PAUSED; pausing a paused campaign is refused before anything is sent", async () => {
    const b = await business();
    const { graph, run, campaign, exec } = harness();
    campaign("120000011", { status: "PAUSED" });
    const resume = await adProposal(b, { change: "resume", campaign_ref: "120000011" });
    expect((await run(b)).executed).toBe(1);
    expect(graph.campaigns.get("120000011")?.status).toBe("ACTIVE");
    const execution = await executionFor(resume);
    await undoExecution({ executionId: execution!.id, userId: b.user_id, provider: exec.ads });
    expect(graph.campaigns.get("120000011")?.status).toBe("PAUSED");

    const pause = await adProposal(b, { change: "pause", campaign_ref: "120000011" });
    const writesBefore = graph.writes().length;
    const again = await run(b);
    expect(again.refused).toBe(1);
    expect(again.outcomes[0]?.detail).toMatch(/already paused/);
    expect(graph.writes()).toHaveLength(writesBefore);
    expect((await proposalRow(pause)).status).toBe("approved");
  });
});

/* ── the dry run ── */

describe("P3-22b — validate_only before every write", () => {
  it("a validation error refuses before anything changes, in the owner's words", async () => {
    const b = await business();
    const { graph, run, campaign } = harness({ rejectDryRun: () => true });
    campaign("120000020");
    const id = await adProposal(b, { change: "pause", campaign_ref: "120000020" });
    const summary = await run(b);
    expect(summary.failed).toBe(1);
    expect(graph.dryRuns()).toHaveLength(1);
    expect(graph.writes()).toHaveLength(0);
    expect(graph.campaigns.get("120000020")?.status).toBe("ACTIVE");
    const execution = await executionFor(id);
    expect(execution?.status).toBe("failed");
    expect(execution?.attempts).toBe(1); // a deterministic refusal is not retried
    expect(execution?.error).toMatch(
      /Meta's dry run refused this change \(code 100\), so it was never sent for real\. Nothing was changed\./,
    );
  });
});

/* ── budgets ── */

describe("P3-22b/c — set_daily_budget", () => {
  it("runs validate_only first, stores the prior budget, sets +20%, and undoes to it", async () => {
    const b = await business();
    const { graph, run, campaign, exec } = harness();
    campaign("120000030", { daily_budget: 1_000 }); // €10.00
    const id = await adProposal(b, {
      change: "raise_budget",
      campaign_ref: "120000030",
      share: 0.2,
      currency: "EUR",
    });
    expect((await run(b)).executed).toBe(1);
    expect(graph.campaigns.get("120000030")?.daily_budget).toBe(1_200);
    expect(graph.calls.filter((c) => c.method === "POST").map((c) => c.form.toString())).toEqual([
      `daily_budget=1200&execution_options=${encodeURIComponent(VALIDATE_ONLY)}`,
      "daily_budget=1200",
    ]);
    const execution = await executionFor(id);
    expect(execution?.undo_payload).toEqual({
      campaign_id: "120000030",
      campaign_name: "Autumn menu",
      daily_budget: 1_000,
      daily_budget_minor: 1_000,
      currency: "EUR",
    });
    expect(execution?.result).toMatchObject({
      daily_budget_before_minor: 1_000,
      daily_budget_minor: 1_200,
      currency: "EUR",
      access_tier: "development_access",
    });
    expect(await watchLines(b.profile_id)).toContain(
      `Changed "Autumn menu"'s daily budget on Meta from €10.00 to €12.00.`,
    );

    await undoExecution({ executionId: execution!.id, userId: b.user_id, provider: exec.ads });
    expect(graph.campaigns.get("120000030")?.daily_budget).toBe(1_000);
  });

  it("a HUF account's budget is sent as whole forints (offset 1), rounded down, never up", async () => {
    const b = await business();
    const { graph, run, campaign } = harness({ currency: "HUF" });
    campaign("120000031", { daily_budget: 5_003 }); // 5 003 Ft, in Meta's unit
    const id = await adProposal(b, {
      change: "raise_budget",
      campaign_ref: "120000031",
      share: 0.2,
      currency: "HUF",
    });
    expect((await run(b)).executed).toBe(1);
    // 5 003 Ft × 1.2 = 6 003,60 Ft → 6 003 Ft to Meta; SYB records 600 300 fillér.
    expect(graph.writes()[0]?.form.get("daily_budget")).toBe("6003");
    expect(graph.campaigns.get("120000031")?.daily_budget).toBe(6_003);
    expect((await executionFor(id))?.result).toMatchObject({
      daily_budget_before_minor: 500_300,
      daily_budget_minor: 600_300,
      sent_daily_budget: 6_003,
      currency: "HUF",
    });
  });

  it("a retried attempt never compounds: the target comes from the captured budget", async () => {
    const b = await business();
    // Every write lands and its answer is lost three times: the request helper retries, then the engine does.
    const { graph, run, campaign } = harness({ loseAnswers: 3 });
    campaign("120000032", { daily_budget: 1_000 });
    const id = await adProposal(b, {
      change: "raise_budget",
      campaign_ref: "120000032",
      share: 0.2,
      currency: "EUR",
    });
    expect((await run(b)).executed).toBe(1);
    expect(graph.campaigns.get("120000032")?.daily_budget).toBe(1_200); // not 1 440
    for (const w of graph.writes()) expect(w.form.get("daily_budget")).toBe("1200");
    expect((await executionFor(id))?.attempts).toBe(2);
  });

  it("beyond ±50% is refused inside the executor, naming the number — nothing sent, still approved", async () => {
    const b = await business();
    const { graph, run, campaign } = harness();
    campaign("120000033");
    const id = await adProposal(b, {
      change: "raise_budget",
      campaign_ref: "120000033",
      share: 0.6,
      currency: "EUR",
    });
    const summary = await run(b);
    expect(summary.refused).toBe(1);
    expect(summary.outcomes[0]?.detail).toMatch(
      /a 60% change is beyond the 50% allowed in one approval/,
    );
    expect(graph.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect((await proposalRow(id)).status).toBe("approved");
  });

  it("over the owner's monthly ceiling is refused, naming both figures; under it passes", async () => {
    const b = await business();
    const { graph, run, campaign } = harness();
    campaign("120000034", { daily_budget: 1_000 });
    // €10 → €12 a day: (10 + 2) × 30 = €360 a month, over a €300 ceiling.
    await setCeiling(b.profile_id, 30_000, "EUR");
    await adProposal(b, {
      change: "raise_budget",
      campaign_ref: "120000034",
      share: 0.2,
      currency: "EUR",
    });
    const over = await run(b);
    expect(over.refused).toBe(1);
    expect(over.outcomes[0]?.detail).toMatch(/360\.00, over your stated ceiling of €300\.00/);
    expect(graph.writes()).toHaveLength(0);

    await setCeiling(b.profile_id, 50_000, "EUR");
    expect((await run(b)).executed).toBe(1);
    expect(graph.campaigns.get("120000034")?.daily_budget).toBe(1_200);
  });

  it("a ceiling in another currency is never converted (rule 1)", async () => {
    const b = await business();
    const { run, campaign } = harness();
    campaign("120000035");
    await setCeiling(b.profile_id, 10_000_000, "HUF");
    await adProposal(b, {
      change: "raise_budget",
      campaign_ref: "120000035",
      share: 0.2,
      currency: "EUR",
    });
    expect((await run(b)).outcomes[0]?.detail).toMatch(
      /ceiling is in HUF and this campaign spends in EUR/,
    );
  });

  it("never below Meta's floor: the table's figure, or the account's own minimum when higher", async () => {
    const b = await business();
    const { graph, run, campaign } = harness({ currency: "HUF" });
    campaign("120000036", { daily_budget: 600 }); // 600 Ft
    await adProposal(b, {
      change: "lower_budget",
      campaign_ref: "120000036",
      share: -0.5,
      currency: "HUF",
    });
    // 300 Ft is under the table's 400 Ft.
    expect((await run(b)).outcomes[0]?.detail).toMatch(
      /set the daily budget to HUF\s?300\.00, under Meta's minimum of HUF\s?400\.00 a day/,
    );
    expect(graph.writes()).toHaveLength(0);

    const b2 = await business();
    const higher = harness({ currency: "EUR", minDailyBudget: 900 });
    higher.campaign("120000037", { daily_budget: 1_000 });
    await adProposal(b2, {
      change: "lower_budget",
      campaign_ref: "120000037",
      share: -0.2,
      currency: "EUR",
    });
    expect((await higher.run(b2)).outcomes[0]?.detail).toMatch(/under Meta's minimum of €9\.00/);
  });

  it("an approved currency that isn't the account's is refused; so is a campaign budgeted on its ad sets", async () => {
    const b = await business();
    const { run, campaign } = harness({ currency: "EUR" });
    campaign("120000038");
    campaign("120000039", { daily_budget: null });
    await adProposal(b, {
      change: "raise_budget",
      campaign_ref: "120000038",
      share: 0.2,
      currency: "USD",
    });
    await adProposal(b, {
      change: "raise_budget",
      campaign_ref: "120000039",
      share: 0.2,
      currency: "EUR",
    });
    const details = (await run(b)).outcomes.map((o) => o.detail).join("\n");
    expect(details).toMatch(/approved this change in USD, but the ad account bills in EUR/);
    expect(details).toMatch(/budget on its ad sets, not the campaign/);
  });
});

/* ── what is never touched ── */

describe("P3-22b — only live or paused campaigns, only in the connected account", () => {
  it("a campaign Meta has archived is refused, and nothing is written", async () => {
    const b = await business();
    const { graph, run, campaign } = harness();
    // Meta's word for it comes from the fake; SYB's code never sends it.
    campaign("120000040", { status: ["ARCH", "IVED"].join("") });
    await adProposal(b, { change: "resume", campaign_ref: "120000040" });
    expect((await run(b)).outcomes[0]?.detail).toMatch(/SYB only pauses, resumes or re-budgets/);
    expect(graph.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("a campaign in another ad account is refused before anything is sent", async () => {
    const b = await business();
    const { graph, run, campaign } = harness();
    campaign("120000041", { account_id: OTHER_ACT });
    await adProposal(b, { change: "pause", campaign_ref: "120000041" });
    expect((await run(b)).outcomes[0]?.detail).toMatch(
      /isn't in the connected ad account \(act_2000000002\)/,
    );
    expect(graph.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("no ad connection: refused in words, nothing sent", async () => {
    const b = await business();
    await db
      .update(connections)
      .set({ status: "paused" })
      .where(eq(connections.account_id, b.account_id));
    const { graph, run } = harness();
    await adProposal(b, { change: "pause", campaign_ref: "120000042" });
    expect((await run(b)).outcomes[0]?.detail).toMatch(/Meta ad connection is paused/);
    expect(graph.calls).toHaveLength(0);
  });
});

/* ── create, irreversible ── */

describe("P3-22b — create_campaign_paused, irreversible and at most once", () => {
  const create = {
    change: "create_paused",
    name: "Winter soups",
    objective: "OUTCOME_TRAFFIC",
    special_ad_categories: [],
  };

  it("labelled irreversible: dry run, then PAUSED + AUCTION + objective + categories; no undo exists", async () => {
    const b = await business();
    const { graph, run, exec } = harness();
    const id = await adProposal(b, create, { level: "hard" });
    expect((await run(b)).executed).toBe(1);
    const posts = graph.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.form.get("execution_options")).toBe(VALIDATE_ONLY);
    const sent = posts[1]!;
    expect(sent.url.pathname).toBe(`${V}/act_${ACT}/campaigns`);
    expect(Object.fromEntries(sent.form)).toEqual({
      name: "Winter soups",
      objective: "OUTCOME_TRAFFIC",
      status: "PAUSED",
      special_ad_categories: "[]",
      buying_type: "AUCTION",
    });
    const [only] = [...graph.campaigns.values()];
    expect(only?.status).toBe("PAUSED");
    const execution = await executionFor(id);
    expect(execution?.undo_payload).toBeNull();
    await expect(
      undoExecution({ executionId: execution!.id, userId: b.user_id, provider: exec.ads }),
    ).rejects.toThrow(/labelled irreversible before you approved it/);
  });

  it("labelled undoable, it is refused before anything is sent (irreversible is said before approval)", async () => {
    const b = await business();
    const { graph, exec } = harness();
    const id = await adProposal(b, create, { level: "easy" });
    const plan = adsPlan(await proposalRow(id));
    if (!("plan" in plan)) throw new Error("expected a plan");
    await expect(
      executeProposal({
        proposalId: id,
        provider: exec.ads,
        op: plan.plan.op,
        params: plan.plan.params,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "reversibility_lie" });
    expect(graph.calls).toHaveLength(0);
  });

  it("a create whose answer is lost is never sent again", async () => {
    const b = await business();
    const { graph, run } = harness({ loseAnswers: 1 });
    const id = await adProposal(b, create, { level: "hard" });
    expect((await run(b)).failed).toBe(1);
    expect(graph.writes()).toHaveLength(1);
    expect(graph.campaigns.size).toBe(1); // it landed; we never learned its id
    expect((await executionFor(id))?.error).toMatch(
      /I may have created this campaign — check Ads Manager/,
    );
    expect((await run(b)).due).toBe(0); // the runner never re-runs it
    expect(graph.writes()).toHaveLength(1);
  });
});

/* ── the tier ── */

describe("P3-22d — access-tier honesty", () => {
  it("reads ads_api_access_tier on every call, logs it with the account id, stores it on the connection", async () => {
    const log = vi.spyOn(console, "log");
    try {
      const b = await business();
      const { run, campaign } = harness({ tier: "development_access" });
      campaign("120000050");
      await adProposal(b, { change: "pause", campaign_ref: "120000050" });
      expect((await run(b)).executed).toBe(1);
      const lines = log.mock.calls.map((c) => String(c[0]));
      const attempt = lines
        .filter((l) => l.includes('"event":"ad_change"') && l.includes('"phase":"execute"'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(attempt[0]).toMatchObject({
        account_id: b.account_id,
        op: "pause_campaign",
        outcome: "changed",
        access_tier: "development_access",
      });
      expect(
        lines.some(
          (l) => l.includes('"access_tier":"development_access"') && l.includes("meta_usage"),
        ),
      ).toBe(true);
      for (const l of lines) expect(l).not.toContain(TOKEN);
      const [conn] = await listExecutionConnections(b.account_id);
      expect(conn).toMatchObject({ provider: "meta_ads", access_tier: "development_access" });
      expect(conn?.access_tier_seen_at).not.toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it("no tier header: nothing stored, nothing invented", async () => {
    const b = await business();
    const { run, campaign } = harness({ tier: null });
    campaign("120000051");
    await adProposal(b, { change: "pause", campaign_ref: "120000051" });
    expect((await run(b)).executed).toBe(1);
    const [conn] = await listExecutionConnections(b.account_id);
    expect(conn?.access_tier).toBeNull();
  });

  it("usage near the hourly limit defers — reads only, nothing written, still approved — and goes out once it eases", async () => {
    const b = await business();
    const busy = harness({ usage: 80 });
    busy.campaign("120000052");
    const id = await adProposal(b, { change: "pause", campaign_ref: "120000052" });
    const deferred = await busy.run(b);
    expect(deferred.refused).toBe(1);
    expect(deferred.outcomes[0]?.detail).toMatch(
      /^deferred: Meta says this ad account has used 80% of its hourly call limit .*300 \+ 40 × active ads/,
    );
    expect(busy.graph.calls.every((c) => c.method === "GET")).toBe(true);
    expect((await proposalRow(id)).status).toBe("approved");

    const calm = harness({ usage: 10 });
    calm.campaign("120000052");
    expect((await calm.run(b)).executed).toBe(1);
  });

  it("the published standard-access limit, as arithmetic", () => {
    expect(adsHourlyCallLimit(0)).toBe(300);
    expect(adsHourlyCallLimit(5)).toBe(500);
    expect(adsHourlyCallLimit(-3)).toBe(300);
  });
});

/* ── the engine, when an undo can't be captured ── */

describe("engine — an undo that can't be captured closes the run as failed, never `running`", () => {
  it("a Meta read failing at capture leaves a failed row with the reason, and nothing written", async () => {
    const b = await business();
    let reads = 0;
    const { graph, exec, campaign } = harness({
      // The pre-flight read answers; the capture read finds Meta down.
      respond: (call) =>
        call.method === "GET" && call.url.pathname.endsWith("/120000060") && ++reads > 1
          ? metaError(2, "Service temporarily unavailable")
          : null,
    });
    campaign("120000060");
    const id = await adProposal(b, { change: "pause", campaign_ref: "120000060" });
    await expect(
      executeProposal({
        proposalId: id,
        provider: exec.ads,
        op: "pause_campaign",
        params: { campaign_id: "120000060" },
        sleep: noSleep,
      }),
    ).rejects.not.toBeInstanceOf(ExecutionRefused);
    const execution = await executionFor(id);
    expect(execution?.status).toBe("failed");
    expect(execution?.error).toMatch(/^the undo could not be captured: /);
    expect(execution?.finished_at).not.toBeNull();
    expect(graph.writes()).toHaveLength(0);
  });
});
