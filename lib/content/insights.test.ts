// P3-23a — per-post insights into metric_observations, through the execute
// connection's read-only readback scopes, pulled by the daily connector-sync
// runner. No real network: the global fetch fails the test if touched, and
// every assertion about what was sent reads the fake Graph API's call log.
//
// What these tests hold:
//
//   · THE READS. Instagram: views, reach, total_interactions; Facebook:
//     post_media_view and reactions, with the Page token. Every request a
//     registered GET; the token never in a URL; no *_unique metric and no
//     impressions ever asked for; a Facebook Reel not read at all.
//   · THE ROWS. content.views/reach/interactions.daily with dimensions
//     {platform, platform_post_id}, on the execute connection; a figure Meta
//     leaves out writes no row; a re-read the same day replaces, never
//     duplicates; only posts within the horizon are read.
//   · A MEASURE CONNECTION NEVER GAINS THESE READS. Skipped by name, nothing
//     sent; the measure registry can't hold the readback scopes.
//   · SLICED ROWS STAY OUT OF BUSINESS-WIDE SUMS — anomaly detection, the
//     watch, and the trust series the scorecard reads.
//   · FAILURES. A token Meta refuses fails the run without touching the
//     connection or echoing the token; one post Meta won't answer for is that
//     post's gap, not the run's failure.

import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { connections, connectorSyncs, metricObservations } from "../../db/schema";
import { detectAnomalies } from "../anomaly/detect";
import { metaError } from "../connectors/providers/meta-fake";
import { SCOPE_REGISTRY, verifyGrantedScopes } from "../connectors/scopes";
import { canonicalDimensions } from "../connectors/service";
import { runConnectorSync } from "../connectors/sync";
import { EXECUTION_SCOPE_REGISTRY } from "../execution/scopes";
import type {
  MetaExecFetch,
  MetaExecRequestInit,
  MetaExecResponse,
} from "../execution/providers/meta";
import { META_EXEC_REQUESTS, createMetaExecution } from "../execution/providers/meta";
import { createProposal } from "../proposals/service";
import { readbackForProposal } from "../trust/readback";
import { dailySeries } from "../trust/series";
import { loadWatchReading } from "../watch/signals";
import { POST_INSIGHTS, postObservations, runPostReadback, syncPostInsights } from "./insights";
import {
  FX_PAGE,
  FX_TOKEN,
  fxBusiness,
  fxCleanup,
  fxExecuteConnection,
  fxMeasureMetaAds,
  fxPublishedItem,
  fxScenario,
} from "./readback-fixture";

const NOW = new Date("2026-10-19T06:00:00Z");
const TODAY = "2026-10-19";
const PAGE_TOKEN = "EAAFakeReadbackPageTokenForTests";
const V = "/v26.0";

const realFetchUsed = vi.fn(async () => {
  throw new Error("a real fetch was attempted in a P3-23a test");
});
beforeAll(() => {
  vi.stubGlobal("fetch", realFetchUsed);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await fxCleanup();
});

interface Call {
  url: URL;
  init: MetaExecRequestInit;
}

function ok(body: unknown): MetaExecResponse {
  return { status: 200, json: async () => body, header: () => null };
}

/** A recorded-shape Graph API: Page token, Instagram media insights, Facebook post insights. */
function fakeGraph(
  opts: {
    ig?: Record<string, Record<string, number>>;
    fb?: Record<string, { views?: number; reactions?: Record<string, number> }>;
    respond?: (call: Call) => MetaExecResponse | null;
  } = {},
) {
  const calls: Call[] = [];
  const fetch: MetaExecFetch = async (raw, init) => {
    const call = { url: new URL(raw), init };
    calls.push(call);
    const forced = opts.respond?.(call) ?? null;
    if (forced) return forced;
    const auth = init.headers["authorization"];
    const path = call.url.pathname;
    if (path === `${V}/${FX_PAGE}`) {
      if (auth !== `Bearer ${FX_TOKEN}`) return metaError(190, "Invalid OAuth access token");
      return ok({ id: FX_PAGE, access_token: PAGE_TOKEN });
    }
    const m = /^\/v26\.0\/([^/]+)\/insights$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (opts.ig?.[id]) {
        if (auth !== `Bearer ${FX_TOKEN}`) return metaError(190, "Invalid OAuth access token");
        const wanted = call.url.searchParams.get("metric")?.split(",") ?? [];
        return ok({
          data: wanted
            .filter((name) => opts.ig?.[id]?.[name] !== undefined)
            .map((name) => ({
              name,
              period: "lifetime",
              values: [{ value: opts.ig?.[id]?.[name] }],
              id: `${id}/insights/${name}/lifetime`,
            })),
        });
      }
      const fb = opts.fb?.[id];
      if (fb) {
        if (auth !== `Bearer ${PAGE_TOKEN}`) return metaError(190, "Invalid OAuth access token");
        return ok({
          data: [
            ...(fb.views !== undefined
              ? [{ name: "post_media_view", period: "lifetime", values: [{ value: fb.views }] }]
              : []),
            ...(fb.reactions
              ? [
                  {
                    name: "post_reactions_by_type_total",
                    period: "lifetime",
                    values: [{ value: fb.reactions }],
                  },
                ]
              : []),
          ],
        });
      }
    }
    return metaError(100, "Unsupported get request. Object does not exist", 33);
  };
  const exec = createMetaExecution({ fetch, sleep: async () => undefined });
  return { calls, readback: exec.readback };
}

async function rowsOf(connectionId: string) {
  return db
    .select()
    .from(metricObservations)
    .where(eq(metricObservations.connection_id, connectionId));
}

const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("P3-23a — the reads, through the readback scopes only", () => {
  it("the daily runner reads every recent published post: GETs only, registered paths, no token in a URL", async () => {
    const b = await fxBusiness();
    const conn = await fxExecuteConnection(b.account_id);
    await fxPublishedItem(b, {
      platform: "instagram",
      post_id: "17900000000000001",
      published_at: daysAgo(3),
    });
    await fxPublishedItem(b, {
      platform: "facebook",
      post_id: `${FX_PAGE}_501`,
      published_at: daysAgo(2),
    });
    await fxPublishedItem(b, {
      platform: "facebook",
      post_id: "9000000001",
      published_at: daysAgo(2),
      kind: "video",
    });
    const graph = fakeGraph({
      ig: { "17900000000000001": { views: 2400, reach: 1200, total_interactions: 86 } },
      fb: { [`${FX_PAGE}_501`]: { views: 900, reactions: { like: 30, love: 4 } } },
    });

    const summary = await runConnectorSync(NOW, { postReadback: graph.readback });
    expect(summary.readback).toMatchObject({ ok: 1, failed: 0 });
    expect(summary.readback?.connections).toBeGreaterThanOrEqual(1);

    const registered = new Set([
      `${V}/${FX_PAGE}`,
      `${V}/17900000000000001/insights`,
      `${V}/${encodeURIComponent(`${FX_PAGE}_501`)}/insights`,
    ]);
    expect(graph.calls.length).toBe(3);
    for (const call of graph.calls) {
      expect(call.init.method).toBe("GET");
      expect(call.url.origin).toBe("https://graph.facebook.com");
      expect(registered.has(call.url.pathname)).toBe(true);
      expect(call.url.toString()).not.toContain(FX_TOKEN);
      expect(call.url.toString()).not.toContain(PAGE_TOKEN);
      // Views-based only: no *_unique metric, no impressions, ever.
      expect(call.url.searchParams.get("metric") ?? "").not.toMatch(/_unique|impressions/);
    }
    // The Facebook Reel was never asked about: its insights need a scope this consent lacks.
    expect(graph.calls.some((c) => c.url.pathname.includes("9000000001"))).toBe(false);
    expect(realFetchUsed).not.toHaveBeenCalled();

    const rows = await rowsOf(conn.id);
    const shape = rows
      .map((r) => `${r.metric_key} ${r.dimension_key} ${r.period_date} ${Number(r.value_num)}`)
      .sort();
    const ig = canonicalDimensions({
      platform: "instagram",
      platform_post_id: "17900000000000001",
    });
    const fb = canonicalDimensions({ platform: "facebook", platform_post_id: `${FX_PAGE}_501` });
    expect(shape).toEqual(
      [
        `content.interactions.daily ${fb} ${TODAY} 34`,
        `content.interactions.daily ${ig} ${TODAY} 86`,
        `content.reach.daily ${ig} ${TODAY} 1200`,
        `content.views.daily ${fb} ${TODAY} 900`,
        `content.views.daily ${ig} ${TODAY} 2400`,
      ].sort(),
    );
    for (const r of rows) {
      expect(r.provider).toBe("meta_publish");
      expect(r.value_minor).toBeNull();
      expect(r.currency).toBeNull();
    }
    const [logged] = await db
      .select()
      .from(connectorSyncs)
      .where(and(eq(connectorSyncs.connection_id, conn.id), eq(connectorSyncs.kind, "readback")));
    expect(logged).toMatchObject({ ok: true, account_id: b.account_id, observations_upserted: 5 });
  });

  it("a re-read the same day replaces in place; a figure Meta leaves out writes no row", async () => {
    const b = await fxBusiness();
    const conn = await fxExecuteConnection(b.account_id);
    await fxPublishedItem(b, {
      platform: "instagram",
      post_id: "17900000000000002",
      published_at: daysAgo(1),
    });
    await syncPostInsights(conn.id, NOW, {
      readback: fakeGraph({ ig: { "17900000000000002": { views: 10, reach: 8 } } }).readback,
    });
    await syncPostInsights(conn.id, NOW, {
      readback: fakeGraph({ ig: { "17900000000000002": { views: 25, reach: 20 } } }).readback,
    });
    const rows = await rowsOf(conn.id);
    expect(rows.map((r) => `${r.metric_key}=${Number(r.value_num)}`).sort()).toEqual([
      "content.reach.daily=20",
      "content.views.daily=25",
    ]);
    // No interactions row: Meta gave none, and unavailable is not zero (rule 5).
    expect(rows.some((r) => r.metric_key === "content.interactions.daily")).toBe(false);
  });

  it("only posts within the horizon and still published are read", async () => {
    const b = await fxBusiness();
    const conn = await fxExecuteConnection(b.account_id);
    await fxPublishedItem(b, {
      platform: "instagram",
      post_id: "17900000000000003",
      published_at: daysAgo(POST_INSIGHTS.horizon_days - 1),
    });
    await fxPublishedItem(b, {
      platform: "instagram",
      post_id: "17900000000000004",
      published_at: daysAgo(POST_INSIGHTS.horizon_days + 1),
    });
    await fxPublishedItem(b, {
      platform: "instagram",
      post_id: "17900000000000005",
      published_at: daysAgo(2),
      status: "withdrawn",
    });
    const graph = fakeGraph({
      ig: {
        "17900000000000003": { views: 1 },
        "17900000000000004": { views: 1 },
        "17900000000000005": { views: 1 },
      },
    });
    const out = await syncPostInsights(conn.id, NOW, { readback: graph.readback });
    expect(out.posts).toBe(1);
    expect(graph.calls.map((c) => c.url.pathname)).toEqual([`${V}/17900000000000003/insights`]);
  });

  it("postObservations: a null figure is no observation, never a zero", () => {
    const obs = postObservations(
      { platform: "facebook", platform_post_id: "1_2" },
      { views: 5, reach: null, interactions: 0 },
      TODAY,
      NOW.toISOString(),
    );
    expect(obs.map((o) => `${o.metric_key}=${o.value_num}`)).toEqual([
      "content.views.daily=5",
      "content.interactions.daily=0",
    ]);
    expect(obs[0]?.dimensions).toEqual({ platform: "facebook", platform_post_id: "1_2" });
  });
});

describe("P3-23a — a measure connection never gains these reads", () => {
  it("a measure connection is skipped by name and nothing is sent; the runner never selects it", async () => {
    const b = await fxBusiness();
    const measure = await fxMeasureMetaAds(b.account_id);
    await fxPublishedItem(b, {
      platform: "instagram",
      post_id: "17900000000000006",
      published_at: daysAgo(2),
    });
    const graph = fakeGraph({ ig: { "17900000000000006": { views: 1 } } });
    const out = await syncPostInsights(measure.id, NOW, { readback: graph.readback });
    expect(out.skipped).toBe("not_execute");
    expect(graph.calls).toEqual([]);
    // The runner walks other businesses' publishing connections, never this measure row's posts.
    await runPostReadback(NOW, { readback: graph.readback });
    expect(graph.calls.some((c) => c.url.pathname.includes("17900000000000006"))).toBe(false);
    expect(await rowsOf(measure.id)).toEqual([]);
  });

  it("an execute connection that isn't publishing, or isn't connected, is skipped too", async () => {
    const b = await fxBusiness();
    const paused = await fxExecuteConnection(b.account_id, "paused");
    const graph = fakeGraph();
    expect((await syncPostInsights(paused.id, NOW, { readback: graph.readback })).skipped).toBe(
      "not_connected",
    );
    const [ads] = await db
      .insert(connections)
      .values({
        account_id: b.account_id,
        provider: "meta_ads",
        purpose: "execute",
        status: "connected",
        granted_scopes: ["ads_management"],
      })
      .returning();
    expect((await syncPostInsights(ads!.id, NOW, { readback: graph.readback })).skipped).toBe(
      "not_publishing",
    );
    expect(graph.calls).toEqual([]);
  });

  it("the measure registry can't hold the readback scopes: a read-only Meta credential carrying one is refused", () => {
    const readback = EXECUTION_SCOPE_REGISTRY.meta_publish.readback_scopes;
    for (const scope of readback) {
      expect(SCOPE_REGISTRY.meta_ads as readonly string[]).not.toContain(scope);
      expect(() => verifyGrantedScopes("meta_ads", ["ads_read", scope])).toThrow();
    }
    expect(() => verifyGrantedScopes("meta_ads", ["ads_read"])).not.toThrow();
  });
});

describe("P3-23a — sliced rows stay out of every business-wide sum", () => {
  it("anomaly detection, the watch and the scorecard's series skip them; a business-wide row is not skipped", async () => {
    const b = await fxBusiness();
    const conn = await fxExecuteConnection(b.account_id);
    // Forty days of wild per-post figures: summed, they would be an anomaly.
    const dims = { platform: "instagram", platform_post_id: "17900000000000007" };
    const rows = [];
    for (let i = 40; i >= 1; i--) {
      const day = new Date(NOW.getTime() - i * 86_400_000).toISOString().slice(0, 10);
      rows.push({
        connection_id: conn.id,
        provider: "meta_publish",
        metric_key: "content.views.daily",
        dimensions: dims,
        dimension_key: canonicalDimensions(dims),
        period_date: day,
        value_num: String(i === 1 ? 1_000_000 : 10 * i),
        observed_at: NOW.toISOString(),
      });
    }
    await db.insert(metricObservations).values(rows);

    expect(await detectAnomalies(conn.id, NOW)).toEqual([]);
    const watch = await loadWatchReading(b.profile_id, "2026-10-01");
    expect(watch.signals.some((s) => String(s.metric_key).startsWith("content."))).toBe(false);
    expect(watch.connections).toBe(0); // the execute row is never a measured source
    const sliced = await dailySeries(b.profile_id, "content.views.daily", "2026-09-01", TODAY);
    expect(sliced?.values.size).toBe(0);

    // The failing case: the same metric with no slicing dimension IS summed —
    // so it is the dimension filter, not the metric name, that keeps them out.
    await db.insert(metricObservations).values({
      connection_id: conn.id,
      provider: "meta_publish",
      metric_key: "content.views.daily",
      dimensions: {},
      dimension_key: "{}",
      period_date: "2026-10-10",
      value_num: "7",
      observed_at: NOW.toISOString(),
    });
    const control = await dailySeries(b.profile_id, "content.views.daily", "2026-09-01", TODAY);
    expect([...(control?.values.entries() ?? [])]).toEqual([["2026-10-10", 7]]);

    // And a revenue-kind proposal on this business is judged on revenue alone, unmeasured here.
    const p = await createProposal({
      profile_id: b.profile_id,
      module: "diagnosis",
      action: { kind: "price_increase", summary: "raise it" },
      scenario: fxScenario,
      reversibility: { level: "easy", if_you_change_your_mind: "undo" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const outcome = await readbackForProposal({ ...p, decided_at: "2026-10-01T09:00:00Z" }, NOW);
    expect(outcome.judged_on).toBe("revenue");
    expect(outcome.metric).toBe("revenue.daily");
    expect(outcome.verdict).toBe("unmeasured");
  });
});

describe("P3-23a — failures", () => {
  it("a token Meta refuses fails the run, leaves the connection alone and never echoes the token", async () => {
    const b = await fxBusiness();
    const conn = await fxExecuteConnection(b.account_id);
    await fxPublishedItem(b, {
      platform: "instagram",
      post_id: "17900000000000008",
      published_at: daysAgo(2),
    });
    const graph = fakeGraph({
      respond: () => metaError(190, `Invalid OAuth access token ${FX_TOKEN}`),
    });
    const out = await syncPostInsights(conn.id, NOW, { readback: graph.readback });
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
    expect(out.error).not.toContain(FX_TOKEN);
    // Retries are capped: an auth refusal is not retried at all.
    expect(graph.calls.length).toBe(1);
    const [row] = await db.select().from(connections).where(eq(connections.id, conn.id));
    expect(row?.status).toBe("connected");
    expect(await rowsOf(conn.id)).toEqual([]);
  });

  it("one post Meta won't answer for is that post's gap; the others still land", async () => {
    const b = await fxBusiness();
    const conn = await fxExecuteConnection(b.account_id);
    await fxPublishedItem(b, {
      platform: "instagram",
      post_id: "17900000000000009",
      published_at: daysAgo(2),
    });
    await fxPublishedItem(b, {
      platform: "instagram",
      post_id: "17900000000000010",
      published_at: daysAgo(2),
    });
    const graph = fakeGraph({ ig: { "17900000000000010": { views: 3 } } });
    const out = await syncPostInsights(conn.id, NOW, { readback: graph.readback });
    expect(out.ok).toBe(true);
    expect(out.unreadable.map((u) => u.platform_post_id)).toEqual(["17900000000000009"]);
    expect((await rowsOf(conn.id)).map((r) => r.metric_key)).toEqual(["content.views.daily"]);
  });

  it("the registered request list names the two insight reads as GETs", () => {
    expect(META_EXEC_REQUESTS.page_post_insights).toEqual({
      method: "GET",
      path: "/{post_id}/insights",
    });
    expect(META_EXEC_REQUESTS.ig_media_insights).toEqual({
      method: "GET",
      path: "/{ig_media_id}/insights",
    });
  });
});
