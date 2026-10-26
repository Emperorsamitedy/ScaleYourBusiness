// P3-54 — "Run this ad": one approved proposal that creates, all PAUSED, a
// campaign, an ad set, (for a video) an uploaded ad video, a creative from a
// content item's media, and the ad — end to end through the generator, the
// due runner and the engine, against a recorded-shape fake Marketing API. No
// real network: the global fetch fails the test if it is ever touched, and
// every assertion about what was sent reads the fake's own call log.
//
// What these tests hold:
//
//   · THE GATE AND THE FENCE. With SESSION_D_REAL_WRITES off an approved ad
//     sends nothing, not even a read, and stays approved. The watch blocks it
//     (rule 15). A connection agreed before ad creation was in the consent
//     is refused (rule 13). An item changed after approval is refused.
//   · ALL PAUSED, DRY RUN FIRST. Every create is PAUSED and preceded by the
//     identical validate_only call (the video upload has no dry run); the
//     creative's caption carries its AI disclosure (rule 17); a housing
//     business's ad carries its special category and Meta's restricted
//     targeting — no bypass.
//   · RESUMABLE, NEVER TWICE. The stop between two creates holds the run; the
//     resume carries on from the journal. A create whose answer was lost is
//     read back by its name and adopted — or, not found, never sent again.
//   · GOING LIVE IS SEPARATE. A finished build proposes going live; approved,
//     it resumes the ad, the ad set (with its end date) and then the
//     campaign; undo pauses the campaign first, then the ad set and ad.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../../db";
import {
  accounts,
  adBuilds,
  businessProfiles,
  connections,
  contentItems,
  executionAttempts,
  executions,
  fieldRecords,
  intakeEvents,
  metricObservations,
  modeDecisions,
  profileSnapshots,
  proposals,
  users,
  watchActivity,
} from "../../../db/schema";
import { metaError } from "../../connectors/providers/meta-fake";
import { confidence } from "../../core/confidence";
import { createField } from "../../core/field";
import { fieldId } from "../../core/ids";
import { isoDateTime } from "../../core/iso";
import { adsPlan, dbAdsBackend } from "../../ads/executing";
import {
  ADCREATE,
  CREATES_PAUSED_NOTE,
  proposeAdRun,
  reclaimStaleAdBuilds,
} from "../../ads/adcreate";
import { ADS } from "../../ads/proposals";
import { bootstrapIntake } from "../../intake/service";
import { writeField } from "../../profile/field-store";
import type { LimitLlm } from "../../proposals/hard-limits";
import { approveProposal, createProposal } from "../../proposals/service";
import { connectForExecution, expectedExecutionScopes } from "../connections";
import { consentToExecution } from "../consent";
import { runDueExecutions } from "../due";
import { haltExecutions, resumeExecutions, undoExecution } from "../engine";
import type { MetaExecFetch, MetaExecRequestInit, MetaExecResponse } from "./meta";
import {
  AD_BUILD_RETRY_MS,
  VALIDATE_ONLY,
  adObjectName,
  adWriteViolation,
  createMetaExecution,
  disclosureViolation,
} from "./meta";

const TOKEN = "EAAFakeAdsSystemUserTokenForTests";
const PUBLISH_TOKEN = "EAAFakePublishTokenForTests";
const ACT = "2000000002";
const PAGE = "1000000001";
const IG = "17800000000000001";
const V = "/v26.0";
const noSleep = async () => undefined;
const LABEL = "Written with AI assistance.";
const BODY = "The autumn menu is here: pumpkin soup and slow-roast pork.";
const IMAGE = "https://blob.test.invalid/renders/p/i/0123456789abcdef.jpg";
const VIDEO = "https://blob.test.invalid/renders/p/i/0123456789abcdef.mp4";

/* ── no real network, anywhere in this file ── */

const realFetchUsed = vi.fn(async () => {
  throw new Error("a real fetch was attempted in a P3-54 test");
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

interface Obj {
  kind: "campaign" | "adset" | "creative" | "ad" | "video";
  name: string;
  status: string | null;
  parent: string | null;
  daily_budget: number | null;
  form: URLSearchParams;
}

interface Call {
  method: string;
  url: URL;
  init: MetaExecRequestInit;
  form: URLSearchParams;
}

interface FakeOptions {
  /** The real create on this edge lands, then its answer is lost (once). */
  loseAnswerOn?: "campaigns" | "adsets" | "adcreatives" | "ads";
  /** …or is lost without landing (Meta never made it). */
  dropOn?: "campaigns" | "adsets" | "adcreatives" | "ads";
  /** Polls before an uploaded video reads ready. */
  videoPollsToReady?: number;
  /** Run before the fake answers a call — e.g. to pull the emergency stop. */
  before?: (call: Call) => Promise<void>;
}

const EDGE_KIND = {
  campaigns: "campaign",
  adsets: "adset",
  adcreatives: "creative",
  ads: "ad",
  advideos: "video",
} as const;

function fakeAds(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  const objects = new Map<string, Obj>();
  let n = 0;
  let lost = false;
  const polls = new Map<string, number>();
  const ok = (body: unknown): MetaExecResponse => ({
    status: 200,
    json: async () => body,
    header: () => null,
  });

  const fetch: MetaExecFetch = async (raw, init) => {
    const url = new URL(raw);
    const form = new URLSearchParams(init.body ?? "");
    const call: Call = { method: init.method, url, init, form };
    calls.push(call);
    await opts.before?.(call);
    if (url.origin !== "https://graph.facebook.com") throw new Error(`not Meta: ${url.origin}`);
    if (init.headers["authorization"] !== `Bearer ${TOKEN}`) {
      return metaError(190, "Invalid OAuth access token");
    }
    const path = url.pathname;
    const dryRun = form.get("execution_options") === VALIDATE_ONLY;

    if (init.method === "GET" && path === `${V}/act_${ACT}`) {
      return ok({ id: `act_${ACT}`, currency: "EUR" });
    }
    const edge = /^\/v26\.0\/act_(\d+)\/(campaigns|adsets|adcreatives|ads|advideos)$/.exec(path);
    if (edge && edge[1] === ACT) {
      const kind = EDGE_KIND[edge[2] as keyof typeof EDGE_KIND];
      if (init.method === "GET") {
        const want = JSON.parse(url.searchParams.get("filtering") ?? "[]") as { value?: string }[];
        const tag = want[0]?.value ?? "";
        const field = kind === "video" ? "title" : "name";
        return ok({
          data: [...objects.entries()]
            .filter(([, o]) => o.kind === kind && o.name.includes(tag))
            .map(([id, o]) => ({ id, [field]: o.name })),
        });
      }
      if (dryRun) return ok({ success: true });
      const id = `${kind === "video" ? 9 : 12}${String(++n).padStart(9, "0")}`;
      if (opts.dropOn === edge[2] && !lost) {
        lost = true;
        throw new Error("socket hang up before Meta made it");
      }
      objects.set(id, {
        kind,
        name: form.get("name") ?? "",
        status: form.get("status"),
        parent: form.get("campaign_id") ?? form.get("adset_id"),
        daily_budget: form.get("daily_budget") ? Number(form.get("daily_budget")) : null,
        form,
      });
      if (opts.loseAnswerOn === edge[2] && !lost) {
        lost = true;
        throw new Error("socket hang up after the create");
      }
      return ok({ id });
    }
    const id = decodeURIComponent(path.slice(V.length + 1));
    const o = objects.get(id);
    if (o && init.method === "GET") {
      if (o.kind === "video") {
        const seen = (polls.get(id) ?? 0) + 1;
        polls.set(id, seen);
        const ready = seen >= (opts.videoPollsToReady ?? 1);
        return ok({
          id,
          status: { video_status: ready ? "ready" : "processing" },
          ...(ready ? { picture: "https://scontent.test.invalid/thumb.jpg" } : {}),
        });
      }
      return ok({
        id,
        name: o.name,
        account_id: ACT,
        status: o.status,
        ...(o.kind === "adset"
          ? { campaign_id: o.parent, daily_budget: String(o.daily_budget) }
          : {}),
        ...(o.kind === "ad" ? { adset_id: o.parent } : {}),
        ...(o.kind === "campaign" ? { objective: o.form.get("objective") } : {}),
      });
    }
    if (o && init.method === "POST") {
      if (!dryRun && form.has("status")) o.status = form.get("status");
      return ok({ success: true });
    }
    return metaError(100, "Unsupported request. Object does not exist or missing permissions", 33);
  };

  const writes = () =>
    calls.filter((c) => c.method === "POST" && c.form.get("execution_options") !== VALIDATE_ONLY);
  const dryRuns = () =>
    calls.filter((c) => c.method === "POST" && c.form.get("execution_options") === VALIDATE_ONLY);
  const creates = (edgeName: string) =>
    writes().filter((c) => c.url.pathname === `${V}/act_${ACT}/${edgeName}`);
  return { fetch, calls, objects, writes, dryRuns, creates };
}

function harness(opts: FakeOptions = {}) {
  const graph = fakeAds(opts);
  const exec = createMetaExecution({
    fetch: graph.fetch,
    sleep: noSleep,
    adsBackend: dbAdsBackend(),
  });
  const run = (b: Biz, at?: Date) =>
    runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { meta_ads: exec.ads },
      ...(at ? { now: () => at } : {}),
    });
  return { graph, exec, run };
}

/* ── a business with Meta connected for publishing and for ads ── */

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
  await db.delete(adBuilds).where(inArray(adBuilds.profile_id, ids));
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
  await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
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
  await db.delete(profileSnapshots).where(inArray(profileSnapshots.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });
const noPaidAds: LimitLlm = async () => ({
  text: JSON.stringify({ limits: [{ code: "no_paid_ads", quote: "we don't do paid ads" }] }),
  calls: [],
});

const scenario = {
  assumptions: [],
  base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — fixture",
} as never;

async function answer(profileId: string, key: string, value: unknown) {
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

interface BizOptions {
  /** Connect ads without the consent row (as if agreed before ad creation). */
  oldConsent?: boolean;
  ceiling?: { amount_minor: number; currency: string } | null;
  businessType?: string;
  website?: string;
  media?: string;
  body?: string;
  mode?: "instant" | "watching";
}

async function business(o: BizOptions = {}) {
  const s = await bootstrapIntake();
  created.push(s);
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: o.mode ?? "instant",
    watch_weeks: o.mode === "watching" ? 6 : null,
    inputs: { reasons: ["test fixture"] },
    reasoning: "test fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 42 * 86_400_000).toISOString(),
  });
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-54-${crypto.randomUUID()}@test.local`,
      display_name: "P3-54 owner",
      role: "owner",
    })
    .returning({ id: users.id });
  await connectForExecution({
    accountId: s.account_id,
    provider: "meta_publish",
    secret: JSON.stringify({ access_token: PUBLISH_TOKEN, page_id: PAGE, ig_user_id: IG }),
    verify: async () => ({ granted_scopes: expectedExecutionScopes("meta_publish") }),
  });
  const adsSecret = JSON.stringify({ access_token: TOKEN, ad_account_id: `act_${ACT}` });
  const verify = async () => ({ granted_scopes: expectedExecutionScopes("meta_ads") });
  if (o.oldConsent) {
    await connectForExecution({
      accountId: s.account_id,
      provider: "meta_ads",
      secret: adsSecret,
      verify,
    });
  } else {
    await consentToExecution({
      accountId: s.account_id,
      provider: "meta_ads",
      secret: adsSecret,
      confirmation: "allow ad changes",
      verify,
    });
  }
  if (o.ceiling !== null) {
    await answer(
      s.profile_id,
      "marketing.monthly_ad_ceiling",
      o.ceiling ?? { amount_minor: 30_000, currency: "EUR" },
    );
  }
  await answer(s.profile_id, "legal.country", "Hungary");
  await answer(s.profile_id, "identity.legal_name", "Ember & Oak Kft.");
  if (o.businessType)
    await answer(s.profile_id, "identity.business_type", { code: o.businessType });
  if (o.website) await answer(s.profile_id, "presence.website_url", o.website);
  const plan = await createProposal({
    profile_id: s.profile_id,
    module: "content",
    action: { kind: "content_calendar", summary: "fixture plan" },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: "fixture" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const [item] = await db
    .insert(contentItems)
    .values({
      profile_id: s.profile_id,
      proposal_id: plan.id,
      kind: o.media === VIDEO ? "video" : "post",
      channel_label: "Instagram",
      scheduled_for: "2026-10-30",
      title: "Autumn menu",
      body: o.body ?? BODY,
      media_path: o.media ?? IMAGE,
      disclosure: LABEL,
      provenance: { test: true },
    })
    .returning();
  return { ...s, user_id: u!.id, item_id: item!.id };
}

type Biz = Awaited<ReturnType<typeof business>>;

async function proposeAndApprove(b: Biz, args: Partial<Parameters<typeof proposeAdRun>[1]> = {}) {
  const out = await proposeAdRun(b.profile_id, { item_id: b.item_id, limitLlm: noLimits, ...args });
  if (!("created" in out)) throw new Error(`not proposed: ${out.skipped}`);
  await approveProposal({ proposalId: out.created.id, userId: b.user_id, profileId: b.profile_id });
  return out.created;
}

const proposalRow = async (id: string) =>
  (await db.select().from(proposals).where(eq(proposals.id, id)))[0]!;
const executionFor = async (proposalId: string) =>
  (await db.select().from(executions).where(eq(executions.proposal_id, proposalId)))[0];
const buildFor = async (proposalId: string) =>
  (await db.select().from(adBuilds).where(eq(adBuilds.proposal_id, proposalId)))[0];

/* ── pure: what may be sent ── */

describe("P3-54 — what an ad-build write may carry", () => {
  it("the creative's caption carries its AI disclosure, or it is never sent (rule 17)", () => {
    const spec = (message: string) =>
      JSON.stringify({ page_id: PAGE, link_data: { link: "https://x.test", message } });
    expect(
      disclosureViolation("adcreative_create", { object_story_spec: spec(`${BODY}\n\n${LABEL}`) }),
    ).toBeNull();
    expect(disclosureViolation("adcreative_create", { object_story_spec: spec(BODY) })).toBe(
      "adcreative_create",
    );
    expect(disclosureViolation("adcreative_create", {})).toBe("adcreative_create");
  });

  it("every create is PAUSED; an ad set is charged per impression, lowest cost, with an end date", () => {
    const adset = {
      name: "A · ad set · SYB-00000000",
      campaign_id: "120000001",
      daily_budget: "500",
      billing_event: "IMPRESSIONS",
      optimization_goal: "REACH",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: "{}",
      end_time: "2026-11-02T10:00:00.000Z",
      status: "PAUSED",
    };
    expect(adWriteViolation("adset_create", adset)).toBeNull();
    expect(adWriteViolation("adset_create", { ...adset, status: "ACTIVE" })).toMatch(
      /created PAUSED/,
    );
    expect(adWriteViolation("adset_create", { ...adset, billing_event: "LINK_CLICKS" })).toMatch(
      /IMPRESSIONS/,
    );
    expect(adWriteViolation("adset_create", { ...adset, bid_amount: "100" })).toMatch(
      /"bid_amount"/,
    );
    expect(adWriteViolation("adset_create", { ...adset, lifetime_budget: "100" })).toMatch(
      /"lifetime_budget"/,
    );
    const { end_time: _end, ...noEnd } = adset;
    expect(adWriteViolation("adset_create", noEnd)).toMatch(/end date/);
    const ad = {
      name: "A · ad · SYB-00000000",
      adset_id: "120000002",
      creative: JSON.stringify({ creative_id: "120000003" }),
      status: "PAUSED",
    };
    expect(adWriteViolation("ad_create", ad)).toBeNull();
    expect(adWriteViolation("ad_create", { ...ad, status: "ACTIVE" })).toMatch(/created PAUSED/);
    expect(
      adWriteViolation("ad_create", { ...ad, creative: JSON.stringify({ object_story_spec: {} }) }),
    ).toMatch(/creative by id/);
    expect(adWriteViolation("ad_update", { status: "DELE" + "TED" })).toMatch(
      /PAUSED or ACTIVE only/,
    );
    expect(
      adWriteViolation("advideo_upload", { name: "v", file_url: "http://x.test/v.mp4" }),
    ).toMatch(/https/);
    expect(
      adWriteViolation("campaign_create", {
        name: "A",
        objective: "OUTCOME_TRAFFIC",
        status: "PAUSED",
        special_ad_categories: "[]",
        buying_type: "AUCTION",
        is_adset_budget_sharing_enabled: "true",
      }),
    ).toMatch(/never shared/);
  });
});

/* ── the route ── */

describe("P3-54 — the due runner's route", () => {
  it("a run_ad routes to create_ad_paused with the approved ad; a go_live to resume_campaign naming the ad set and ad", () => {
    const ad = { build_tag: "SYB-00000000", name: "A" };
    expect(
      adsPlan({
        module: "ads",
        action: {
          kind: "paid_ads_start_or_increase",
          summary: "s",
          detail: { change: "run_ad", ad },
        },
      }),
    ).toEqual({ plan: { provider: "meta_ads", op: "create_ad_paused", params: ad } });
    expect(
      adsPlan({
        module: "ads",
        action: {
          kind: "paid_ads_start_or_increase",
          summary: "s",
          detail: {
            change: "go_live",
            campaign_ref: "120000001",
            adset_id: "120000002",
            ad_id: "120000004",
            run_days: 7,
          },
        },
      }),
    ).toEqual({
      plan: {
        provider: "meta_ads",
        op: "resume_campaign",
        params: {
          campaign_id: "120000001",
          adset_id: "120000002",
          ad_id: "120000004",
          run_days: 7,
        },
      },
    });
    // Filed under the wrong kind, it doesn't add up.
    expect(
      adsPlan({
        module: "ads",
        action: {
          kind: "paid_ads_decrease_or_pause",
          summary: "s",
          detail: { change: "run_ad", ad },
        },
      }),
    ).toHaveProperty("unroutable");
  });
});

/* ── generation ── */

describe("P3-54 — the proposal", () => {
  it("an undecided ad proposal lives as long as any ad proposal", () => {
    expect(ADCREATE.expiry_days).toBe(ADS.expiry_days);
  });

  it("one proposal, irreversible-labelled, with budget, duration, audience, scenario and the paused note", async () => {
    const b = await business({ website: "https://emberandoak.test" });
    const out = await proposeAdRun(b.profile_id, { item_id: b.item_id, limitLlm: noLimits });
    if (!("created" in out)) throw new Error(out.skipped);
    const p = out.created;
    expect(p.status).toBe("pending");
    expect(p.reversibility).toMatchObject({ level: "hard" });
    const d = (p.action as { detail: Record<string, unknown> }).detail;
    expect(d).toMatchObject({
      change: "run_ad",
      execute_on_approval: true,
      paused_note: CREATES_PAUSED_NOTE,
      // €1 floor × 5, inside a €300 ceiling with nothing else measured.
      budget: { daily_minor: 500, currency: "EUR", run_days: 7, total_minor: 3_500 },
      audience: { location: "everyone in HU", age: "18–65+" },
      goal: "visits to your website",
    });
    const ad = d["ad"] as Record<string, unknown>;
    expect(ad).toMatchObject({
      objective: "OUTCOME_TRAFFIC",
      optimization_goal: "LINK_CLICKS",
      destination_type: "WEBSITE",
      call_to_action: "LEARN_MORE",
      link: "https://emberandoak.test",
      page_id: PAGE,
      ig_user_id: IG,
      special_ad_categories: [],
      media: { kind: "image", url: IMAGE },
      caption: `${BODY}\n\n${LABEL}`,
      // An ad shown in Hungary names who it is for and who pays (the DSA).
      dsa: { beneficiary: "Ember & Oak Kft.", payor: "Ember & Oak Kft." },
    });
    expect(ad["targeting"]).toMatchObject({
      geo_locations: { countries: ["HU"] },
      age_min: 18,
      age_max: 65,
      targeting_automation: { advantage_audience: 0 },
    });
    // The scenario: spend at most the budget × days, the return not guessed without measured days.
    expect(p.scenario).toMatchObject({
      base_case: { statement: expect.stringMatching(/Up to €35(\.00)? spent over 7 days/) },
      downside_case: { profit_delta_monthly: { amount_minor: -3_500, currency: "EUR" } },
    });
    // No pre-bound plan: the runner builds it from the row.
    expect(d["execution"]).toBeUndefined();
    // Once proposed, the same item isn't proposed again.
    const again = await proposeAdRun(b.profile_id, { item_id: b.item_id, limitLlm: noLimits });
    expect(again).toMatchObject({ skipped: expect.stringMatching(/already proposed/) });
  });

  it("an audience from a brief is used: a radius from real coordinates, an age band, interests shown but never sent", async () => {
    const b = await business();
    const out = await proposeAdRun(b.profile_id, {
      item_id: b.item_id,
      limitLlm: noLimits,
      audience: {
        location: { latitude: 47.4979, longitude: 19.0402, radius_km: 10, label: "Budapest" },
        age_min: 25,
        age_max: 45,
        interests: "foodies, brunch",
      },
    });
    if (!("created" in out)) throw new Error(out.skipped);
    const d = (out.created.action as { detail: Record<string, unknown> }).detail;
    const t = (d["ad"] as { targeting: Record<string, unknown> }).targeting;
    expect(t).toEqual({
      geo_locations: {
        custom_locations: [
          { latitude: 47.4979, longitude: 19.0402, radius: 10, distance_unit: "kilometer" },
        ],
      },
      age_min: 25,
      age_max: 45,
      publisher_platforms: ["facebook", "instagram"],
      facebook_positions: ["feed"],
      instagram_positions: ["stream"],
      targeting_automation: { advantage_audience: 0 },
    });
    expect(JSON.stringify(t)).not.toMatch(/foodies|interest/);
    expect(d["audience"]).toMatchObject({
      interests: expect.stringMatching(/left broad.*foodies/),
    });
    // No website: an awareness ad that links to the Page.
    expect(d["ad"]).toMatchObject({
      objective: "OUTCOME_AWARENESS",
      link: `https://www.facebook.com/${PAGE}`,
    });
  });

  it("NO BYPASS: a housing business's ad carries its special category and Meta's restricted targeting", async () => {
    const b = await business({ businessType: "real_estate" });
    const out = await proposeAdRun(b.profile_id, {
      item_id: b.item_id,
      limitLlm: noLimits,
      audience: {
        location: { latitude: 47.5, longitude: 19.04, radius_km: 5 },
        age_min: 30,
        age_max: 50,
      },
    });
    if (!("created" in out)) throw new Error(out.skipped);
    const d = (out.created.action as { detail: Record<string, unknown> }).detail;
    expect(d["ad"]).toMatchObject({ special_ad_categories: ["HOUSING"] });
    const t = (
      d["ad"] as { targeting: { age_min: number; age_max: number; geo_locations: unknown } }
    ).targeting;
    expect([t.age_min, t.age_max]).toEqual([18, 65]);
    expect(t.geo_locations).toMatchObject({ custom_locations: [{ radius: 25 }] });
    expect(d["notes"]).toEqual(
      expect.arrayContaining([expect.stringMatching(/minimum/), expect.stringMatching(/age band/)]),
    );
  });

  it("an ad about politics or gambling is refused outright; Meta needs its own authorisation", async () => {
    const b = await business({ body: "Vote for our candidate on Sunday!" });
    const out = await proposeAdRun(b.profile_id, { item_id: b.item_id, limitLlm: noLimits });
    expect(out).toMatchObject({
      skipped: expect.stringMatching(/social issues, elections or politics.*won't run it/),
    });
  });

  it("no stated ceiling, no new spend; a budget past the ceiling is refused, naming both figures", async () => {
    const none = await business({ ceiling: null });
    expect(
      await proposeAdRun(none.profile_id, { item_id: none.item_id, limitLlm: noLimits }),
    ).toMatchObject({
      skipped: expect.stringMatching(/question 8\.1i/),
    });
    const tight = await business();
    expect(
      await proposeAdRun(tight.profile_id, {
        item_id: tight.item_id,
        limitLlm: noLimits,
        daily_budget_minor: 2_000,
      }),
    ).toMatchObject({ skipped: expect.stringMatching(/600.*over your stated ceiling of .*300/) });
    expect(
      await proposeAdRun(tight.profile_id, {
        item_id: tight.item_id,
        limitLlm: noLimits,
        daily_budget_minor: 50,
      }),
    ).toMatchObject({ skipped: expect.stringMatching(/under Meta's minimum/) });
  });

  it("rule 14: a 'no paid ads' limit makes it born blocked — shown as restraint", async () => {
    const b = await business();
    await answer(b.profile_id, "goals.owner_boundaries", "We don't do paid ads.");
    const out = await proposeAdRun(b.profile_id, { item_id: b.item_id, limitLlm: noPaidAds });
    if (!("created" in out)) throw new Error(out.skipped);
    expect(out.created.status).toBe("blocked");
    expect(out.created.blocked_by_limit).toMatch(/we don't do paid ads/);
  });

  it("rule 15: nothing is proposed while the business is being watched", async () => {
    const b = await business({ mode: "watching" });
    expect(
      await proposeAdRun(b.profile_id, { item_id: b.item_id, limitLlm: noLimits }),
    ).toMatchObject({
      skipped: expect.stringMatching(/still watching/),
    });
  });

  it("rule 13: an ad connection agreed before ad creation was in the consent can't create ads until it is agreed again", async () => {
    const b = await business({ oldConsent: true });
    expect(
      await proposeAdRun(b.profile_id, { item_id: b.item_id, limitLlm: noLimits }),
    ).toMatchObject({
      skipped: expect.stringMatching(/reconnect it on Connections to agree to the new wording/),
    });
  });
});

/* ── execution ── */

describe("P3-54 — the build, through the engine", () => {
  it("THE GATE: off by default — an approved ad sends nothing, not even a read, and stays approved", async () => {
    const b = await business();
    const p = await proposeAndApprove(b);
    gate(false);
    const { graph, run } = harness();
    const summary = await run(b);
    expect(summary.refused).toBe(1);
    expect(graph.calls).toHaveLength(0);
    expect((await proposalRow(p.id)).status).toBe("approved");
    expect(await executionFor(p.id)).toBeUndefined();
  });

  it("creates the campaign, ad set, creative and ad — all PAUSED, each after its own dry run — and proposes going live separately", async () => {
    const b = await business({ website: "https://emberandoak.test" });
    const p = await proposeAndApprove(b);
    const { graph, run } = harness();
    const summary = await run(b);
    expect(summary.executed).toBe(1);

    const creates = graph.writes().map((c) => c.url.pathname.split("/").pop());
    expect(creates).toEqual(["campaigns", "adsets", "adcreatives", "ads"]);
    // Each create is preceded by the identical call as a dry run.
    expect(graph.dryRuns().map((c) => c.url.pathname.split("/").pop())).toEqual(creates);
    for (const w of graph.writes()) {
      if (w.form.has("status")) expect(w.form.get("status")).toBe("PAUSED");
    }
    const [campaign, adset, creative, ad] = graph.writes();
    expect(campaign!.form.get("special_ad_categories")).toBe("[]");
    expect(adset!.form.get("billing_event")).toBe("IMPRESSIONS");
    expect(adset!.form.get("daily_budget")).toBe("500"); // €5.00 in cents
    expect(adset!.form.get("optimization_goal")).toBe("LINK_CLICKS");
    expect(adset!.form.get("dsa_beneficiary")).toBe("Ember & Oak Kft.");
    const story = JSON.parse(creative!.form.get("object_story_spec")!) as {
      page_id: string;
      instagram_user_id: string;
      link_data: { message: string; picture: string; call_to_action: { type: string } };
    };
    expect(story).toMatchObject({
      page_id: PAGE,
      instagram_user_id: IG,
      link_data: { picture: IMAGE, call_to_action: { type: "LEARN_MORE" } },
    });
    expect(story.link_data.message.endsWith(LABEL)).toBe(true);
    expect(JSON.parse(ad!.form.get("creative")!)).toEqual({
      creative_id: expect.stringMatching(/^\d+$/),
    });
    // Every object carries the build's tag — what a read-back finds it by.
    const tag = ((await proposalRow(p.id)).action as { detail: { ad: { build_tag: string } } })
      .detail.ad.build_tag;
    for (const o of graph.objects.values()) expect(o.name).toContain(tag);

    const build = await buildFor(p.id);
    expect(build).toMatchObject({ status: "built", build_tag: tag });
    expect(
      [build!.campaign_id, build!.adset_id, build!.creative_id, build!.ad_id].every(Boolean),
    ).toBe(true);
    const exe = await executionFor(p.id);
    expect(exe).toMatchObject({ status: "succeeded", op: "create_ad_paused", undo_payload: null });
    expect(exe!.result).toMatchObject({ status: "PAUSED", ad_id: build!.ad_id });
    expect((await proposalRow(p.id)).status).toBe("executed");

    // Going live is a separate proposal, pending the owner's yes.
    expect(build!.go_live_proposal_id).not.toBeNull();
    const live = await proposalRow(build!.go_live_proposal_id!);
    expect(live).toMatchObject({ status: "pending", reversibility: { level: "easy" } });

    // A second runner call sends nothing more.
    const before = graph.calls.length;
    await run(b);
    expect(graph.calls.length).toBe(before);
  });

  it("a video ad uploads the item's clip by its URL (no dry run), waits for Meta to process it, and uses its thumbnail", async () => {
    const b = await business({ media: VIDEO });
    const p = await proposeAndApprove(b);
    const { graph, run } = harness({ videoPollsToReady: 3 });
    expect((await run(b)).executed).toBe(1);
    const upload = graph.creates("advideos");
    expect(upload).toHaveLength(1);
    expect(upload[0]!.form.get("file_url")).toBe(VIDEO);
    expect(graph.dryRuns().some((c) => c.url.pathname.endsWith("/advideos"))).toBe(false);
    const story = JSON.parse(graph.creates("adcreatives")[0]!.form.get("object_story_spec")!) as {
      video_data: { video_id: string; image_url: string; message: string };
    };
    expect(story.video_data).toMatchObject({
      video_id: (await buildFor(p.id))!.video_id,
      image_url: "https://scontent.test.invalid/thumb.jpg",
    });
    // Reels placements for a video.
    const targeting = JSON.parse(graph.creates("adsets")[0]!.form.get("targeting")!) as {
      facebook_positions: string[];
    };
    expect(targeting.facebook_positions).toContain("facebook_reels");
  });

  it("THE STOP between two creates: the run is held, nothing more is sent; the resume carries on from the journal", async () => {
    const b = await business();
    const p = await proposeAndApprove(b);
    let pulled = false;
    const { graph, run } = harness({
      before: async (call) => {
        // The stop comes on while the ad set's dry run is in flight.
        if (
          !pulled &&
          call.url.pathname.endsWith("/adsets") &&
          call.form.get("execution_options")
        ) {
          pulled = true;
          await haltExecutions({ accountId: b.account_id, reason: "test" });
        }
      },
    });
    await run(b);
    expect(graph.creates("campaigns")).toHaveLength(1);
    expect(graph.creates("adsets")).toHaveLength(0);
    expect(await executionFor(p.id)).toMatchObject({ status: "failed", held_for: "stop" });
    expect(await buildFor(p.id)).toMatchObject({ status: "building", adset_id: null });

    await resumeExecutions(b.account_id);
    expect((await run(b)).executed).toBe(1);
    // The campaign was never created twice.
    expect(graph.creates("campaigns")).toHaveLength(1);
    expect(graph.creates("adsets")).toHaveLength(1);
    expect(await buildFor(p.id)).toMatchObject({ status: "built" });
  });

  it("A LOST ANSWER: the ad set Meta made is read back by its name and adopted — never created twice", async () => {
    const b = await business();
    const p = await proposeAndApprove(b);
    const { graph, run } = harness({ loseAnswerOn: "adsets" });
    await run(b);
    const held = await executionFor(p.id);
    expect(held).toMatchObject({ status: "failed", held_for: "remaining" });
    expect(held!.error).toMatch(/didn't confirm the ad set.*nothing is created twice/);
    const journal = (await buildFor(p.id))!;
    expect(journal.adset_id).toBeNull();
    expect((journal.steps as { adset?: { sent_at?: string } }).adset?.sent_at).toBeTruthy();

    // Not before its wait…
    await run(b);
    expect(graph.creates("adsets")).toHaveLength(1);
    // …then the resume reads back and carries on.
    expect((await run(b, new Date(Date.now() + AD_BUILD_RETRY_MS + 60_000))).executed).toBe(1);
    expect(graph.creates("adsets")).toHaveLength(1);
    const readBack = graph.calls.filter(
      (c) => c.method === "GET" && c.url.pathname === `${V}/act_${ACT}/adsets`,
    );
    expect(readBack).toHaveLength(1);
    const build = (await buildFor(p.id))!;
    expect(build.status).toBe("built");
    const [adsetId] = [...graph.objects.entries()].find(([, o]) => o.kind === "adset")!;
    expect(build.adset_id).toBe(adsetId);
  });

  it("A LOST CREATE: a read-back that finds nothing leaves it uncertain, and it is never sent again", async () => {
    const b = await business();
    const p = await proposeAndApprove(b);
    const { graph, run } = harness({ dropOn: "adcreatives" });
    await run(b);
    expect(await executionFor(p.id)).toMatchObject({ held_for: "remaining" });
    const later = new Date(Date.now() + AD_BUILD_RETRY_MS + 60_000);
    await run(b, later);
    const exe = (await executionFor(p.id))!;
    expect(exe.status).toBe("failed");
    expect(exe.held_for).toBeNull();
    expect(exe.error).toMatch(/I may have created the creative — check Ads Manager/);
    expect(await buildFor(p.id)).toMatchObject({ status: "uncertain" });
    await run(b, new Date(later.getTime() + AD_BUILD_RETRY_MS + 60_000));
    expect(graph.creates("adcreatives")).toHaveLength(1);
    expect(graph.creates("ads")).toHaveLength(0);
  });

  it("a build that died mid-way is reclaimed and resumes from its journal", async () => {
    const b = await business();
    const p = await proposeAndApprove(b);
    const { graph, run } = harness();
    // As if a process had claimed it, created the campaign, and died.
    const [exe] = await db
      .insert(executions)
      .values({
        proposal_id: p.id,
        profile_id: b.profile_id,
        account_id: b.account_id,
        provider: "meta_ads",
        op: "create_ad_paused",
        started_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      })
      .returning();
    const tag = (p.action as { detail: { ad: { build_tag: string; name: string } } }).detail.ad;
    await db.insert(adBuilds).values({
      profile_id: b.profile_id,
      account_id: b.account_id,
      proposal_id: p.id,
      execution_id: exe!.id,
      item_id: b.item_id,
      build_tag: tag.build_tag,
      campaign_id: "120000099",
      steps: { campaign: { sent_at: new Date().toISOString(), id: "120000099" } },
    });
    graph.objects.set("120000099", {
      kind: "campaign",
      name: adObjectName(tag.name, "campaign", tag.build_tag),
      status: "PAUSED",
      parent: null,
      daily_budget: null,
      form: new URLSearchParams(),
    });
    expect(await reclaimStaleAdBuilds()).toBeGreaterThanOrEqual(1);
    expect((await run(b)).executed).toBe(1);
    expect(graph.creates("campaigns")).toHaveLength(0);
    expect(graph.creates("adsets")[0]!.form.get("campaign_id")).toBe("120000099");
  });

  it("an item changed after approval is refused before anything is sent, and stays approved", async () => {
    const b = await business();
    const p = await proposeAndApprove(b);
    await db
      .update(contentItems)
      .set({ body: "Something else entirely." })
      .where(eq(contentItems.id, b.item_id));
    const { graph, run } = harness();
    const summary = await run(b);
    expect(summary.refused).toBe(1);
    expect(summary.outcomes[0]!.detail).toMatch(/isn't what you approved/);
    expect(graph.writes()).toHaveLength(0);
    expect((await proposalRow(p.id)).status).toBe("approved");
  });

  it("rule 15: a business put back under watch after approval gets nothing", async () => {
    const b = await business();
    await proposeAndApprove(b);
    await db.insert(modeDecisions).values({
      profile_id: b.profile_id,
      mode: "watching",
      watch_weeks: 6,
      inputs: {},
      reasoning: "fixture",
      confidence: "0.800",
      review_at: new Date(Date.now() + 42 * 86_400_000).toISOString(),
    });
    const { graph, run } = harness();
    const summary = await run(b);
    expect(summary.outcomes[0]!.detail).toMatch(/^watching/);
    expect(graph.calls).toHaveLength(0);
  });
});

describe("P3-54 — going live, a separate approval", () => {
  it("resumes the ad, then the ad set with its end date, then the campaign; undo pauses the campaign first", async () => {
    const b = await business();
    const p = await proposeAndApprove(b);
    const { graph, exec, run } = harness();
    await run(b);
    const build = (await buildFor(p.id))!;
    const liveId = build.go_live_proposal_id!;
    await approveProposal({ proposalId: liveId, userId: b.user_id, profileId: b.profile_id });
    const mark = graph.calls.length;
    expect((await run(b)).executed).toBe(1);

    const updates = graph.calls
      .slice(mark)
      .filter((c) => c.method === "POST" && c.form.get("execution_options") !== VALIDATE_ONLY)
      .map((c) => [c.url.pathname.split("/").pop(), c.form.get("status")]);
    expect(updates).toEqual([
      [build.ad_id, "ACTIVE"],
      [build.adset_id, "ACTIVE"],
      [build.campaign_id, "ACTIVE"],
    ]);
    const adsetUpdate = graph.calls
      .slice(mark)
      .find((c) => c.url.pathname.endsWith(build.adset_id!) && c.method === "POST")!;
    expect(adsetUpdate.form.get("end_time")).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const exe = (await executionFor(liveId))!;
    expect(exe).toMatchObject({ status: "succeeded", op: "resume_campaign" });
    expect(exe.undo_payload).toMatchObject({
      status: "PAUSED",
      adset: { id: build.adset_id, status: "PAUSED" },
      ad: { id: build.ad_id, status: "PAUSED" },
    });

    const undoMark = graph.calls.length;
    await undoExecution({
      executionId: exe.id,
      provider: exec.ads,
      userId: b.user_id,
      expectedProfileId: b.profile_id,
    });
    const undone = graph.calls
      .slice(undoMark)
      .filter((c) => c.method === "POST" && c.form.get("execution_options") !== VALIDATE_ONLY)
      .map((c) => [c.url.pathname.split("/").pop(), c.form.get("status")]);
    expect(undone).toEqual([
      [build.campaign_id, "PAUSED"],
      [build.adset_id, "PAUSED"],
      [build.ad_id, "PAUSED"],
    ]);
  });
});
