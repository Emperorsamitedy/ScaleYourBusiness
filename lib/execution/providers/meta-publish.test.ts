// P3-21b/c/d — the publish path, end to end through the engine and the due
// runner, against a recorded-shape fake Graph API. No real network: the
// global fetch fails the test if it is ever touched, and every assertion
// about what was sent reads the fake's own call log.
//
// What these tests hold:
//
//   · THE REAL-WRITE GATE. Off by default: the runner refuses a publish by
//     name, sends nothing (not even a read), leaves the item untouched and
//     the proposal approved. On: it publishes. The emergency stop still
//     overrides an open gate.
//   · THE OPS (P3-21b). Facebook feed, photos (the Blob URL), Reels by
//     resumable upload; Instagram container → status_code poll (capped) →
//     media_publish, single image, Reel and carousel; JPEG only;
//     is_ai_generated on every container; the disclosure on every Facebook
//     caption; no native scheduling; limits checked before anything is sent.
//   · UNDO (P3-21c). {platform, target ids} captured before attempt one;
//     DELETE of the post or media; the item withdrawn, its id kept.
//   · AT-MOST-ONCE (P3-21d). A lost answer is read back, never re-sent: in
//     the same run, after a run that failed, and after a run that died.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../../db";
import {
  accounts,
  businessProfiles,
  connections,
  contentItems,
  executionAttempts,
  executions,
  fieldRecords,
  intakeEvents,
  modeDecisions,
  proposals,
  users,
  watchActivity,
} from "../../../db/schema";
import { metaError } from "../../connectors/providers/meta-fake";
import { PUBLISH_UNDO, publishReadiness } from "../../content/publish";
import { dbPublishBackend, withdrawItem } from "../../content/publishing";
import { memoryMediaStore } from "../../content/media";
import { bootstrapIntake } from "../../intake/service";
import { approveProposal, createProposal, rejectProposal } from "../../proposals/service";
import { connectForExecution, expectedExecutionScopes } from "../connections";
import { runDueExecutions } from "../due";
import { haltExecutions, resumeExecutions } from "../engine";
import type {
  MetaExecFetch,
  MetaExecRequestInit,
  MetaExecResponse,
  PublishBackend,
  PublishPlatform,
} from "./meta";
import {
  IG_POLL_MAX,
  MAY_HAVE_POSTED,
  captionHash,
  createMetaExecution,
  mediaKindOf,
  publishCaption,
  publishOpFor,
  usagePercent,
} from "./meta";

const TOKEN = "EAAFakePublishSystemUserTokenForTests";
const PAGE_TOKEN = "EAAFakePublishPageTokenForTests";
const PAGE = "1000000001";
const OTHER_PAGE = "1000000009";
const IG = "17800000000000001";
const V = "/v26.0";
const LABEL = "Written with AI assistance.";
const BODY = `The soup is back.\n\n${LABEL}`;
const noSleep = async () => undefined;
const PAST = new Date(Date.now() - 3_600_000).toISOString();

/* ── no real network, anywhere in this file ── */

const realFetchUsed = vi.fn(async () => {
  throw new Error("a real fetch was attempted in a P3-21 test");
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

/* ── the fake Graph API ── */

interface Call {
  method: string;
  url: URL;
  init: MetaExecRequestInit;
  form: URLSearchParams;
}

interface FakeOptions {
  /** Return a response, "no_answer" (the request never comes back), or null for default. */
  respond?: (call: Call) => MetaExecResponse | "no_answer" | null;
  /** The publishing call lands on Meta, then its answer is lost. */
  loseAnswerOf?: "page_feed" | "ig_publish";
  /** IN_PROGRESS answers before a container is FINISHED (Infinity = never). */
  containerPolls?: number;
  /** The Page's business-use-case usage, in percent, on the Page read. */
  usage?: number;
  /** Instagram's quota_usage of the 100 a day. */
  quota?: number;
}

function ok(body: unknown, headers: Record<string, string> = {}): MetaExecResponse {
  return { status: 200, json: async () => body, header: (n) => headers[n] ?? null };
}

function fakeGraph(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  const posts = new Map<string, { message: string; created_time: string }>();
  const reels = new Map<string, { uploaded: boolean; published: boolean }>();
  const containers = new Map<
    string,
    { params: Record<string, string>; polls: number; published: boolean }
  >();
  const media = new Map<string, { caption: string; timestamp: string }>();
  let n = 0;
  const next = () => String(++n).padStart(4, "0");
  const nowIso = () => new Date().toISOString();

  const fetch: MetaExecFetch = async (raw, init) => {
    const url = new URL(raw);
    const form = new URLSearchParams(init.body ?? "");
    const call: Call = { method: init.method, url, init, form };
    calls.push(call);
    const forced = opts.respond?.(call) ?? null;
    if (forced === "no_answer") throw new Error("socket hang up");
    if (forced !== null) return forced;

    const auth = init.headers["authorization"];
    const path = url.pathname;
    if (url.origin === "https://rupload.facebook.com") {
      const id = path.split("/").pop() ?? "";
      if (auth !== `OAuth ${PAGE_TOKEN}` || !init.headers["file_url"] || !reels.has(id)) {
        return metaError(190, "Invalid upload");
      }
      reels.get(id)!.uploaded = true;
      return ok({ success: true });
    }
    if (url.origin !== "https://graph.facebook.com") throw new Error(`not Meta: ${url.origin}`);
    if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${PAGE_TOKEN}`) {
      return metaError(190, "Invalid OAuth access token");
    }
    const asPage = auth === `Bearer ${PAGE_TOKEN}`;
    const m = init.method;

    // Facebook
    if (m === "GET" && (path === `${V}/${PAGE}` || path === `${V}/${OTHER_PAGE}`)) {
      const id = path.slice(V.length + 1);
      return ok(
        { id, access_token: PAGE_TOKEN },
        opts.usage === undefined
          ? {}
          : {
              "x-business-use-case-usage": JSON.stringify({
                [id]: [{ type: "pages", call_count: opts.usage, total_cputime: 1, total_time: 1 }],
              }),
            },
      );
    }
    if (m === "POST" && path === `${V}/${PAGE}/feed` && asPage) {
      const id = `${PAGE}_${next()}`;
      posts.set(id, { message: form.get("message") ?? "", created_time: nowIso() });
      if (opts.loseAnswerOf === "page_feed") throw new Error("socket hang up after the post");
      return ok({ id });
    }
    if (m === "POST" && path === `${V}/${PAGE}/photos` && asPage) {
      const photo = `9${next()}000000`;
      const id = `${PAGE}_${next()}`;
      posts.set(id, { message: form.get("message") ?? "", created_time: nowIso() });
      return ok({ id: photo, post_id: id });
    }
    if (m === "POST" && path === `${V}/${PAGE}/video_reels` && asPage) {
      if (form.get("upload_phase") === "start") {
        const id = `3000000${next()}`;
        reels.set(id, { uploaded: false, published: false });
        return ok({ video_id: id, upload_url: `https://rupload.facebook.com/video-upload/${id}` });
      }
      const id = form.get("video_id") ?? "";
      const reel = reels.get(id);
      if (!reel?.uploaded) return metaError(100, "Upload not complete");
      reel.published = true;
      posts.set(id, { message: form.get("description") ?? "", created_time: nowIso() });
      return ok({ success: true });
    }
    if (m === "GET" && path === `${V}/${PAGE}/published_posts`) {
      const since = Number(url.searchParams.get("since") ?? "0") * 1000;
      return ok({
        data: [...posts.entries()]
          .filter(([, p]) => Date.parse(p.created_time) >= since)
          .map(([id, p]) => ({ id, message: p.message, created_time: p.created_time })),
      });
    }

    // Instagram
    if (m === "GET" && path === `${V}/${IG}/content_publishing_limit`) {
      return ok({ data: [{ quota_usage: opts.quota ?? 3, config: { quota_total: 100 } }] });
    }
    if (m === "POST" && path === `${V}/${IG}/media`) {
      const id = `1790${next()}`;
      containers.set(id, { params: Object.fromEntries(form), polls: 0, published: false });
      return ok({ id });
    }
    if (m === "POST" && path === `${V}/${IG}/media_publish`) {
      const c = containers.get(form.get("creation_id") ?? "");
      if (!c || c.polls <= (opts.containerPolls ?? 0)) return metaError(9007, "Media not ready");
      c.published = true;
      const id = `1791${next()}`;
      media.set(id, { caption: c.params["caption"] ?? "", timestamp: nowIso() });
      if (opts.loseAnswerOf === "ig_publish") throw new Error("socket hang up after publish");
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

    // Objects by id: containers, media, posts, reels
    const id = decodeURIComponent(path.slice(V.length + 1));
    if (m === "GET" && containers.has(id)) {
      const c = containers.get(id)!;
      c.polls += 1;
      const status = c.published
        ? "PUBLISHED"
        : c.polls <= (opts.containerPolls ?? 0)
          ? "IN_PROGRESS"
          : "FINISHED";
      return ok({ id, status_code: status });
    }
    if (m === "GET" && media.has(id))
      return ok({ id, permalink: `https://www.instagram.com/p/${id}/` });
    if (m === "GET" && reels.has(id)) {
      const r = reels.get(id)!;
      return ok({
        id,
        status: {
          video_status: "ready",
          publishing_phase: { status: r.published ? "complete" : "not_started" },
        },
      });
    }
    if (m === "GET" && posts.has(id)) {
      return ok({ id, permalink_url: `https://www.facebook.com/permalink/${id}` });
    }
    if (m === "DELETE" && (posts.has(id) || reels.has(id)) && asPage) {
      posts.delete(id);
      reels.delete(id);
      return ok({ success: true });
    }
    if (m === "DELETE" && media.has(id) && !asPage) {
      media.delete(id);
      return ok({ success: true });
    }
    return metaError(100, "Unsupported request. Object does not exist or missing permissions", 33);
  };

  const where = (method: string, suffix: string) =>
    calls.filter((c) => c.method === method && c.url.pathname.endsWith(suffix));
  return { fetch, calls, posts, reels, containers, media, where };
}

/* ── a business with a connected Meta publishing asset ── */

const created: { account_id: string; profile_id: string }[] = [];
const store = memoryMediaStore();

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

async function business(pageId = PAGE) {
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
      email: `p3-21-${crypto.randomUUID()}@test.local`,
      display_name: "P3-21 owner",
      role: "owner",
    })
    .returning({ id: users.id });
  await connectForExecution({
    accountId: s.account_id,
    provider: "meta_publish",
    secret: JSON.stringify({ access_token: TOKEN, page_id: pageId, ig_user_id: IG }),
    verify: async () => ({ granted_scopes: expectedExecutionScopes("meta_publish") }),
  });
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

async function render(ext: "jpg" | "png" | "mp4"): Promise<string> {
  const stored = await store.put(
    `renders/test/${crypto.randomUUID()}/${crypto.randomUUID().replace(/-/g, "")}.${ext}`,
    new Uint8Array([1, 2, 3]),
    ext === "mp4" ? "video/mp4" : `image/${ext === "jpg" ? "jpeg" : "png"}`,
  );
  return stored.url;
}

/** A drafted item with its own publish proposal, approved to go out in the past. */
async function approvedItem(
  b: Biz,
  args: {
    platform: PublishPlatform;
    media_path?: string | null;
    body?: string;
    disclosure?: string;
    kind?: "post" | "video";
    target?: string;
    approve?: boolean;
    provenance?: Record<string, unknown>;
  },
) {
  const [item] = await db
    .insert(contentItems)
    .values({
      profile_id: b.profile_id,
      proposal_id: b.plan_id,
      kind: args.kind ?? "post",
      channel_label: args.platform,
      scheduled_for: "2026-10-20",
      title: "Autumn menu",
      body: args.body ?? BODY,
      media_path: args.media_path ?? null,
      disclosure: args.disclosure ?? LABEL,
      provenance: args.provenance ?? { test: true },
    })
    .returning();
  const target =
    args.platform === "facebook"
      ? { page_id: args.target ?? PAGE }
      : { ig_user_id: args.target ?? IG };
  const proposal = await createProposal({
    profile_id: b.profile_id,
    module: "content",
    originating_finding: `publish:${item!.id}`,
    action: {
      kind: "content_publishing",
      summary: `Publish "Autumn menu" to ${args.platform}`,
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
  if (args.approve !== false) {
    await approveProposal({
      proposalId: proposal.id,
      userId: b.user_id,
      profileId: b.profile_id,
      executeNotBefore: PAST,
    });
  }
  return { item_id: item!.id, proposal_id: proposal.id };
}

function harness(opts: FakeOptions = {}, backend?: PublishBackend) {
  const graph = fakeGraph(opts);
  const exec = createMetaExecution({
    fetch: graph.fetch,
    sleep: noSleep,
    backend: backend ?? dbPublishBackend({ store }),
  });
  const run = (b: Biz) =>
    runDueExecutions({
      profileId: b.profile_id,
      sleep: noSleep,
      providers: { meta_publish: exec.publish },
    });
  return { graph, exec, run };
}

const itemRow = async (id: string) =>
  (await db.select().from(contentItems).where(eq(contentItems.id, id)))[0]!;
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
const allSent = (calls: { url: URL; form: URLSearchParams }[]) =>
  calls.map((c) => `${c.url.toString()} ${c.form.toString()}`).join("\n");

/* ── pure pieces ── */

describe("P3-21b — the pure pieces", () => {
  it("picks the op from the item's own media; nothing fits an Instagram post with no media", () => {
    expect(publishOpFor("facebook", null)).toBe("publish_page_post");
    expect(publishOpFor("facebook", "https://b.test/x/a.jpg")).toBe("publish_page_photo");
    expect(publishOpFor("facebook", "https://b.test/x/a.png")).toBe("publish_page_photo");
    expect(publishOpFor("facebook", "https://b.test/x/a.mp4")).toBe("publish_page_video");
    expect(publishOpFor("instagram", "https://b.test/x/a.jpg")).toBe("publish_ig_media");
    expect(publishOpFor("instagram", null)).toBeNull();
    expect(publishOpFor("facebook", "https://b.test/x/a.gif")).toBeNull();
    expect(mediaKindOf("https://b.test/x/A.JPEG")).toBe("image/jpeg");
    expect(mediaKindOf("not a url")).toBeNull();
  });

  it("the caption ends with its disclosure, once", () => {
    expect(publishCaption({ body: "Soup.", disclosure: LABEL })).toBe(`Soup.\n\n${LABEL}`);
    expect(publishCaption({ body: BODY, disclosure: LABEL })).toBe(BODY);
  });

  it("reads Meta's usage headers as the highest percentage, or null when absent", () => {
    const h = (o: Record<string, string>) => (n: string) => o[n] ?? null;
    expect(usagePercent(h({}))).toBeNull();
    expect(
      usagePercent(
        h({
          "x-app-usage": JSON.stringify({ call_count: 12, total_time: 5, total_cputime: 3 }),
          "x-business-use-case-usage": JSON.stringify({
            [PAGE]: [{ type: "pages", call_count: 80, total_time: 9, total_cputime: 4 }],
          }),
        }),
      ),
    ).toBe(80);
    expect(usagePercent(h({ "x-app-usage": "not json" }))).toBeNull();
  });

  it("an Instagram PNG isn't proposed for publishing; a JPEG is", () => {
    const item = {
      kind: "post",
      status: "drafted",
      channel_label: "instagram",
      scheduled_for: "2026-10-20",
      media_path: "https://b.test/x/a.png",
      publish_proposal_id: null,
    };
    const assets = { page_id: PAGE, ig_user_id: IG };
    const args = { platform: "instagram", assets, zone: "Europe/Budapest" };
    expect(publishReadiness({ ...args, item })).toEqual({
      ok: false,
      reason: "Instagram takes JPEG images only, and this item's image is a PNG",
    });
    expect(
      publishReadiness({ ...args, item: { ...item, media_path: "https://b.test/x/a.jpg" } }).ok,
    ).toBe(true);
  });
});

/* ── the gate ── */

describe("THE REAL-WRITE GATE (Session D, D2 done-when)", () => {
  it("off: refused by name, nothing sent, the item untouched and the proposal still approved; on: published", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    const { graph, run } = harness();

    gate(false);
    const off = await run(b);
    expect(off.refused).toBe(1);
    expect(off.executed).toBe(0);
    expect(off.outcomes[0]?.detail).toMatch(
      /^real_writes_off: Meta publishing \(Facebook Page and Instagram\) is switched off until the two-week unattended test completes\. Nothing was sent; this stays approved/,
    );
    expect(graph.calls).toHaveLength(0); // not even a read
    const untouched = await itemRow(item_id);
    expect(untouched).toMatchObject({
      status: "queued",
      last_error: null,
      publish_attempt: null,
      publish_execution_id: null,
      platform_post_id: null,
    });
    expect((await proposalRow(proposal_id)).status).toBe("approved");
    expect(await executionFor(proposal_id)).toBeUndefined();

    gate(true);
    const on = await run(b);
    expect(on.executed).toBe(1);
    expect((await itemRow(item_id)).status).toBe("published");
    expect(graph.where("POST", "/feed")).toHaveLength(1);
  });

  it('anything but exactly "on" is off', async () => {
    const b = await business();
    await approvedItem(b, { platform: "facebook" });
    const { graph, run } = harness();
    process.env.SESSION_D_REAL_WRITES = "true";
    expect((await run(b)).refused).toBe(1);
    expect(graph.calls).toHaveLength(0);
  });

  it("the emergency stop overrides an open gate: a halted account publishes nothing", async () => {
    const b = await business();
    const { item_id } = await approvedItem(b, { platform: "facebook" });
    const { graph, run } = harness();
    await haltExecutions({ accountId: b.account_id, reason: "test" });
    const halted = await run(b);
    expect(halted.halted).toBe(1);
    expect(graph.calls).toHaveLength(0);
    expect((await itemRow(item_id)).status).toBe("queued");
    await resumeExecutions(b.account_id);
    expect((await run(b)).executed).toBe(1);
  });
});

/* ── the ops ── */

describe("P3-21b — Facebook", () => {
  it("a text post: one POST to /feed with the Page token, disclosed, never scheduled; recorded once", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    const { graph, run } = harness();

    const first = await run(b);
    expect(first.executed).toBe(1);
    const [feed] = graph.where("POST", "/feed");
    expect(feed?.init.headers["authorization"]).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(feed?.form.get("message")).toBe(BODY);
    expect(allSent(graph.calls)).not.toMatch(/scheduled_publish_time|published=false/);
    for (const c of graph.calls) expect(c.url.toString()).not.toContain(TOKEN);

    const item = await itemRow(item_id);
    expect(item).toMatchObject({ status: "published", platform: "facebook", last_error: null });
    expect(graph.posts.has(item.platform_post_id!)).toBe(true);
    expect(item.platform_url).toBe(`https://www.facebook.com/permalink/${item.platform_post_id}`);
    expect(item.published_at).not.toBeNull();
    expect(await watchLines(b.profile_id)).toContain("Published 'Autumn menu' to Facebook.");

    const execution = await executionFor(proposal_id);
    expect(execution).toMatchObject({ status: "succeeded", provider: "meta_publish" });
    expect(execution?.op).toBe("publish_page_post");
    // P3-21c: {platform, target ids}, captured before attempt one.
    expect(execution?.undo_payload).toEqual({
      platform: "facebook",
      item_id,
      target: { page_id: PAGE },
    });
    expect((await proposalRow(proposal_id)).status).toBe("executed");

    const callsBefore = graph.calls.length;
    const second = await run(b);
    expect(second.due).toBe(0);
    expect(graph.calls).toHaveLength(callsBefore); // a no-op: not even a read
  });

  it("a link the item carries goes out as the post's link; anything but https is left off", async () => {
    const b = await business();
    await approvedItem(b, {
      platform: "facebook",
      provenance: { link: "https://emberandoak.example/menu" },
    });
    await approvedItem(b, { platform: "facebook", provenance: { link: "javascript:alert(1)" } });
    const { graph, run } = harness();
    expect((await run(b)).executed).toBe(2);
    const links = graph.where("POST", "/feed").map((c) => c.form.get("link"));
    expect(links.sort()).toEqual(["https://emberandoak.example/menu", null].sort());
  });

  it("a caption without its label gets it; an item whose disclosure isn't a real label is never sent", async () => {
    const b = await business();
    const bare = await approvedItem(b, { platform: "facebook", body: "The soup is back." });
    const { graph, run } = harness();
    await run(b);
    expect(graph.where("POST", "/feed")[0]?.form.get("message")).toBe(
      `The soup is back.\n\n${LABEL}`,
    );
    expect((await itemRow(bare.item_id)).status).toBe("published");

    const b2 = await business();
    const fake = await approvedItem(b2, {
      platform: "facebook",
      body: "The soup is back.",
      disclosure: "Made by robots, maybe.",
    });
    const h2 = harness();
    const out = await h2.run(b2);
    expect(out.failed).toBe(1);
    expect(h2.graph.where("POST", "/feed")).toHaveLength(0);
    expect(await itemRow(fake.item_id)).toMatchObject({
      status: "failed",
      last_error: expect.stringMatching(/without its AI disclosure \(rule 17\) — nothing was sent/),
    });
  });

  it("a photo goes up from its Blob URL, its post id is kept, and the render leaves public storage", async () => {
    const b = await business();
    const url = await render("jpg");
    const { item_id } = await approvedItem(b, { platform: "facebook", media_path: url });
    const { graph, run } = harness();
    expect((await run(b)).executed).toBe(1);
    const [photo] = graph.where("POST", "/photos");
    expect(photo?.form.get("url")).toBe(url);
    expect(photo?.form.get("message")).toBe(BODY);
    const item = await itemRow(item_id);
    expect(item.platform_post_id).toMatch(new RegExp(`^${PAGE}_`));
    expect(item.media_path).toBeNull();
    expect(store.read(url)).toBeNull();
  });

  it("a video goes out as a Reel by resumable upload: start, upload by URL, finish with the disclosed caption", async () => {
    const b = await business();
    const url = await render("mp4");
    const caption =
      "Behind the counter.\n\nAI-assisted edit of real footage. No AI-generated imagery.";
    const { item_id, proposal_id } = await approvedItem(b, {
      platform: "facebook",
      kind: "video",
      media_path: url,
      body: caption,
      disclosure: "AI-assisted edit of real footage. No AI-generated imagery.",
    });
    const { graph, run } = harness();
    expect((await run(b)).executed).toBe(1);
    const reels = graph.where("POST", "/video_reels");
    expect(reels.map((c) => c.form.get("upload_phase"))).toEqual(["start", "finish"]);
    const upload = graph.calls.find((c) => c.url.origin === "https://rupload.facebook.com");
    expect(upload?.init.headers["authorization"]).toBe(`OAuth ${PAGE_TOKEN}`);
    expect(upload?.init.headers["file_url"]).toBe(url);
    expect(upload?.url.pathname).toMatch(/^\/video-upload\/v26\.0\/3000000/);
    expect(reels[1]?.form.get("video_state")).toBe("PUBLISHED");
    expect(reels[1]?.form.get("description")).toBe(caption);
    const item = await itemRow(item_id);
    expect(item.platform_post_id).toBe(reels[1]?.form.get("video_id"));
    expect(item.platform_url).toBe(`https://www.facebook.com/reel/${item.platform_post_id}`);
    expect((await executionFor(proposal_id))?.op).toBe("publish_page_video");
  });

  it("Meta's usage at 75% or more defers before anything is sent; under it, the post goes", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    const busy = harness({ usage: 80 });
    const out = await busy.run(b);
    expect(out.refused).toBe(1);
    expect(out.outcomes[0]?.detail).toMatch(/^deferred: Meta says this Page has used 80%/);
    expect(busy.graph.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(await itemRow(item_id)).toMatchObject({
      status: "queued",
      last_error: expect.stringMatching(/goes out on the next run/),
    });
    expect((await proposalRow(proposal_id)).status).toBe("approved");
    expect(await executionFor(proposal_id)).toBeUndefined();

    const calm = harness({ usage: 74 });
    expect((await calm.run(b)).executed).toBe(1);
  });

  it("a connection that now points at another Page refuses before anything is sent", async () => {
    const b = await business(OTHER_PAGE);
    const { item_id } = await approvedItem(b, { platform: "facebook", target: PAGE });
    const { graph, run } = harness();
    const out = await run(b);
    expect(out.refused).toBe(1);
    expect(out.outcomes[0]?.detail).toMatch(/now points at 1000000009\. Nothing was sent/);
    expect(graph.calls).toHaveLength(0);
    expect((await itemRow(item_id)).status).toBe("queued");
  });

  it("a definite refusal: nothing went out, the owner's sentence, and the engine stops at once", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    const { graph, run } = harness({
      respond: (c) =>
        c.url.pathname.endsWith("/feed") ? metaError(100, "Invalid parameter") : null,
    });
    expect((await run(b)).failed).toBe(1);
    expect(graph.where("POST", "/feed")).toHaveLength(1);
    expect(await itemRow(item_id)).toMatchObject({
      status: "failed",
      last_error: "Meta refused with code 100; nothing was published.",
    });
    const execution = await executionFor(proposal_id);
    expect(execution).toMatchObject({ status: "failed", attempts: 1 });
    // The undo target was stored before attempt one, even though it failed.
    expect(execution?.undo_payload).toMatchObject({ platform: "facebook", item_id });
  });

  it("a rate-limit refusal is retried to the cap — Meta did nothing, so one post results", async () => {
    const b = await business();
    let refusals = 2;
    const { item_id } = await approvedItem(b, { platform: "facebook" });
    const { graph, run } = harness({
      respond: (c) =>
        c.url.pathname.endsWith("/feed") && refusals-- > 0
          ? metaError(17, "User request limit reached")
          : null,
    });
    expect((await run(b)).executed).toBe(1);
    expect(graph.where("POST", "/feed")).toHaveLength(3);
    expect(graph.posts.size).toBe(1);
    expect((await itemRow(item_id)).status).toBe("published");
  });
});

describe("P3-21b — Instagram", () => {
  it("one JPEG: limit checked, container with is_ai_generated, status polled, media_publish once", async () => {
    const b = await business();
    const url = await render("jpg");
    const { item_id } = await approvedItem(b, { platform: "instagram", media_path: url });
    const { graph, run } = harness({ containerPolls: 2 });
    expect((await run(b)).executed).toBe(1);

    expect(graph.where("GET", "/content_publishing_limit")).toHaveLength(1);
    const [container] = graph.where("POST", `/${IG}/media`);
    expect(Object.fromEntries(container!.form)).toEqual({
      image_url: url,
      caption: BODY,
      is_ai_generated: "true",
    });
    const id = [...graph.containers.keys()][0]!;
    expect(graph.where("GET", `/${id}`)).toHaveLength(3); // IN_PROGRESS, IN_PROGRESS, FINISHED
    const publishes = graph.where("POST", "/media_publish");
    expect(publishes).toHaveLength(1);
    expect(publishes[0]?.form.get("creation_id")).toBe(id);
    expect(publishes[0]?.init.headers["authorization"]).toBe(`Bearer ${TOKEN}`);

    const item = await itemRow(item_id);
    expect(item).toMatchObject({ status: "published", platform: "instagram" });
    expect(graph.media.has(item.platform_post_id!)).toBe(true);
    expect(item.platform_url).toBe(`https://www.instagram.com/p/${item.platform_post_id}/`);
    expect(store.read(url)).toBeNull();
    expect(await watchLines(b.profile_id)).toContain("Published 'Autumn menu' to Instagram.");
  });

  it("a video is a REELS container, flagged as AI-assisted", async () => {
    const b = await business();
    const url = await render("mp4");
    await approvedItem(b, { platform: "instagram", media_path: url, kind: "video" });
    const { graph, run } = harness();
    expect((await run(b)).executed).toBe(1);
    expect(Object.fromEntries(graph.where("POST", `/${IG}/media`)[0]!.form)).toEqual({
      media_type: "REELS",
      video_url: url,
      caption: BODY,
      is_ai_generated: "true",
    });
  });

  it("a carousel: every child and the parent flagged, one media_publish of the parent", async () => {
    const { graph, exec } = harness();
    const urls = ["https://b.test/a/1.jpg", "https://b.test/a/2.jpg", "https://b.test/a/3.jpg"];
    const post = await exec.instagram({
      igUserId: IG,
      token: TOKEN,
      media: urls,
      caption: BODY,
      account_id: "a",
    });
    const containers = graph.where("POST", `/${IG}/media`).map((c) => Object.fromEntries(c.form));
    expect(containers).toHaveLength(4);
    for (const [i, url] of urls.entries()) {
      expect(containers[i]).toEqual({
        image_url: url,
        is_carousel_item: "true",
        is_ai_generated: "true",
      });
    }
    const ids = [...graph.containers.keys()];
    expect(containers[3]).toEqual({
      media_type: "CAROUSEL",
      children: ids.slice(0, 3).join(","),
      caption: BODY,
      is_ai_generated: "true",
    });
    const publishes = graph.where("POST", "/media_publish");
    expect(publishes.map((c) => c.form.get("creation_id"))).toEqual([ids[3]]);
    expect(graph.media.has(post.platform_post_id)).toBe(true);
    // A carousel with a PNG in it is refused before any container exists.
    const png = harness();
    await expect(
      png.exec.instagram({
        igUserId: IG,
        token: TOKEN,
        media: ["https://b.test/a/1.jpg", "https://b.test/a/2.png"],
        caption: BODY,
        account_id: "a",
      }),
    ).rejects.toThrow(/JPEG images only/);
    expect(png.graph.calls).toHaveLength(0);
  });

  it("a PNG is refused before anything is sent, and the queue says why", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, {
      platform: "instagram",
      media_path: await render("png"),
    });
    const { graph, run } = harness();
    const out = await run(b);
    expect(out.refused).toBe(1);
    expect(graph.calls).toHaveLength(0);
    expect(await itemRow(item_id)).toMatchObject({
      status: "queued",
      last_error: "Instagram takes JPEG images only, and this one is a PNG. Nothing was sent.",
    });
    expect((await proposalRow(proposal_id)).status).toBe("approved");
  });

  it("the 100-a-day API limit used up defers, nothing posted; with room, it goes out", async () => {
    const b = await business();
    const url = await render("jpg");
    const { item_id, proposal_id } = await approvedItem(b, {
      platform: "instagram",
      media_path: url,
    });
    const full = harness({ quota: 100 });
    const out = await full.run(b);
    expect(out.refused).toBe(1);
    expect(out.outcomes[0]?.detail).toMatch(/^deferred: Instagram's limit of 100 posts a day/);
    expect(full.graph.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(await executionFor(proposal_id)).toBeUndefined();
    expect((await itemRow(item_id)).status).toBe("queued");

    const room = harness({ quota: 99 });
    expect((await room.run(b)).executed).toBe(1);
  });

  it("polling is capped: a container that never finishes is never published", async () => {
    const b = await business();
    const { item_id } = await approvedItem(b, {
      platform: "instagram",
      media_path: await render("jpg"),
    });
    const { graph, run } = harness({ containerPolls: Number.POSITIVE_INFINITY });
    expect((await run(b)).failed).toBe(1);
    const id = [...graph.containers.keys()][0]!;
    expect(graph.where("GET", `/${id}`)).toHaveLength(IG_POLL_MAX);
    expect(graph.where("POST", "/media_publish")).toHaveLength(0);
    expect(await itemRow(item_id)).toMatchObject({
      status: "failed",
      last_error: expect.stringMatching(/still processing .* Nothing was published/),
    });
  });
});

/* ── at-most-once ── */

describe("P3-21d — at-most-once, stated honestly", () => {
  it("a lost answer, and Meta HAD posted: the next attempt reads back and records it — one post", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    const { graph, run } = harness({ loseAnswerOf: "page_feed" });
    expect((await run(b)).executed).toBe(1);
    expect(graph.where("POST", "/feed")).toHaveLength(1);
    expect(graph.where("GET", "/published_posts")).toHaveLength(1);
    expect(graph.posts.size).toBe(1);
    const item = await itemRow(item_id);
    expect(item.status).toBe("published");
    expect(item.platform_post_id).toBe([...graph.posts.keys()][0]);
    expect((await executionFor(proposal_id))?.status).toBe("succeeded");
  });

  it("a lost answer, and nothing found: it stays publishing with the owner's sentence, and is never re-sent", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    const { graph, run } = harness({
      respond: (c) =>
        c.method === "POST" && c.url.pathname.endsWith("/feed") ? "no_answer" : null,
    });
    expect((await run(b)).failed).toBe(1);
    expect(await itemRow(item_id)).toMatchObject({
      status: "publishing",
      last_error: MAY_HAVE_POSTED.facebook,
    });
    expect(MAY_HAVE_POSTED.facebook).toMatch(/^I may have posted this — check the Page\./);
    expect((await executionFor(proposal_id))?.status).toBe("failed");

    // The next sweep reads back; it does not post.
    await run(b);
    await run(b);
    expect(graph.where("POST", "/feed")).toHaveLength(1);
    expect((await itemRow(item_id)).status).toBe("publishing");
  });

  it("THE CRASH WINDOW: Meta took it, our record didn't land — the next sweep reconciles by reading back", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    const healthy = dbPublishBackend({ store });
    const dying: PublishBackend = {
      ...healthy,
      published: async () => {
        throw new Error("the process died before the record was written");
      },
    };
    const graph = fakeGraph();
    const exec = (backend: PublishBackend) =>
      createMetaExecution({ fetch: graph.fetch, sleep: noSleep, backend }).publish;
    const sweep = (backend: PublishBackend) =>
      runDueExecutions({
        profileId: b.profile_id,
        sleep: noSleep,
        providers: { meta_publish: exec(backend) },
      });

    expect((await sweep(dying)).failed).toBe(1);
    expect(graph.where("POST", "/feed")).toHaveLength(1);
    expect((await itemRow(item_id)).status).toBe("publishing");
    expect((await executionFor(proposal_id))?.status).toBe("failed");

    const next = await sweep(healthy);
    expect(next.reconciled).toEqual({ checked: 1, published: 1, not_sent: 0, uncertain: 0 });
    expect(next.due).toBe(0); // a proposal with an execution row is never re-run
    expect(graph.where("POST", "/feed")).toHaveLength(1); // never two posts
    expect(graph.posts.size).toBe(1);
    const item = await itemRow(item_id);
    expect(item.status).toBe("published");
    expect(item.platform_post_id).toBe([...graph.posts.keys()][0]);
    expect((await executionFor(proposal_id))?.status).toBe("succeeded");
    expect((await proposalRow(proposal_id)).status).toBe("executed");
  });

  it("a run killed mid-publish (its execution left running): stale → read back; fresh → left alone", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    const graph = fakeGraph();
    // Meta has the post; our process died before anything after the send.
    const [exe] = await db
      .insert(executions)
      .values({
        proposal_id,
        profile_id: b.profile_id,
        account_id: b.account_id,
        provider: "meta_publish",
        op: "publish_page_post",
        status: "running",
        undo_payload: { platform: "facebook", item_id, target: { page_id: PAGE } },
      })
      .returning();
    const sentAt = new Date().toISOString();
    await db
      .update(contentItems)
      .set({
        status: "publishing",
        platform: "facebook",
        publish_execution_id: exe!.id,
        publish_attempt: {
          started_at: sentAt,
          sent_at: sentAt,
          caption_sha256: captionHash(BODY),
        },
      })
      .where(eq(contentItems.id, item_id));
    graph.posts.set(`${PAGE}_7777`, { message: BODY, created_time: sentAt });
    const exec = createMetaExecution({
      fetch: graph.fetch,
      sleep: noSleep,
      backend: dbPublishBackend({ store }),
    });
    const sweep = () =>
      runDueExecutions({ profileId: b.profile_id, providers: { meta_publish: exec.publish } });

    // Fresh: another run may still be in flight. Not touched.
    expect((await sweep()).reconciled.checked).toBe(0);
    expect(graph.calls).toHaveLength(0);

    await db
      .update(executions)
      .set({ started_at: new Date(Date.now() - 20 * 60_000).toISOString() })
      .where(eq(executions.id, exe!.id));
    expect((await sweep()).reconciled.published).toBe(1);
    expect(graph.calls.every((c) => c.method === "GET")).toBe(true);
    expect(await itemRow(item_id)).toMatchObject({
      status: "published",
      platform_post_id: `${PAGE}_7777`,
    });
    expect((await executionFor(proposal_id))?.status).toBe("succeeded");
  });

  it("a run killed before the send: provably nothing went out — failed, and said so", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    const [exe] = await db
      .insert(executions)
      .values({
        proposal_id,
        profile_id: b.profile_id,
        account_id: b.account_id,
        provider: "meta_publish",
        op: "publish_page_post",
        status: "running",
        started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      })
      .returning();
    await db
      .update(contentItems)
      .set({
        status: "publishing",
        platform: "facebook",
        publish_execution_id: exe!.id,
        publish_attempt: { started_at: new Date().toISOString(), caption_sha256: "x" },
      })
      .where(eq(contentItems.id, item_id));
    const { graph, run } = harness();
    expect((await run(b)).reconciled.not_sent).toBe(1);
    expect(graph.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(await itemRow(item_id)).toMatchObject({
      status: "failed",
      last_error: "The run stopped before anything was sent to Meta. Nothing was published.",
    });
    expect((await executionFor(proposal_id))?.status).toBe("failed");
  });

  it("Instagram: a lost media_publish answer is read back from the container and the account's media — one post", async () => {
    const b = await business();
    const { item_id } = await approvedItem(b, {
      platform: "instagram",
      media_path: await render("jpg"),
    });
    const { graph, run } = harness({ loseAnswerOf: "ig_publish" });
    expect((await run(b)).executed).toBe(1);
    expect(graph.where("POST", "/media_publish")).toHaveLength(1);
    expect(graph.media.size).toBe(1);
    const item = await itemRow(item_id);
    expect(item.status).toBe("published");
    expect(item.platform_post_id).toBe([...graph.media.keys()][0]);
  });
});

/* ── undo ── */

describe("P3-21c — undo is deletion, through the engine", () => {
  it("Facebook: Withdraw deletes the post with the Page token; the item is withdrawn and keeps its id", async () => {
    const b = await business();
    const { item_id, proposal_id } = await approvedItem(b, { platform: "facebook" });
    const { graph, exec, run } = harness();
    await run(b);
    const postId = (await itemRow(item_id)).platform_post_id!;

    const undone = await withdrawItem({
      itemId: item_id,
      profileId: b.profile_id,
      userId: b.user_id,
      provider: exec.publish,
    });
    expect(undone.status).toBe("undone");
    const [del] = graph.where("DELETE", `/${postId}`);
    expect(del?.init.headers["authorization"]).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(graph.posts.has(postId)).toBe(false);
    expect(await itemRow(item_id)).toMatchObject({ status: "withdrawn", platform_post_id: postId });
    expect(await watchLines(b.profile_id)).toContain("Withdrew 'Autumn menu' from Facebook.");
    expect((await executionFor(proposal_id))?.undone_by).toBe(b.user_id);

    await expect(
      withdrawItem({
        itemId: item_id,
        profileId: b.profile_id,
        userId: b.user_id,
        provider: exec.publish,
      }),
    ).rejects.toThrow("only a published post can be withdrawn — this one is withdrawn");
    expect(graph.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("Instagram: DELETE of the media id with the account's token", async () => {
    const b = await business();
    const { item_id } = await approvedItem(b, {
      platform: "instagram",
      media_path: await render("jpg"),
    });
    const { graph, exec, run } = harness();
    await run(b);
    const mediaId = (await itemRow(item_id)).platform_post_id!;
    await withdrawItem({
      itemId: item_id,
      profileId: b.profile_id,
      userId: b.user_id,
      provider: exec.publish,
    });
    const [del] = graph.where("DELETE", `/${mediaId}`);
    expect(del?.init.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(graph.media.has(mediaId)).toBe(false);
    expect((await itemRow(item_id)).status).toBe("withdrawn");
    expect(await watchLines(b.profile_id)).toContain("Withdrew 'Autumn menu' from Instagram.");
  });

  it("the emergency stop blocks a withdraw too: nothing is deleted", async () => {
    const b = await business();
    const { item_id } = await approvedItem(b, { platform: "facebook" });
    const { graph, exec, run } = harness();
    await run(b);
    await haltExecutions({ accountId: b.account_id });
    await expect(
      withdrawItem({
        itemId: item_id,
        profileId: b.profile_id,
        userId: b.user_id,
        provider: exec.publish,
      }),
    ).rejects.toThrow(/emergency stop/);
    expect(graph.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect((await itemRow(item_id)).status).toBe("published");
    await resumeExecutions(b.account_id);
  });

  it("a foreign profile's item is not found, and nothing is deleted", async () => {
    const b = await business();
    const other = await business();
    const { item_id } = await approvedItem(b, { platform: "facebook" });
    const { graph, exec, run } = harness();
    await run(b);
    await expect(
      withdrawItem({
        itemId: item_id,
        profileId: other.profile_id,
        userId: other.user_id,
        provider: exec.publish,
      }),
    ).rejects.toThrow("no such content item");
    expect(graph.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });
});

/* ── the queue ── */

describe("P3-21e — approving the item queues it", () => {
  it("approval moves drafted → queued; a decline leaves it drafted", async () => {
    const b = await business();
    const yes = await approvedItem(b, { platform: "facebook" });
    expect((await itemRow(yes.item_id)).status).toBe("queued");
    const no = await approvedItem(b, { platform: "facebook", approve: false });
    await rejectProposal({
      proposalId: no.proposal_id,
      userId: b.user_id,
      reason: "not this one",
      profileId: b.profile_id,
    });
    expect((await itemRow(no.item_id)).status).toBe("drafted");
    const rows = await db
      .select({ status: contentItems.status })
      .from(contentItems)
      .where(and(eq(contentItems.profile_id, b.profile_id)));
    expect(rows.map((r) => r.status).sort()).toEqual(["drafted", "queued"]);
  });
});
