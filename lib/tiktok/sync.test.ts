// TikTok Ads — the daily read lands in the Phase 2 tables, and the sign-in
// connects only on exactly the registry's scopes, with the consent on record.
// Database-backed; TikTok is a fake (lib/tiktok/fake.ts) and the global fetch
// fails the test if touched.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  anomalies,
  businessProfiles,
  connectorSyncs,
  connections,
  decisionLog,
  fieldRecords,
  intakeEvents,
  metricObservations,
  users,
  watchActivity,
} from "../../db/schema";
import {
  EXECUTE_READ_PROVIDERS,
  executeReadSource,
  overrideExecuteReadSourceForTests,
} from "../connectors/execute-reads";
import { SCOPE_REGISTRY } from "../connectors/scopes";
import { runConnectorSync, syncConnection } from "../connectors/sync";
import { addDays, utcMidnight } from "../connectors/days";
import { EXECUTION_SCOPE_REGISTRY } from "../execution/scopes";
import { connectForExecution, expectedExecutionScopes } from "../execution/connections";
import { bootstrapIntake } from "../intake/service";
import { fakeTikTok } from "./fake";
import type { TikTokLoginConfig } from "./login";
import {
  TIKTOK_PHRASE,
  buildTikTokAuthorizeUrl,
  completeTikTokCallback,
  signTikTokState,
  startTikTokLogin,
  verifyTikTokState,
} from "./login";
import { phraseHash } from "../execution/meta-login";
import { createTikTokAdsReadSource } from "./read";

const ADV = "7000000000001";
const noSleep = async () => undefined;
const realFetchUsed = vi.fn(async () => {
  throw new Error("a real fetch was attempted in a TikTok test");
});
beforeAll(() => {
  vi.stubGlobal("fetch", realFetchUsed);
});

const created: { account_id: string; profile_id: string }[] = [];
afterAll(async () => {
  expect(realFetchUsed).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  await db.delete(watchActivity).where(inArray(watchActivity.profile_id, ids));
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.account_id, accountIds));
  if (conns.length > 0) {
    const cids = conns.map((c) => c.id);
    await db.delete(anomalies).where(inArray(anomalies.connection_id, cids));
    await db.delete(metricObservations).where(inArray(metricObservations.connection_id, cids));
    await db.delete(connectorSyncs).where(inArray(connectorSyncs.connection_id, cids));
  }
  await db.delete(connections).where(inArray(connections.account_id, accountIds));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

describe("TikTok Ads — the execute connections the sync runner reads (pinned)", () => {
  it("are Google Ads and TikTok Ads, execution providers and never measurement ones", () => {
    expect([...EXECUTE_READ_PROVIDERS].sort()).toEqual(["google_ads", "tiktok_ads"]);
    for (const p of EXECUTE_READ_PROVIDERS) {
      expect(Object.keys(EXECUTION_SCOPE_REGISTRY)).toContain(p);
      expect(Object.keys(SCOPE_REGISTRY)).not.toContain(p);
    }
    expect(executeReadSource("tiktok_ads")?.label).toBe("TikTok Ads");
    expect(executeReadSource("meta_ads")).toBeNull();
    expect(executeReadSource("tiktok_publish")).toBeNull();
  });
});

describe("TikTok Ads — the daily read through the one consent", () => {
  it("backfills into metric_observations on the execute connection, with its cursor and a run row", async () => {
    const s = await business();
    const conn = await connectForExecution({
      accountId: s.account_id,
      provider: "tiktok_ads",
      secret: JSON.stringify({
        v: 1,
        access_token: "tt-fake-long-term-token",
        advertiser_ids: [ADV],
        scope_ids: [100, 200, 201, 44],
      }),
      verify: async () => ({ granted_scopes: expectedExecutionScopes("tiktok_ads") }),
    });
    const now = new Date();
    const tt = fakeTikTok();
    const yesterday = addDays(utcMidnight(now), -1).toISOString().slice(0, 10);
    tt.rows.push({
      advertiser_id: ADV,
      campaign_id: "1700000000001",
      campaign_name: "Spring",
      day: yesterday,
      spend: "12.34",
      purchases: "2",
      value: "40.00",
    });

    const restore = overrideExecuteReadSourceForTests(
      "tiktok_ads",
      createTikTokAdsReadSource({ fetch: tt.fetch, sleep: noSleep }),
    );
    let out;
    try {
      out = await runConnectorSync(now, { accountIds: [s.account_id] });
    } finally {
      restore();
    }
    expect(out).toMatchObject({ connections: 1, ok: 1, failed: 0 });
    expect(tt.calls.every((c) => c.method === "GET")).toBe(true);

    const rows = await db
      .select()
      .from(metricObservations)
      .where(eq(metricObservations.connection_id, conn.id));
    const spend = rows.find(
      (r) => r.metric_key === "ad_spend.daily" && r.period_date === yesterday,
    );
    expect(spend).toMatchObject({ value_minor: 1234, currency: "EUR" });
    const campaign = rows.find((r) => r.metric_key === "ad_purchase_value.campaign.daily");
    expect(campaign).toMatchObject({ value_minor: 4000, currency: "EUR" });
    const [row] = await db.select().from(connections).where(eq(connections.id, conn.id));
    expect(row?.cursor).toBe(yesterday);
    expect(row?.last_error).toBeNull();
    const runs = await db
      .select()
      .from(connectorSyncs)
      .where(eq(connectorSyncs.connection_id, conn.id));
    expect(runs[0]).toMatchObject({ ok: true });
    // The measured monthly ad spend is derived from it, like Meta's.
    const facts = await db
      .select()
      .from(fieldRecords)
      .where(
        and(
          eq(fieldRecords.profile_id, s.profile_id),
          eq(fieldRecords.field_key, "marketing.monthly_ad_spend"),
        ),
      );
    expect(facts.length).toBeGreaterThan(0);

    // Only through the narrow door: a TikTok POSTING row is never pulled from.
    const posting = await connectForExecution({
      accountId: s.account_id,
      provider: "tiktok_publish",
      secret: "{}",
      verify: async () => ({ granted_scopes: expectedExecutionScopes("tiktok_publish") }),
    });
    expect((await syncConnection(posting.id)).skipped).toBe("not_measurement");
  });

  it("records a refusal on the connection and writes nothing", async () => {
    const s = await business();
    const conn = await connectForExecution({
      accountId: s.account_id,
      provider: "tiktok_ads",
      secret: JSON.stringify({
        v: 1,
        access_token: "revoked-token",
        advertiser_ids: [ADV],
        scope_ids: [100, 200, 201, 44],
      }),
      verify: async () => ({ granted_scopes: expectedExecutionScopes("tiktok_ads") }),
    });
    const tt = fakeTikTok();
    const restore = overrideExecuteReadSourceForTests(
      "tiktok_ads",
      createTikTokAdsReadSource({ fetch: tt.fetch, sleep: noSleep }),
    );
    let out;
    try {
      out = await syncConnection(conn.id);
    } finally {
      restore();
    }
    expect(out).toMatchObject({ ok: false });
    const [row] = await db.select().from(connections).where(eq(connections.id, conn.id));
    expect(row?.last_error).toMatch(/TikTok didn't accept/);
    expect(row?.failure_count).toBe(1);
    expect(
      await db
        .select()
        .from(metricObservations)
        .where(eq(metricObservations.connection_id, conn.id)),
    ).toEqual([]);
  });
});

const config: TikTokLoginConfig = {
  app: { app_id: "7300000000000000001", secret: "app-secret" },
  redirect_uri: "https://syb.test/api/connections/tiktok/callback",
  app_origin: "https://syb.test",
};

describe("TikTok Ads — the sign-in", () => {
  it("state: signed, ten minutes, the nonce's, this account's — and refused otherwise", () => {
    const now = new Date();
    const state = signTikTokState({
      v: 1,
      account_id: "a",
      profile_id: "p",
      nonce: "n",
      phrase_hash: phraseHash(TIKTOK_PHRASE),
      issued_at: now.getTime(),
    });
    expect(verifyTikTokState(state, { nonceCookie: "n", accountId: "a", now }).profile_id).toBe(
      "p",
    );
    expect(() => verifyTikTokState(state, { nonceCookie: "x", accountId: "a", now })).toThrow(
      /expired or was already used/,
    );
    expect(() => verifyTikTokState(state, { nonceCookie: "n", accountId: "b", now })).toThrow(
      /different SYB account/,
    );
    expect(() =>
      verifyTikTokState(state, {
        nonceCookie: "n",
        accountId: "a",
        now: new Date(now.getTime() + 11 * 60_000),
      }),
    ).toThrow();
    expect(() =>
      verifyTikTokState(`${state.slice(0, -2)}xx`, { nonceCookie: "n", accountId: "a", now }),
    ).toThrow();
  });

  it("the authorize URL carries the app, the state and the redirect — never the secret", () => {
    const url = new URL(
      buildTikTokAuthorizeUrl({
        appId: config.app.app_id,
        redirectUri: config.redirect_uri,
        state: "s",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://business-api.tiktok.com/portal/auth");
    expect(url.searchParams.get("app_id")).toBe(config.app.app_id);
    expect(url.toString()).not.toContain("app-secret");
  });

  it("refuses to start without the phrase, or without the app set up", async () => {
    const s = await business();
    await expect(
      startTikTokLogin({
        accountId: s.account_id,
        profileId: s.profile_id,
        confirmation: "ok",
        config,
      }),
    ).rejects.toMatchObject({ reason: "phrase" });
    await expect(
      startTikTokLogin({
        accountId: s.account_id,
        profileId: s.profile_id,
        confirmation: TIKTOK_PHRASE,
        config: null,
      }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });

  async function startAndReturn(scope: number[]) {
    const s = await business();
    const started = await startTikTokLogin({
      accountId: s.account_id,
      profileId: s.profile_id,
      confirmation: TIKTOK_PHRASE,
      config,
    });
    const state = new URL(started.authorize_url).searchParams.get("state");
    const tt = fakeTikTok({ exchange: { auth_code: "code-1", advertiser_ids: [ADV], scope } });
    const outcome = await completeTikTokCallback({
      accountId: s.account_id,
      userId: null,
      query: { auth_code: "code-1", state, error: null },
      nonceCookie: started.nonce,
      config,
      ctx: { fetch: tt.fetch, sleep: noSleep },
    });
    return { s, outcome, tt };
  }

  it("connects on exactly the registry's scopes, the consent on record, the secret never in the exchange URL", async () => {
    const { s, outcome, tt } = await startAndReturn([100, 200, 201, 44]);
    expect(outcome.kind).toBe("connected");
    const [row] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.account_id, s.account_id), eq(connections.provider, "tiktok_ads")));
    expect(row?.purpose).toBe("execute");
    expect([...(row?.granted_scopes ?? [])].sort()).toEqual(
      [...expectedExecutionScopes("tiktok_ads")].sort(),
    );
    expect(row?.encrypted_secret).not.toContain("tt-fake-long-term-token");
    const consent = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.ref_id, row!.id), eq(decisionLog.kind, "consent")));
    expect(consent).toHaveLength(1);
    const exchange = tt.calls.find((c) => c.url.pathname.endsWith("/oauth2/access_token/"))!;
    expect(exchange.method).toBe("POST");
    expect(exchange.url.toString()).not.toContain("app-secret");
  });

  it("refuses a grant with a first-level permission (it includes everything), and stores nothing", async () => {
    const { s, outcome } = await startAndReturn([100, 200, 201, 44, 2]);
    expect(outcome).toEqual({ kind: "failed", reason: "scope" });
    const rows = await db
      .select()
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    expect(rows).toEqual([]);
  });

  it("a cancel on TikTok's page is a plain sentence, nothing connected", async () => {
    const s = await business();
    const outcome = await completeTikTokCallback({
      accountId: s.account_id,
      userId: null,
      query: { auth_code: null, state: null, error: "access_denied" },
      nonceCookie: null,
      config,
    });
    expect(outcome).toEqual({ kind: "cancelled" });
  });
});
