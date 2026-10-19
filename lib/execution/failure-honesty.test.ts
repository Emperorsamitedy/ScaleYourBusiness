// P3-24b/c/d — failure honesty, end to end through the engine and the due
// runner, against a recorded-shape fake Graph API. No real network: the
// global fetch fails the test if it is ever touched, and every assertion
// about what was sent reads the fake's own call log.
//
// What these tests hold:
//
//   · DEGRADE TO PAUSED (P3-24b). A sign-in Meta refuses (the auth class)
//     pauses the execute connection with its reason; every queued item on
//     it flips to `failed` with the one sentence; nothing retries until the
//     reconnect; reconnecting resumes from the journal — held items back in
//     the queue, held runs re-run through every guard — and nothing that
//     may already be live is ever re-sent. The same for the ad executor and
//     the per-post readback. Surfaces: the connection row and its listing
//     (/connections), the items (/content), the watch log, the needs-you
//     count (/api/nav).
//   · THE STOP COVERS EVERYTHING (P3-24c). A halt between "due" and
//     "publish" publishes nothing; a halt mid-carousel leaves no container
//     published; resuming re-evaluates every guard.
//   · TELEMETRY (P3-24d). Rate-limit usage headers on every attempt row;
//     Blob storage in the ops cost view; one structured line per publish
//     with account id, platform, item, attempt and outcome — never a token.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  connectorSyncs,
  contentItems,
  executionAttempts,
  executions,
  fieldRecords,
  intakeEvents,
  metricObservations,
  modeDecisions,
  proposals,
  users,
  watchActivity,
} from "../../db/schema";
import { metaError } from "../connectors/providers/meta-fake";
import { dbAdsBackend } from "../ads/executing";
import { syncPostInsights } from "../content/insights";
import { memoryMediaStore } from "../content/media";
import type { MediaStore } from "../content/media";
import { PUBLISH_UNDO } from "../content/publish";
import { dbPublishBackend } from "../content/publishing";
import { stateWord } from "../../components/content/content-view";
import { bootstrapIntake } from "../intake/service";
import {
  BLOB_STORAGE_MICRO_USD_PER_GB_MONTH,
  blobMonthlyMicroUsd,
  storageSummary,
} from "../ops/summary";
import { approveProposal, createProposal } from "../proposals/service";
import {
  connectForExecution,
  countPausedExecutionConnections,
  expectedExecutionScopes,
  listExecutionConnections,
} from "./connections";
import { consentToExecution } from "./consent";
import { runDueExecutions } from "./due";
import { ExecutionRefused, executeProposal, haltExecutions, resumeExecutions } from "./engine";
import { PAUSED_WORK_SENTENCE, classifyMetaError, pausesConnection } from "./meta-errors";
import type { MetaExecFetch, MetaExecRequestInit, MetaExecResponse } from "./providers/meta";
import {
  STOPPED_BEFORE_PUBLISH,
  StopError,
  VALIDATE_ONLY,
  createMetaExecution,
  usageHeaders,
} from "./providers/meta";
import { fixtureExecutor } from "./providers/fixture";

const TOKEN = "EAAFakeHonestySystemUserToken";
const NEW_TOKEN = "EAAFakeHonestyReconnectedToken";
const PAGE_TOKEN = "EAAFakeHonestyPageToken";
const NEW_PAGE_TOKEN = "EAAFakeHonestyNewPageToken";
const ADS_TOKEN = "EAAFakeHonestyAdsToken";
const NEW_ADS_TOKEN = "EAAFakeHonestyNewAdsToken";
const ALL_TOKENS = [TOKEN, NEW_TOKEN, PAGE_TOKEN, NEW_PAGE_TOKEN, ADS_TOKEN, NEW_ADS_TOKEN];
const PAGE = "1000000001";
const IG = "17800000000000001";
const ACT = "2000000002";
const V = "/v26.0";
const LABEL = "Written with AI assistance.";
const BODY = `The soup is back.\n\n${LABEL}`;
const noSleep = async () => undefined;
const PAST = new Date(Date.now() - 3_600_000).toISOString();

/* ── no real network, anywhere in this file ── */

const realFetchUsed = vi.fn(async () => {
  throw new Error("a real fetch was attempted in a P3-24 test");
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

/* ── one fake Graph API for publishing and ads ── */

interface Call {
  method: string;
  url: URL;
  init: MetaExecRequestInit;
  form: URLSearchParams;
}

interface FakeOptions {
  /** Tokens Meta now refuses with 190/463 (the sign-in expired). */
  expired?: Set<string>;
  /** Runs before each call is answered — where a test pulls the stop. */
  onCall?: (call: Call, n: number) => Promise<void>;
  /** A forced answer, or null for the default. */
  respond?: (call: Call) => MetaExecResponse | "no_answer" | null;
  /** The Page's business-use-case usage %, on the Page read. */
  usage?: number;
}

function ok(body: unknown, headers: Record<string, string> = {}): MetaExecResponse {
  return { status: 200, json: async () => body, header: (n) => headers[n] ?? null };
}

const expiredAnswer = () =>
  metaError(190, "Error validating access token: Session has expired", 463);

function fakeGraph(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  const expired = opts.expired ?? new Set<string>();
  const posts = new Map<string, { message: string; created_time: string }>();
  const containers = new Map<string, { params: Record<string, string>; published: boolean }>();
  const media = new Map<string, { caption: string; timestamp: string }>();
  const campaigns = new Map<string, { status: string; daily_budget: number }>();
  let n = 0;
  const next = () => String(++n).padStart(4, "0");
  const nowIso = () => new Date().toISOString();

  const fetch: MetaExecFetch = async (raw, init) => {
    const url = new URL(raw);
    const form = new URLSearchParams(init.body ?? "");
    const call: Call = { method: init.method, url, init, form };
    calls.push(call);
    await opts.onCall?.(call, calls.length);
    const forced = opts.respond?.(call) ?? null;
    if (forced === "no_answer") throw new Error("socket hang up");
    if (forced !== null) return forced;
    if (url.origin !== "https://graph.facebook.com") throw new Error(`not Meta: ${url.origin}`);
    const bearer = (init.headers["authorization"] ?? "").replace(/^Bearer /, "");
    if (!ALL_TOKENS.includes(bearer)) return metaError(190, "Invalid OAuth access token");
    if (expired.has(bearer)) return expiredAnswer();
    const path = url.pathname;
    const m = init.method;
    const asPage = bearer === PAGE_TOKEN || bearer === NEW_PAGE_TOKEN;

    if (m === "GET" && path === `${V}/${PAGE}`) {
      return ok(
        { id: PAGE, access_token: bearer === NEW_TOKEN ? NEW_PAGE_TOKEN : PAGE_TOKEN },
        opts.usage === undefined
          ? {}
          : {
              "x-business-use-case-usage": JSON.stringify({
                [PAGE]: [
                  { type: "pages", call_count: opts.usage, total_cputime: 1, total_time: 1 },
                ],
              }),
              "x-app-usage": JSON.stringify({ call_count: 3, total_time: 1, total_cputime: 1 }),
            },
      );
    }
    if (m === "POST" && path === `${V}/${PAGE}/feed` && asPage) {
      const id = `${PAGE}_${next()}`;
      posts.set(id, { message: form.get("message") ?? "", created_time: nowIso() });
      return ok({ id });
    }
    if (m === "GET" && path === `${V}/${PAGE}/published_posts`) {
      const since = Number(url.searchParams.get("since") ?? "0") * 1000;
      return ok({
        data: [...posts.entries()]
          .filter(([, p]) => Date.parse(p.created_time) >= since)
          .map(([id, p]) => ({ id, message: p.message, created_time: p.created_time })),
      });
    }
    if (m === "GET" && path === `${V}/${IG}/content_publishing_limit`) {
      return ok({ data: [{ quota_usage: 3, config: { quota_total: 100 } }] });
    }
    if (m === "POST" && path === `${V}/${IG}/media`) {
      const id = `1790${next()}`;
      containers.set(id, { params: Object.fromEntries(form), published: false });
      return ok({ id });
    }
    if (m === "POST" && path === `${V}/${IG}/media_publish`) {
      const c = containers.get(form.get("creation_id") ?? "");
      if (!c) return metaError(9007, "Media not ready");
      c.published = true;
      const id = `1791${next()}`;
      media.set(id, { caption: c.params["caption"] ?? "", timestamp: nowIso() });
      return ok({ id });
    }
    if (m === "GET" && path === `${V}/${IG}/media`) {
      return ok({
        data: [...media.entries()].map(([id, x]) => ({
          id,
          caption: x.caption,
          timestamp: x.timestamp,
          permalink: `https://www.instagram.com/p/${id}/`,
        })),
      });
    }
    // Ads
    if (m === "GET" && path === `${V}/act_${ACT}`) {
      return ok({ id: `act_${ACT}`, currency: "EUR" });
    }
    const id = decodeURIComponent(path.slice(V.length + 1));
    const c = campaigns.get(id);
    if (c && m === "GET") {
      return ok({
        id,
        name: "Autumn menu",
        account_id: ACT,
        status: c.status,
        objective: "OUTCOME_SALES",
        daily_budget: String(c.daily_budget),
      });
    }
    if (c && m === "POST") {
      if (form.get("execution_options") !== VALIDATE_ONLY && form.has("status")) {
        c.status = form.get("status")!;
      }
      return ok({ success: true });
    }
    // Objects by id
    if (m === "GET" && containers.has(id)) {
      const x = containers.get(id)!;
      return ok({ id, status_code: x.published ? "PUBLISHED" : "FINISHED" });
    }
    if (m === "GET" && media.has(id)) {
      return ok({ id, permalink: `https://www.instagram.com/p/${id}/` });
    }
    if (m === "GET" && posts.has(id)) {
      return ok({ id, permalink_url: `https://www.facebook.com/permalink/${id}` });
    }
    return metaError(100, "Unsupported request. Object does not exist or missing permissions", 33);
  };

  const where = (method: string, suffix: string) =>
    calls.filter((x) => x.method === method && x.url.pathname.endsWith(suffix));
  return { fetch, calls, posts, containers, media, campaigns, where, expired };
}

/* ── businesses ── */

const created: { account_id: string; profile_id: string }[] = [];
const store = memoryMediaStore();

afterEach(() => {
  vi.restoreAllMocks();
});

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
  await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
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
    const connIds = conns.map((c) => c.id);
    await db.delete(metricObservations).where(inArray(metricObservations.connection_id, connIds));
    await db.delete(connectorSyncs).where(inArray(connectorSyncs.connection_id, connIds));
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

const publishSecret = (token = TOKEN) =>
  JSON.stringify({ access_token: token, page_id: PAGE, ig_user_id: IG });
const adsSecret = (token = ADS_TOKEN) =>
  JSON.stringify({ access_token: token, ad_account_id: `act_${ACT}` });

async function mode(profileId: string, which: "instant" | "watching", at: Date) {
  await db.insert(modeDecisions).values({
    profile_id: profileId,
    mode: which,
    watch_weeks: which === "watching" ? 4 : null,
    inputs: { reasons: ["test fixture"] },
    reasoning: "test fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 42 * 86_400_000).toISOString(),
    decided_at: at.toISOString(),
  });
}

async function business(opts: { ads?: boolean } = {}) {
  const s = await bootstrapIntake();
  created.push(s);
  await mode(s.profile_id, "instant", new Date(Date.now() - 86_400_000));
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-24-${crypto.randomUUID()}@test.local`,
      display_name: "P3-24 owner",
      role: "owner",
    })
    .returning({ id: users.id });
  await connectForExecution({
    accountId: s.account_id,
    provider: "meta_publish",
    secret: publishSecret(),
    verify: async () => ({ granted_scopes: expectedExecutionScopes("meta_publish") }),
  });
  if (opts.ads) {
    await connectForExecution({
      accountId: s.account_id,
      provider: "meta_ads",
      secret: adsSecret(),
      verify: async () => ({ granted_scopes: expectedExecutionScopes("meta_ads") }),
    });
  }
  const plan = await createProposal({
    profile_id: s.profile_id,
    module: "content",
    action: { kind: "content_publishing", summary: "A plan", detail: { items: [] } },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: "drafts are drafts" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  return { ...s, user_id: u!.id, plan_id: plan.id };
}

type Biz = Awaited<ReturnType<typeof business>>;

/** A drafted item with its own publish proposal, approved to go out in the past. */
async function approvedItem(
  b: Biz,
  args: { platform: "facebook" | "instagram"; media_path?: string | null; title?: string },
) {
  const [item] = await db
    .insert(contentItems)
    .values({
      profile_id: b.profile_id,
      proposal_id: b.plan_id,
      kind: "post",
      channel_label: args.platform,
      scheduled_for: "2026-10-20",
      title: args.title ?? "Autumn menu",
      body: BODY,
      media_path: args.media_path ?? null,
      disclosure: LABEL,
      provenance: { test: true },
    })
    .returning();
  const target = args.platform === "facebook" ? { page_id: PAGE } : { ig_user_id: IG };
  const proposal = await createProposal({
    profile_id: b.profile_id,
    module: "content",
    originating_finding: `publish:${item!.id}`,
    action: {
      kind: "content_publishing",
      summary: `Publish "${item!.title}" to ${args.platform}`,
      detail: { item_id: item!.id, platform: args.platform, target },
    },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: PUBLISH_UNDO },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await db
    .update(contentItems)
    .set({ publish_proposal_id: proposal.id })
    .where(eq(contentItems.id, item!.id));
  await approveProposal({
    proposalId: proposal.id,
    userId: b.user_id,
    profileId: b.profile_id,
    executeNotBefore: PAST,
  });
  return { item_id: item!.id, proposal_id: proposal.id };
}

/** An approved ad pause, as the generator shapes it, due now. */
async function adPause(b: Biz, campaign: string) {
  const p = await createProposal({
    profile_id: b.profile_id,
    module: "ads",
    originating_finding: `ads:test:${crypto.randomUUID()}`,
    action: {
      kind: "paid_ads_decrease_or_pause",
      summary: "Pause the campaign",
      detail: { execute_on_approval: true, change: "pause", campaign_ref: campaign },
    },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: "fixture" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await approveProposal({ proposalId: p.id, userId: b.user_id, profileId: b.profile_id });
  return p.id;
}

function harness(opts: FakeOptions = {}) {
  const graph = fakeGraph(opts);
  const exec = createMetaExecution({
    fetch: graph.fetch,
    sleep: noSleep,
    backend: dbPublishBackend({ store }),
    adsBackend: dbAdsBackend(),
  });
  const run = (b: Biz) =>
    runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { meta_publish: exec.publish, meta_ads: exec.ads },
    });
  return { graph, exec, run };
}

const itemRow = async (id: string) =>
  (await db.select().from(contentItems).where(eq(contentItems.id, id)))[0]!;
const proposalRow = async (id: string) =>
  (await db.select().from(proposals).where(eq(proposals.id, id)))[0]!;
const executionFor = async (proposalId: string) =>
  (await db.select().from(executions).where(eq(executions.proposal_id, proposalId)))[0];
const attemptsOf = async (executionId: string) =>
  db
    .select()
    .from(executionAttempts)
    .where(eq(executionAttempts.execution_id, executionId))
    .orderBy(executionAttempts.attempt);
const watchLines = async (profileId: string) =>
  (
    await db
      .select({ kind: watchActivity.kind, detail: watchActivity.detail })
      .from(watchActivity)
      .where(eq(watchActivity.profile_id, profileId))
      .orderBy(watchActivity.at)
  ).map((r) => r);
const liveConnection = async (accountId: string, provider: string) =>
  (await listExecutionConnections(accountId)).filter(
    (c) => c.provider === provider && c.status !== "disconnected",
  );

/** Reconnect through the consent door — the pasted route and the Facebook-login finish both land here. */
async function reconnect(b: Biz, provider: "meta_publish" | "meta_ads") {
  return consentToExecution({
    accountId: b.account_id,
    provider,
    secret: provider === "meta_publish" ? publishSecret(NEW_TOKEN) : adsSecret(NEW_ADS_TOKEN),
    confirmation: provider === "meta_publish" ? "allow publishing" : "allow ad changes",
    verify: async () => ({ granted_scopes: expectedExecutionScopes(provider) }),
  });
}

/* ══════════ P3-24b — degrade to paused ══════════ */

describe("P3-24b — what pauses a connection", () => {
  it("the auth class pauses; a permission, rate-limit or unknown refusal does not", () => {
    expect(pausesConnection(classifyMetaError({ status: 400, code: 190, subcode: 463 }))).toBe(
      true,
    );
    expect(pausesConnection(classifyMetaError({ status: 400, code: 102 }))).toBe(true);
    for (const code of [10, 200, 4, 17, 80001, 1, 368]) {
      expect(pausesConnection(classifyMetaError({ status: 400, code }))).toBe(false);
    }
    expect(PAUSED_WORK_SENTENCE.publish).toBe(
      "I couldn't post — the connection expired. Reconnect and I'll pick up where I left off.",
    );
  });
});

describe("P3-24b — an expired token pauses the publishing connection", () => {
  it("met at the pre-flight: paused with its reason, every queued item failed with the sentence, nothing sent", async () => {
    const b = await business();
    const first = await approvedItem(b, { platform: "facebook" });
    const second = await approvedItem(b, { platform: "facebook", title: "Winter menu" });
    const { graph, run } = harness({ expired: new Set([TOKEN]) });

    const summary = await run(b);
    // The first item met the refusal; the second was then held without a call.
    expect(graph.where("POST", "/feed")).toHaveLength(0);
    expect(graph.calls).toHaveLength(1);
    expect(summary.outcomes.map((o) => o.result).sort()).toEqual(["paused", "refused"]);

    const [conn] = await liveConnection(b.account_id, "meta_publish");
    expect(conn?.status).toBe("paused");
    expect(conn?.last_error).toBe(
      "I couldn't reach Meta: the connection's sign-in expired. Reconnect it on Connections and I'll pick up where I left off.",
    );
    expect(conn?.last_error).not.toContain(TOKEN);
    for (const { item_id, proposal_id } of [first, second]) {
      const item = await itemRow(item_id);
      expect(item.status).toBe("failed");
      expect(item.last_error).toBe(PAUSED_WORK_SENTENCE.publish);
      expect(item.paused_connection_id).toBe(conn?.id);
      // /content's state word for it.
      expect(stateWord({ ...item, last_error: item.last_error }, (d) => d).word).toBe("failed");
      // The approval stands; there is no execution to clean up.
      expect((await proposalRow(proposal_id)).status).toBe("approved");
      expect(await executionFor(proposal_id)).toBeUndefined();
    }
    // The watch log, once, in words.
    const lines = (await watchLines(b.profile_id)).filter((l) => l.kind === "connection_paused");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.detail).toBe(
      "Meta publishing (Facebook Page and Instagram) paused itself. I couldn't reach Meta: the connection's sign-in expired. Reconnect it on Connections and I'll pick up where I left off. 2 posts are waiting for the reconnect.",
    );
    // The needs-you count beside Connections.
    expect(await countPausedExecutionConnections(b.account_id)).toBe(1);
  });

  it("a refusal that isn't about the sign-in fails the one item and leaves the connection connected", async () => {
    const b = await business();
    const { item_id } = await approvedItem(b, { platform: "facebook" });
    const other = await approvedItem(b, { platform: "facebook", title: "Winter menu" });
    let feeds = 0;
    const { run } = harness({
      respond: (c) =>
        c.method === "POST" && c.url.pathname.endsWith("/feed") && ++feeds === 1
          ? metaError(368, "The action attempted has been deemed abusive")
          : null,
    });
    await run(b);
    const [conn] = await liveConnection(b.account_id, "meta_publish");
    expect(conn?.status).toBe("connected");
    expect(await countPausedExecutionConnections(b.account_id)).toBe(0);
    const failed = [await itemRow(item_id), await itemRow(other.item_id)].filter(
      (i) => i.status === "failed",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.last_error).toBe("Meta refused with code 368; nothing was published.");
    expect(failed[0]?.paused_connection_id).toBeNull();
    expect(
      (await watchLines(b.profile_id)).filter((l) => l.kind === "connection_paused"),
    ).toHaveLength(0);
  });

  it("met at the publishing call: the run is journaled as waiting, and nothing retries until the reconnect", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    const queued = await approvedItem(b, { platform: "facebook", title: "Winter menu" });
    const expired = new Set<string>();
    const { graph, run } = harness({
      expired,
      // Meta accepts the Page read, then refuses the post: the sign-in died in between.
      onCall: async (c) => {
        if (c.method === "POST" && c.url.pathname.endsWith("/feed")) expired.add(PAGE_TOKEN);
      },
    });
    const first = await run(b);
    expect(first.outcomes.find((o) => o.proposal_id === proposal_id)?.result).toBe("failed");
    expect(graph.posts.size).toBe(0);

    const item = await itemRow(item_id);
    expect(item.status).toBe("failed");
    expect(item.last_error).toBe(PAUSED_WORK_SENTENCE.publish);
    const execution = await executionFor(proposal_id);
    expect(execution?.status).toBe("failed");
    expect(execution?.held_for).toBe("reconnect");
    expect(execution?.error).toBe(PAUSED_WORK_SENTENCE.publish);
    // One attempt: an auth refusal is never retried.
    expect(await attemptsOf(execution!.id)).toHaveLength(1);
    expect((await itemRow(queued.item_id)).status).toBe("failed");

    // While paused: the runner sends nothing at all, however often it runs.
    const callsBefore = graph.calls.length;
    for (let i = 0; i < 2; i++) {
      const again = await run(b);
      expect(again.outcomes.every((o) => o.result === "paused")).toBe(true);
      expect(again.outcomes.length).toBe(2);
    }
    expect(graph.calls.length).toBe(callsBefore);
    expect((await attemptsOf(execution!.id)).length).toBe(1);
  });

  it("reconnecting resumes from the journal: held items back in the queue, held runs re-run, each post sent once", async () => {
    const b = await business();
    const held = await approvedItem(b, { platform: "facebook" });
    const queued = await approvedItem(b, { platform: "facebook", title: "Winter menu" });
    const expired = new Set<string>();
    const { graph, run } = harness({
      expired,
      onCall: async (c) => {
        if (c.method === "POST" && c.url.pathname.endsWith("/feed")) {
          expired.add(TOKEN);
          expired.add(PAGE_TOKEN);
        }
      },
    });
    await run(b);
    const paused = (await liveConnection(b.account_id, "meta_publish"))[0]!;
    expect(paused.status).toBe("paused");
    expect((await executionFor(held.proposal_id))?.held_for).toBe("reconnect");

    // The owner reconnects (a new token, through the consent door).
    const out = await reconnect(b, "meta_publish");
    expect(out.resumed).toBeGreaterThanOrEqual(2);
    const all = await listExecutionConnections(b.account_id);
    expect(all.find((c) => c.id === paused.id)?.status).toBe("disconnected");
    expect((await liveConnection(b.account_id, "meta_publish"))[0]?.status).toBe("connected");
    expect(await countPausedExecutionConnections(b.account_id)).toBe(0);
    for (const { item_id } of [held, queued]) {
      const item = await itemRow(item_id);
      expect(item.status).toBe("queued");
      expect(item.last_error).toBeNull();
      expect(item.paused_connection_id).toBeNull();
    }
    expect(
      (await watchLines(b.profile_id)).filter((l) => l.kind === "connection_resumed")[0]?.detail,
    ).toBe(
      "Meta publishing (Facebook Page and Instagram) is reconnected. 2 posts are back in the queue and go out on the next run, through every check again.",
    );

    // The next run picks up where it left off — with the new token, once each.
    const feedsBefore = graph.where("POST", "/feed").length;
    const next = await run(b);
    expect(next.executed).toBe(2);
    expect(graph.where("POST", "/feed").length - feedsBefore).toBe(2);
    expect(graph.posts.size).toBe(2);
    for (const { item_id, proposal_id } of [held, queued]) {
      expect((await itemRow(item_id)).status).toBe("published");
      const execution = await executionFor(proposal_id);
      expect(execution?.status).toBe("succeeded");
      expect(execution?.held_for).toBeNull();
    }
    const sentWith = graph
      .where("POST", "/feed")
      .slice(-2)
      .map((c) => c.init.headers["authorization"]);
    expect(sentWith).toEqual([`Bearer ${NEW_PAGE_TOKEN}`, `Bearer ${NEW_PAGE_TOKEN}`]);
    // A third run is a no-op.
    expect((await run(b)).due).toBe(0);
  });

  it("never re-sends what may be live: an unconfirmed post is not held, not re-queued, only read back", async () => {
    const b = await business();
    const lost = await approvedItem(b, { platform: "facebook" });
    const expired = new Set<string>();
    const first = harness({
      expired,
      // The post goes out and no answer comes back: it may be live.
      onCall: async (c) => {
        if (c.method === "POST" && c.url.pathname.endsWith("/feed")) {
          throw new Error("socket hang up after the post");
        }
      },
    });
    await first.run(b);
    expect(first.graph.where("POST", "/feed")).toHaveLength(1);
    expect((await itemRow(lost.item_id)).status).toBe("publishing");

    // Later the sign-in expires, and a second, queued item meets it.
    const queued = await approvedItem(b, { platform: "facebook", title: "Winter menu" });
    expired.add(TOKEN);
    await first.run(b);
    expect((await liveConnection(b.account_id, "meta_publish"))[0]?.status).toBe("paused");
    const unconfirmed = await itemRow(lost.item_id);
    expect(unconfirmed.status).toBe("publishing");
    expect(unconfirmed.paused_connection_id).toBeNull();
    expect((await itemRow(queued.item_id)).status).toBe("failed");
    expect(first.graph.where("POST", "/feed")).toHaveLength(1);

    // Reconnecting re-queues only the held one; the unconfirmed one stays as it is.
    await reconnect(b, "meta_publish");
    expect((await itemRow(lost.item_id)).status).toBe("publishing");
    expect((await itemRow(queued.item_id)).status).toBe("queued");

    const after = harness();
    const next = await after.run(b);
    // The sweep read the unconfirmed one back (with the new token) and sent nothing for it;
    // the held one went out once.
    expect(next.reconciled.checked).toBe(1);
    expect(after.graph.where("POST", "/feed")).toHaveLength(1);
    expect(after.graph.where("GET", "/published_posts").length).toBeGreaterThan(0);
    expect((await itemRow(queued.item_id)).status).toBe("published");
    const still = await itemRow(lost.item_id);
    expect(still.status).toBe("publishing");
    expect(still.last_error).toMatch(/I may have posted this/);
  });
});

describe("P3-24b — the ad executor pauses the same way", () => {
  it("an expired token at the pre-flight pauses the ad connection; nothing retries; the reconnect runs it once", async () => {
    const b = await business({ ads: true });
    const expired = new Set([ADS_TOKEN]);
    const { graph, run } = harness({ expired });
    graph.campaigns.set("120000042", { status: "ACTIVE", daily_budget: 1_000 });
    const proposalId = await adPause(b, "120000042");

    const first = await run(b);
    expect(first.outcomes[0]?.result).toBe("refused");
    expect(first.outcomes[0]?.detail).toContain(PAUSED_WORK_SENTENCE.ad_change);
    const [conn] = await liveConnection(b.account_id, "meta_ads");
    expect(conn?.status).toBe("paused");
    expect(conn?.last_error).toMatch(/sign-in expired/);
    expect((await proposalRow(proposalId)).status).toBe("approved");
    // The publishing connection is untouched: one consent's failure is not the other's.
    expect((await liveConnection(b.account_id, "meta_publish"))[0]?.status).toBe("connected");
    expect(
      (await watchLines(b.profile_id)).find((l) => l.kind === "connection_paused")?.detail,
    ).toMatch(/^Meta ad management paused itself\. /);

    const calls = graph.calls.length;
    const again = await run(b);
    expect(again.outcomes[0]?.result).toBe("paused");
    expect(again.outcomes[0]?.detail).toMatch(/^The Meta ad connection is paused\. /);
    expect(graph.calls.length).toBe(calls);

    await reconnect(b, "meta_ads");
    const next = await run(b);
    expect(next.executed).toBe(1);
    expect(graph.campaigns.get("120000042")?.status).toBe("PAUSED");
    expect(
      graph.calls.filter(
        (c) => c.method === "POST" && c.form.get("execution_options") !== VALIDATE_ONLY,
      ),
    ).toHaveLength(1);
  });

  it("an expired token mid-change holds the run for the reconnect, and the re-run changes it once", async () => {
    const b = await business({ ads: true });
    const expired = new Set<string>();
    let gets = 0;
    const { graph, run } = harness({
      expired,
      // The pre-flight and the undo capture read the campaign; the execute's own read meets the expiry.
      onCall: async (c) => {
        if (c.method === "GET" && c.url.pathname.endsWith("/120000043") && ++gets === 3) {
          expired.add(ADS_TOKEN);
        }
      },
    });
    graph.campaigns.set("120000043", { status: "ACTIVE", daily_budget: 1_000 });
    const proposalId = await adPause(b, "120000043");

    await run(b);
    const execution = await executionFor(proposalId);
    expect(execution?.status).toBe("failed");
    expect(execution?.held_for).toBe("reconnect");
    expect(execution?.error).toBe(PAUSED_WORK_SENTENCE.ad_change);
    expect(graph.campaigns.get("120000043")?.status).toBe("ACTIVE");
    expect((await liveConnection(b.account_id, "meta_ads"))[0]?.status).toBe("paused");

    await reconnect(b, "meta_ads");
    const next = await run(b);
    expect(next.executed).toBe(1);
    expect(graph.campaigns.get("120000043")?.status).toBe("PAUSED");
    const done = await executionFor(proposalId);
    expect(done?.status).toBe("succeeded");
    expect(done?.held_for).toBeNull();
    // The undo captured before the first attempt is the one kept.
    expect(done?.undo_payload).toEqual(execution?.undo_payload);
  });
});

describe("P3-24b — the per-post readback pauses the same way", () => {
  it("a refused sign-in on the readback pauses the connection and holds what is queued; a paused row isn't read", async () => {
    const b = await business();
    const queued = await approvedItem(b, { platform: "facebook" });
    const [conn] = await liveConnection(b.account_id, "meta_publish");
    // One published post to read.
    await db.insert(contentItems).values({
      profile_id: b.profile_id,
      proposal_id: b.plan_id,
      kind: "post",
      channel_label: "facebook",
      title: "Summer menu",
      body: BODY,
      disclosure: LABEL,
      provenance: { test: true },
      status: "published",
      platform: "facebook",
      platform_post_id: `${PAGE}_9001`,
      published_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    const { graph, exec } = harness({ expired: new Set([TOKEN]) });
    const out = await syncPostInsights(conn!.id, new Date(), { readback: exec.readback });
    expect(out.ok).toBe(false);
    expect(out.paused).toBe(true);
    expect((await liveConnection(b.account_id, "meta_publish"))[0]?.status).toBe("paused");
    expect((await itemRow(queued.item_id)).status).toBe("failed");
    expect((await itemRow(queued.item_id)).last_error).toBe(PAUSED_WORK_SENTENCE.publish);

    const calls = graph.calls.length;
    const skipped = await syncPostInsights(conn!.id, new Date(), { readback: exec.readback });
    expect(skipped.skipped).toBe("not_connected");
    expect(graph.calls.length).toBe(calls);
  });
});

/* ══════════ P3-24c — the stop covers everything ══════════ */

describe("P3-24c — a halt between 'due' and 'publish' publishes nothing", () => {
  it("the stop lands during the pre-flight: the attempt never starts, the item is never claimed", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    const { graph, run } = harness({
      onCall: async (c, n) => {
        if (n === 1 && c.method === "GET") await haltExecutions({ accountId: b.account_id });
      },
    });
    const summary = await run(b);
    expect(summary.halted).toBe(1);
    expect(graph.where("POST", "/feed")).toHaveLength(0);
    expect(graph.calls.every((c) => c.method === "GET")).toBe(true);
    expect((await itemRow(item_id)).status).toBe("queued");
    const execution = await executionFor(proposal_id);
    expect(execution?.status).toBe("failed");
    expect(execution?.held_for).toBe("stop");
    expect(await attemptsOf(execution!.id)).toHaveLength(0);
    await resumeExecutions(b.account_id);
  });

  it("the stop lands after the claim, between the Page token and the post: unclaimed, nothing sent", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    let pageReads = 0;
    const { graph, run } = harness({
      onCall: async (c) => {
        if (c.method === "GET" && c.url.pathname === `${V}/${PAGE}` && ++pageReads === 2) {
          await haltExecutions({ accountId: b.account_id });
        }
      },
    });
    const summary = await run(b);
    expect(summary.halted).toBe(1);
    expect(graph.where("POST", "/feed")).toHaveLength(0);
    const item = await itemRow(item_id);
    expect(item.status).toBe("queued");
    expect(item.last_error).toBe(STOPPED_BEFORE_PUBLISH);
    expect((item.publish_attempt as { sent_at?: string } | null)?.sent_at).toBeUndefined();
    const execution = await executionFor(proposal_id);
    expect(execution?.held_for).toBe("stop");
    expect(execution?.status).toBe("failed");
    await resumeExecutions(b.account_id);
  });

  it("while halted, the runner sends nothing at all", async () => {
    const b = await business();
    await approvedItem(b, { platform: "facebook" });
    await haltExecutions({ accountId: b.account_id });
    const { graph, run } = harness();
    const summary = await run(b);
    expect(summary.halted).toBe(1);
    expect(graph.calls).toHaveLength(0);
    await resumeExecutions(b.account_id);
  });
});

describe("P3-24c — a halt mid-carousel leaves no container published", () => {
  const images = [1, 2, 3].map((i) => `https://blob.test.invalid/renders/x/${i}abc.jpg`);

  it("the stop after the first child: no more containers, no parent, no media_publish", async () => {
    let stopped = false;
    const { graph, exec } = harness({
      onCall: async (c) => {
        if (c.method === "POST" && c.url.pathname.endsWith(`/${IG}/media`)) stopped = true;
      },
    });
    await expect(
      exec.instagram({
        igUserId: IG,
        token: TOKEN,
        media: images,
        caption: BODY,
        account_id: "acct",
        halted: async () => stopped,
      }),
    ).rejects.toBeInstanceOf(StopError);
    expect(graph.where("POST", `/${IG}/media`)).toHaveLength(1);
    expect(graph.where("POST", "/media_publish")).toHaveLength(0);
    expect([...graph.containers.values()].some((c) => c.published)).toBe(false);
  });

  it("the stop after the parent is built: refused before media_publish, every container unpublished", async () => {
    let stopped = false;
    const { graph, exec } = harness({
      onCall: async (c) => {
        if (c.method === "POST" && c.form.get("media_type") === "CAROUSEL") stopped = true;
      },
    });
    await expect(
      exec.instagram({
        igUserId: IG,
        token: TOKEN,
        media: images,
        caption: BODY,
        account_id: "acct",
        halted: async () => stopped,
      }),
    ).rejects.toThrow(STOPPED_BEFORE_PUBLISH);
    expect(graph.where("POST", `/${IG}/media`)).toHaveLength(4);
    expect(graph.where("POST", "/media_publish")).toHaveLength(0);
    expect([...graph.containers.values()].every((c) => !c.published)).toBe(true);
  });

  it("no stop: the same carousel publishes once (the control)", async () => {
    const { graph, exec } = harness();
    const post = await exec.instagram({
      igUserId: IG,
      token: TOKEN,
      media: images,
      caption: BODY,
      account_id: "acct",
      halted: async () => false,
    });
    expect(post.platform).toBe("instagram");
    expect(graph.where("POST", "/media_publish")).toHaveLength(1);
  });

  it("through the engine: a stop after the container, before media_publish, puts the item back in the queue", async () => {
    const b = await business();
    const jpg = (
      await store.put(`renders/t/${crypto.randomUUID()}.jpg`, new Uint8Array([1]), "image/jpeg")
    ).url;
    const { item_id, proposal_id } = await approvedItem(b, {
      platform: "instagram",
      media_path: jpg,
    });
    const { graph, run } = harness({
      onCall: async (c) => {
        if (c.method === "POST" && c.url.pathname.endsWith(`/${IG}/media`)) {
          await haltExecutions({ accountId: b.account_id });
        }
      },
    });
    expect((await run(b)).halted).toBe(1);
    expect(graph.where("POST", "/media_publish")).toHaveLength(0);
    expect((await itemRow(item_id)).status).toBe("queued");
    expect((await executionFor(proposal_id))?.held_for).toBe("stop");
    await resumeExecutions(b.account_id);
  });
});

describe("P3-24c — resuming re-evaluates every guard", () => {
  it("gate, watch, schedule and pre-flight each refuse a held run on their own; with all clear it publishes once", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    const halt = harness({
      onCall: async (_c, n) => {
        if (n === 1) await haltExecutions({ accountId: b.account_id });
      },
    });
    await halt.run(b);
    expect((await executionFor(proposal_id))?.held_for).toBe("stop");
    await resumeExecutions(b.account_id);

    // The real-write gate.
    gate(false);
    const offGraph = harness();
    const off = await offGraph.run(b);
    expect(off.outcomes[0]?.detail).toMatch(/^real_writes_off: /);
    expect(offGraph.graph.calls).toHaveLength(0);
    gate(true);

    // The watch.
    await mode(b.profile_id, "watching", new Date());
    const watched = harness();
    expect((await watched.run(b)).outcomes[0]?.detail).toMatch(/^watching: /);
    expect(watched.graph.calls).toHaveLength(0);
    await mode(b.profile_id, "instant", new Date(Date.now() + 1000));

    // The schedule: moved later, it isn't due — and a direct call is refused.
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await db
      .update(proposals)
      .set({ execute_not_before: later })
      .where(eq(proposals.id, proposal_id));
    const early = harness();
    expect((await early.run(b)).due).toBe(0);
    await expect(
      executeProposal({
        proposalId: proposal_id,
        provider: early.exec.publish,
        op: "publish_page_post",
        params: { item_id, platform: "facebook", target: { page_id: PAGE } },
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "scheduled_later" });
    expect(early.graph.calls).toHaveLength(0);
    await db
      .update(proposals)
      .set({ execute_not_before: PAST })
      .where(eq(proposals.id, proposal_id));

    // The pre-flight: Meta says the Page is near its limit.
    const busy = harness({ usage: 80 });
    expect((await busy.run(b)).outcomes[0]?.detail).toMatch(/^deferred: /);
    expect(busy.graph.where("POST", "/feed")).toHaveLength(0);

    // All clear: once, and the hold is gone.
    const clear = harness();
    const done = await clear.run(b);
    expect(done.executed).toBe(1);
    expect(clear.graph.where("POST", "/feed")).toHaveLength(1);
    expect((await itemRow(item_id)).status).toBe("published");
    const execution = await executionFor(proposal_id);
    expect(execution?.status).toBe("succeeded");
    expect(execution?.held_for).toBeNull();
    expect((await clear.run(b)).due).toBe(0);
  });

  it("a hold is only ever on a failed run (a database check)", async () => {
    const b = await business();
    const { proposal_id } = await approvedItem(b, { platform: "facebook" });
    await harness().run(b);
    const execution = await executionFor(proposal_id);
    expect(execution?.status).toBe("succeeded");
    await expect(
      db.update(executions).set({ held_for: "stop" }).where(eq(executions.id, execution!.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(contentItems)
        .set({ paused_connection_id: (await liveConnection(b.account_id, "meta_publish"))[0]!.id })
        .where(eq(contentItems.publish_proposal_id, proposal_id)),
    ).rejects.toThrow();
  });
});

/* ══════════ P3-24d — telemetry ══════════ */

describe("P3-24d — rate-limit usage on every attempt row", () => {
  it("a Meta attempt records every request's usage headers and the highest percentage", async () => {
    const b = await business();
    const { proposal_id } = await approvedItem(b, { platform: "facebook" });
    await harness({ usage: 40 }).run(b);
    const [attempt] = await attemptsOf((await executionFor(proposal_id))!.id);
    const usage = attempt?.usage as {
      max_pct: number | null;
      requests: { request: string; usage_pct: number | null; headers: Record<string, unknown> }[];
    };
    expect(usage.max_pct).toBe(40);
    expect(usage.requests.map((r) => r.request)).toEqual(["page", "page_feed", "page_post"]);
    const pageRead = usage.requests[0]!;
    expect(pageRead.usage_pct).toBe(40);
    expect(pageRead.headers["x-business-use-case-usage"]).toEqual({
      [PAGE]: [{ type: "pages", call_count: 40, total_cputime: 1, total_time: 1 }],
    });
    expect(pageRead.headers["x-app-usage"]).toEqual({
      call_count: 3,
      total_time: 1,
      total_cputime: 1,
    });
    expect(JSON.stringify(usage)).not.toMatch(/EAAFake/);
  });

  it("no headers from Meta: the row still lists the requests, with nothing invented", async () => {
    const b = await business();
    const { proposal_id } = await approvedItem(b, { platform: "facebook" });
    await harness().run(b);
    const [attempt] = await attemptsOf((await executionFor(proposal_id))!.id);
    const usage = attempt?.usage as {
      max_pct: number | null;
      requests: { usage_pct: unknown; headers: object }[];
    };
    expect(usage.max_pct).toBeNull();
    expect(usage.requests.length).toBeGreaterThan(0);
    expect(usage.requests.every((r) => r.usage_pct === null)).toBe(true);
    expect(usage.requests.every((r) => Object.keys(r.headers).length === 0)).toBe(true);
  });

  it("a provider with no platform behind it records null, not an empty reading", async () => {
    const b = await business();
    const p = await createProposal({
      profile_id: b.profile_id,
      module: "site",
      action: { kind: "fixture", summary: "set a value" },
      scenario,
      reversibility: { level: "easy", if_you_change_your_mind: "fixture" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await approveProposal({ proposalId: p.id, userId: b.user_id, profileId: b.profile_id });
    const row = await executeProposal({
      proposalId: p.id,
      provider: fixtureExecutor,
      op: "set_value",
      params: { key: `k-${crypto.randomUUID()}`, value: 1 },
      sleep: noSleep,
    });
    const [attempt] = await attemptsOf(row.id);
    expect(attempt?.ok).toBe(true);
    expect(attempt?.usage).toBeNull();
  });

  it("usageHeaders keeps only the rate-limit headers, parsed", () => {
    const h = (o: Record<string, string>) => (n: string) => o[n] ?? null;
    expect(
      usageHeaders(
        h({
          "x-app-usage": '{"call_count":5}',
          "x-ad-account-usage": '{"acc_id_util_pct":9}',
          authorization: "Bearer secret",
        }),
      ),
    ).toEqual({ "x-app-usage": { call_count: 5 }, "x-ad-account-usage": { acc_id_util_pct: 9 } });
    expect(usageHeaders(h({}))).toEqual({});
  });
});

describe("P3-24d — Blob storage in the ops cost view", () => {
  it("bytes stored × the named price, in integer micro-dollars, read from the store itself", async () => {
    const mem = memoryMediaStore("https://ops.test.invalid");
    await mem.put("renders/a/b/1.jpg", new Uint8Array(1_500), "image/jpeg");
    await mem.put("renders/a/c/2.mp4", new Uint8Array(2_500), "video/mp4");
    await mem.put("elsewhere/3.jpg", new Uint8Array(9_999), "image/jpeg");
    const s = await storageSummary(mem);
    expect(s).toMatchObject({
      known: true,
      store: "memory",
      objects: 2,
      bytes: 4_000,
      currency: "USD",
      within_hobby_included: true,
      price_micro_usd_per_gb_month: BLOB_STORAGE_MICRO_USD_PER_GB_MONTH,
    });
    if (s.known) expect(s.monthly_list_micro_usd).toBe(blobMonthlyMicroUsd(4_000));
    expect(Number.isInteger(blobMonthlyMicroUsd(4_000))).toBe(true);
  });

  it("the arithmetic at its edges: nothing costs nothing, a byte rounds up, a GB is the list price", () => {
    expect(blobMonthlyMicroUsd(0)).toBe(0);
    expect(blobMonthlyMicroUsd(1)).toBe(1);
    expect(blobMonthlyMicroUsd(1_000_000_000)).toBe(BLOB_STORAGE_MICRO_USD_PER_GB_MONTH);
    expect(blobMonthlyMicroUsd(2_000_000_000)).toBe(2 * BLOB_STORAGE_MICRO_USD_PER_GB_MONTH);
  });

  it("a store that can't be read is unknown, never zero", async () => {
    const broken: MediaStore = {
      kind: "vercel_blob",
      put: async () => {
        throw new Error("no");
      },
      del: async () => undefined,
      usage: async () => {
        throw new Error("BLOB_READ_WRITE_TOKEN is not set");
      },
    };
    const s = await storageSummary(broken);
    expect(s.known).toBe(false);
    expect(s).not.toHaveProperty("bytes");
  });
});

describe("P3-24d — one structured line per publish", () => {
  type LogSpy = { mock: { calls: unknown[][] } };
  const lines = (spy: LogSpy) =>
    spy.mock.calls
      .map((args) => String(args[0]))
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("published: exactly one line, with account, platform, item, attempt and outcome — and no token anywhere", async () => {
    const b = await business();
    const { item_id } = await approvedItem(b, { platform: "facebook" });
    const spy = vi.spyOn(console, "log");
    await harness({ usage: 10 }).run(b);
    const all = lines(spy);
    const publish = all.filter((l) => l["event"] === "content_publish" && l["phase"] === "publish");
    expect(publish).toHaveLength(1);
    expect(publish[0]).toMatchObject({
      account_id: b.account_id,
      platform: "facebook",
      item_id,
      attempt: 1,
      outcome: "published",
    });
    const raw = spy.mock.calls.map((a) => a.map(String).join(" ")).join("\n");
    for (const t of ALL_TOKENS) expect(raw).not.toContain(t);
  });

  it("failed and paused publishes get their one line too, with the outcome named", async () => {
    const b = await business();
    const refused = await approvedItem(b, { platform: "facebook" });
    const spy = vi.spyOn(console, "log");
    await harness({
      respond: (c) =>
        c.method === "POST" && c.url.pathname.endsWith("/feed")
          ? metaError(368, "The action attempted has been deemed abusive")
          : null,
    }).run(b);
    const failed = lines(spy).filter(
      (l) => l["event"] === "content_publish" && l["phase"] === "publish",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ item_id: refused.item_id, attempt: 1, outcome: "failed" });

    const b2 = await business();
    const held = await approvedItem(b2, { platform: "facebook" });
    spy.mockClear();
    const expired = new Set<string>();
    await harness({
      expired,
      onCall: async (c) => {
        if (c.method === "POST" && c.url.pathname.endsWith("/feed")) expired.add(PAGE_TOKEN);
      },
    }).run(b2);
    const paused = lines(spy).filter(
      (l) => l["event"] === "content_publish" && l["phase"] === "publish",
    );
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({
      account_id: b2.account_id,
      platform: "facebook",
      item_id: held.item_id,
      attempt: 1,
      outcome: "paused",
    });
    const raw = spy.mock.calls.map((a) => a.map(String).join(" ")).join("\n");
    for (const t of ALL_TOKENS) expect(raw).not.toContain(t);
  });
});

/* ── the refusal reaches the engine's caller in words ── */

describe("P3-24b — the engine says why it waits", () => {
  it("a direct call on a paused connection is refused before anything is claimed", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    await db
      .update(connections)
      .set({ status: "paused", last_error: "paused for the test" })
      .where(eq(connections.account_id, b.account_id));
    const { graph, exec } = harness();
    await expect(
      executeProposal({
        proposalId: proposal_id,
        provider: exec.publish,
        op: "publish_page_post",
        params: { item_id, platform: "facebook", target: { page_id: PAGE } },
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(ExecutionRefused);
    expect(graph.calls).toHaveLength(0);
    expect(await executionFor(proposal_id)).toBeUndefined();
  });
});
