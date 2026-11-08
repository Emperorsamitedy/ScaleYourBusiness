// P2-20 + P3-22 (Google half) — Google Ads end to end, against the
// database and the recorded-shape fake (./fake.ts). No network: global
// fetch is stubbed to fail, so anything that slipped past the fake fails.
//
//   · the consent: a typed phrase, Google's grant holding exactly adwords, a
//     refresh token, one non-manager ad account (or the owner's pick), the
//     access encrypted at rest, a decision-log consent row; revoke wipes it
//   · the read: the daily sync pulls from the execute connection through the
//     execute-read door only, and nothing else of the execute side
//   · ad spend: Meta's and Google's add up into one monthly fact, never in
//     two currencies (rule 1)
//   · the proposals: a Google campaign losing money gets a pause, routed to
//     the Google Ads executor, refused by the real-write gate while it is
//     off and executed through the engine when it is on

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  decisionLog,
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
import { adsPlan, dbGoogleAdsBackend } from "../ads/executing";
import { proposeAdChanges } from "../ads/proposals";
import { deriveFactsFromObservations } from "../connectors/derive";
import { overrideExecuteReadSourceForTests } from "../connectors/execute-reads";
import { decryptSecret } from "../connectors/secrets";
import { syncConnection } from "../connectors/sync";
import type { GoogleAdsEnv } from "../env";
import { connectForExecution, expectedExecutionScopes } from "../execution/connections";
import { runDueExecutions } from "../execution/due";
import { phraseHash } from "../execution/meta-login";
import { createGoogleAdsExecution } from "../execution/providers/google-ads";
import { bootstrapIntake } from "../intake/service";
import { readCurrentField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal } from "../proposals/service";
import { shiftDay } from "../trust/series";
import { GOOGLE_ADS_SCOPE } from "./client";
import { GOOGLE_ADS_PHRASE, readGoogleAdsSecret, revokeGoogleAds } from "./consent";
import { fakeGoogleAds } from "./fake";
import {
  completeGoogleAdsCallback,
  finishGoogleAdsLogin,
  googleAdsLoginConfig,
  signGoogleAdsState,
  startGoogleAdsLogin,
} from "./login";
import { createGoogleAdsReadSource } from "./read";

const ENV: GoogleAdsEnv = {
  client_id: "test-client.apps.googleusercontent.com",
  client_secret: "test-secret",
  access_level: "test",
  developer_token: null,
  login_customer_id: null,
  redirect_uri: null,
  app_url: "http://localhost:3000",
};
const CONFIG = googleAdsLoginConfig(ENV, "http://localhost:3000");
const created: { account_id: string; profile_id: string }[] = [];
const gateBefore = process.env.SESSION_D_REAL_WRITES;

beforeAll(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (gateBefore === undefined) delete process.env.SESSION_D_REAL_WRITES;
  else process.env.SESSION_D_REAL_WRITES = gateBefore;
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  // The decision log is append-only (rule 7): its rows outlive the test.
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
    const { connectorSyncs } = await import("../../db/schema");
    await db.delete(connectorSyncs).where(
      inArray(
        connectorSyncs.connection_id,
        conns.map((c) => c.id),
      ),
    );
  }
  const { anomalies } = await import("../../db/schema");
  await db.delete(anomalies).where(inArray(anomalies.profile_id, ids));
  await db.delete(connections).where(inArray(connections.account_id, accountIds));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

async function business(opts: { care?: boolean } = {}) {
  const s = await bootstrapIntake();
  created.push(s);
  if (opts.care) {
    await db.insert(modeDecisions).values({
      profile_id: s.profile_id,
      mode: "instant",
      watch_weeks: null,
      inputs: { reasons: ["test fixture"] },
      reasoning: "test fixture",
      confidence: "0.900",
      review_at: new Date(Date.now() + 42 * 86_400_000).toISOString(),
    });
  }
  return s;
}

/** Steps 1 and 2 of the sign-in against the fake, as the routes run them. */
async function signIn(
  s: { account_id: string; profile_id: string },
  fake: ReturnType<typeof fakeGoogleAds>,
) {
  const start = await startGoogleAdsLogin({
    accountId: s.account_id,
    profileId: s.profile_id,
    confirmation: GOOGLE_ADS_PHRASE,
    config: CONFIG,
  });
  const state = new URL(start.authorize_url).searchParams.get("state");
  return completeGoogleAdsCallback({
    accountId: s.account_id,
    userId: null,
    query: { code: "4/fake-code", state, error: null },
    nonceCookie: start.nonce,
    config: CONFIG,
    fetchImpl: fake.fetch,
  });
}

/** A Google Ads execute connection, straight through the door, with a known secret. */
async function googleConnection(s: { account_id: string; profile_id: string }, currency = "EUR") {
  const conn = await connectForExecution({
    accountId: s.account_id,
    provider: "google_ads",
    secret: JSON.stringify({
      v: 1,
      refresh_token: "1//r",
      profile_id: s.profile_id,
      customer_id: "1234567890",
      name: "Lumen Ads",
      currency,
      time_zone: null,
    }),
    verify: async () => ({ granted_scopes: expectedExecutionScopes("google_ads") }),
  });
  return conn;
}

const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

describe("P2-20 — the consent", () => {
  it("asks Google for exactly adwords, offline, with PKCE, and only after the typed phrase", async () => {
    const s = await business();
    await expect(
      startGoogleAdsLogin({
        accountId: s.account_id,
        profileId: s.profile_id,
        confirmation: "yes",
        config: CONFIG,
      }),
    ).rejects.toMatchObject({ reason: "phrase" });
    await expect(
      startGoogleAdsLogin({
        accountId: s.account_id,
        profileId: s.profile_id,
        confirmation: GOOGLE_ADS_PHRASE,
        config: null,
      }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    const { authorize_url } = await startGoogleAdsLogin({
      accountId: s.account_id,
      profileId: s.profile_id,
      confirmation: GOOGLE_ADS_PHRASE,
      config: CONFIG,
    });
    const q = new URL(authorize_url).searchParams;
    expect(q.get("scope")).toBe(GOOGLE_ADS_SCOPE);
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("redirect_uri")).toBe("http://localhost:3000/api/connections/google-ads/callback");
  });

  it("connects the one ad account: encrypted at rest, a consent row, the token never stored plain", async () => {
    const s = await business();
    const fake = fakeGoogleAds();
    const outcome = await signIn(s, fake);
    expect(outcome.kind).toBe("connected");
    const [row] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.account_id, s.account_id), eq(connections.provider, "google_ads")));
    expect(row?.purpose).toBe("execute");
    expect(row?.granted_scopes).toEqual([GOOGLE_ADS_SCOPE]);
    expect(row?.encrypted_secret).not.toContain("1//fake-ads-refresh");
    const secret = readGoogleAdsSecret(decryptSecret(row!.encrypted_secret!));
    expect(secret).toMatchObject({ customer_id: "1234567890", currency: "EUR", name: "Lumen Ads" });
    const consent = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, s.profile_id), eq(decisionLog.ref_id, row!.id)));
    expect(consent.map((c) => c.kind)).toEqual(["consent"]);
    expect(fake.calls.some((c) => c.url.includes(":mutate"))).toBe(false);

    // Revoke: the access is deleted here at once, the row kept.
    const revoked = await revokeGoogleAds(s.account_id, row!.id);
    expect(revoked.status).toBe("disconnected");
    const [after] = await db.select().from(connections).where(eq(connections.id, row!.id));
    expect(after?.encrypted_secret).toBeNull();
  });

  it("refuses a grant with more than adwords, no refresh token, or only manager accounts — nothing stored", async () => {
    const s = await business();
    const more = await signIn(s, fakeGoogleAds({ scope: `${GOOGLE_ADS_SCOPE} openid email` }));
    expect(more).toEqual({ kind: "failed", reason: "scope" });
    const noRefresh = await signIn(s, fakeGoogleAds({ refreshToken: null }));
    expect(noRefresh).toEqual({ kind: "failed", reason: "no_refresh" });
    const managers = await signIn(
      s,
      fakeGoogleAds({
        customers: [{ id: "5555555555", name: "MCC", currency: "EUR", manager: true }],
      }),
    );
    expect(managers).toEqual({ kind: "failed", reason: "managers_only" });
    const none = await signIn(s, fakeGoogleAds({ customers: [] }));
    expect(none).toEqual({ kind: "failed", reason: "no_accounts" });
    const rows = await db
      .select()
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    expect(rows).toEqual([]);
  });

  it("refuses a forged state and one from another SYB account", async () => {
    const s = await business();
    const other = await business();
    const forged = signGoogleAdsState({
      v: 1,
      account_id: other.account_id,
      profile_id: other.profile_id,
      nonce: "n",
      phrase_hash: phraseHash(GOOGLE_ADS_PHRASE),
      issued_at: Date.now(),
    });
    const outcome = await completeGoogleAdsCallback({
      accountId: s.account_id,
      userId: null,
      query: { code: "c", state: forged, error: null },
      nonceCookie: "n",
      config: CONFIG,
      fetchImpl: fakeGoogleAds().fetch,
    });
    expect(outcome).toEqual({ kind: "failed", reason: "foreign" });
    const tampered = await completeGoogleAdsCallback({
      accountId: s.account_id,
      userId: null,
      query: { code: "c", state: `${forged}x`, error: null },
      nonceCookie: "n",
      config: CONFIG,
      fetchImpl: fakeGoogleAds().fetch,
    });
    expect(tampered).toEqual({ kind: "failed", reason: "start_again" });
  });

  it("with several ad accounts, waits for the owner's pick — and a manager can't be picked", async () => {
    const s = await business();
    const fake = fakeGoogleAds({
      customers: [
        { id: "1111111111", name: "Shop", currency: "EUR" },
        { id: "2222222222", name: "Salon", currency: "HUF" },
        { id: "5555555555", name: "MCC", currency: "EUR", manager: true },
      ],
    });
    const outcome = await signIn(s, fake);
    expect(outcome.kind).toBe("pick");
    const pending = outcome.kind === "pick" ? outcome.pending : "";
    await expect(
      finishGoogleAdsLogin({
        accountId: s.account_id,
        profileId: s.profile_id,
        userId: null,
        customerId: "5555555555",
        pendingCookie: pending,
        config: CONFIG,
        fetchImpl: fake.fetch,
      }),
    ).rejects.toMatchObject({ reason: "start_again" });
    const connection = await finishGoogleAdsLogin({
      accountId: s.account_id,
      profileId: s.profile_id,
      userId: null,
      customerId: "222-222-2222",
      pendingCookie: pending,
      config: CONFIG,
      fetchImpl: fake.fetch,
    });
    expect(connection.provider).toBe("google_ads");
  });
});

describe("P2-20 — the daily read through the execute-read door", () => {
  it("syncs a Google Ads execute connection into observations, and still never pulls another execute row", async () => {
    const s = await business();
    const conn = await googleConnection(s);
    const yesterday = shiftDay(new Date().toISOString().slice(0, 10), -1);
    const fake = fakeGoogleAds({
      campaigns: [
        { id: "111", name: "Spring sale", status: "ENABLED", budget_id: "9", amount_micros: 1 },
      ],
      days: [
        {
          date: yesterday,
          campaign_id: "111",
          cost_micros: 12_500_000,
          clicks: 9,
          conversions: 2,
          conversions_value: 40,
        },
      ],
    });
    const restore = overrideExecuteReadSourceForTests(
      "google_ads",
      createGoogleAdsReadSource({ fetch: fake.fetch, env: () => ENV }),
    );
    try {
      const outcome = await syncConnection(conn.id);
      expect(outcome.ok).toBe(true);
      expect(outcome.skipped).toBeNull();
      expect(outcome.kind).toBe("backfill");
    } finally {
      restore();
    }
    const [spend] = await db
      .select()
      .from(metricObservations)
      .where(
        and(
          eq(metricObservations.connection_id, conn.id),
          eq(metricObservations.metric_key, "ad_spend.daily"),
          eq(metricObservations.period_date, yesterday),
        ),
      );
    expect(spend).toMatchObject({ provider: "google_ads", value_minor: 1250, currency: "EUR" });
    const measured = await readCurrentField<{ amount_minor: number; currency: string }>(
      s.profile_id,
      "marketing.monthly_ad_spend",
    );
    expect(measured?.value).toEqual({ amount_minor: 1250, currency: "EUR" });
    expect(fake.calls.some((c) => c.url.includes(":mutate"))).toBe(false);

    // Meta publishing is an execute row with no read source: never pulled.
    const meta = await connectForExecution({
      accountId: s.account_id,
      provider: "meta_publish",
      secret: JSON.stringify({ access_token: "t", page_id: "123456" }),
      verify: async () => ({ granted_scopes: expectedExecutionScopes("meta_publish") }),
    });
    expect((await syncConnection(meta.id)).skipped).toBe("not_measurement");
  });
});

describe("P2-20 — ad spend across platforms", () => {
  async function spendRows(connId: string, provider: string, currency: string, minor: number) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = [];
    for (let i = 1; i <= 3; i++) {
      rows.push({
        connection_id: connId,
        provider,
        metric_key: "ad_spend.daily",
        dimensions: { currency },
        dimension_key: JSON.stringify({ currency }),
        period_date: shiftDay(today, -i),
        value_minor: minor,
        currency,
        observed_at: new Date().toISOString(),
      });
    }
    await db.insert(metricObservations).values(rows);
  }

  it("Meta's and Google's spend add up into one monthly fact, naming both series", async () => {
    const s = await business();
    const [meta] = await db
      .insert(connections)
      .values({ account_id: s.account_id, provider: "meta_ads" })
      .returning({ id: connections.id });
    const google = await googleConnection(s);
    await spendRows(meta!.id, "meta_ads", "EUR", 1000);
    await spendRows(google.id, "google_ads", "EUR", 500);
    for (const id of [meta!.id, google.id]) {
      const out = await deriveFactsFromObservations(id);
      expect(out.find((o) => o.field_key === "marketing.monthly_ad_spend")?.outcome).not.toBe(
        "refused",
      );
    }
    const fact = await readCurrentField<{ amount_minor: number }>(
      s.profile_id,
      "marketing.monthly_ad_spend",
    );
    expect(fact?.value).toEqual({ amount_minor: 4500, currency: "EUR" });
    expect(JSON.stringify(fact?.source)).toContain("connector:meta_ads:ad_spend.daily");
    expect(JSON.stringify(fact?.source)).toContain("connector:google_ads:ad_spend.daily");
  });

  it("two platforms in two currencies are a refusal, never a blend (rule 1)", async () => {
    const s = await business();
    const [meta] = await db
      .insert(connections)
      .values({ account_id: s.account_id, provider: "meta_ads" })
      .returning({ id: connections.id });
    const google = await googleConnection(s, "HUF");
    await spendRows(meta!.id, "meta_ads", "EUR", 1000);
    await spendRows(google.id, "google_ads", "HUF", 500_000);
    const out = await deriveFactsFromObservations(google.id);
    expect(out.find((o) => o.field_key === "marketing.monthly_ad_spend")).toMatchObject({
      outcome: "refused",
      reason: expect.stringMatching(/currencies never blend/),
    });
  });
});

describe("P3-22, Google half — proposals through the engine", () => {
  it("a losing Google campaign gets a pause, routed to google_ads; the gate holds it, then it runs", async () => {
    const s = await business({ care: true });
    const [u] = await db
      .insert(users)
      .values({
        account_id: s.account_id,
        email: `p2-20-${crypto.randomUUID()}@test.local`,
        display_name: "P2-20 owner",
        role: "owner",
      })
      .returning({ id: users.id });
    const conn = await googleConnection(s);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const rows = [];
    for (let i = 1; i <= 14; i++) {
      for (const [metric, v] of [
        ["ad_spend.campaign.daily", 2_000],
        ["ad_purchase_value.campaign.daily", 1_000],
      ] as const) {
        rows.push({
          connection_id: conn.id,
          provider: "google_ads",
          metric_key: metric,
          dimensions: { campaign_ref: "111", campaign_name: "Spring sale", currency: "EUR" },
          dimension_key: JSON.stringify({ campaign_ref: "111", currency: "EUR" }),
          period_date: shiftDay(today, -i),
          value_minor: v,
          currency: "EUR",
          observed_at: now.toISOString(),
        });
      }
    }
    await db.insert(metricObservations).values(rows);

    const run = await proposeAdChanges(s.profile_id, { now, limitLlm: noLimits });
    expect(run.created).toHaveLength(1);
    const p = run.created[0]!;
    expect(p.originating_finding).toBe(`ads:google:111:pause:${today.slice(0, 7)}`);
    const detail = (p.action as { detail: Record<string, unknown> }).detail;
    expect(detail).toMatchObject({ platform: "google", campaign_ref: "111", change: "pause" });
    expect(String(detail["arithmetic"])).toMatch(/conversion value Google attributes/);
    expect(adsPlan(p)).toEqual({
      plan: { provider: "google_ads", op: "pause_campaign", params: { campaign_id: "111" } },
    });

    await approveProposal({ proposalId: p.id, userId: u!.id, profileId: s.profile_id });
    const fake = fakeGoogleAds({
      campaigns: [
        {
          id: "111",
          name: "Spring sale",
          status: "ENABLED",
          budget_id: "9",
          amount_micros: 20_000_000,
        },
      ],
    });
    const exec = createGoogleAdsExecution({
      fetch: fake.fetch,
      backend: async () => ({
        ...dbGoogleAdsBackend(),
        credential: async () => ({
          access_token: "ya29.x",
          customer_id: "1234567890",
          headers: { developer_token: null, login_customer_id: null },
        }),
      }),
    });
    const due = () =>
      runDueExecutions({
        profileId: s.profile_id,
        providers: { google_ads: exec },
        sleep: async () => {},
      });

    delete process.env.SESSION_D_REAL_WRITES;
    const off = await due();
    expect(off.refused).toBe(1);
    expect(off.outcomes[0]?.detail).toMatch(/^real_writes_off: Google Ads is switched off/);
    expect(fake.calls).toHaveLength(0);

    process.env.SESSION_D_REAL_WRITES = "on";
    const on = await due();
    expect(on.executed).toBe(1);
    expect(fake.campaigns.get("111")?.status).toBe("PAUSED");
    const [execution] = await db.select().from(executions).where(eq(executions.proposal_id, p.id));
    expect(execution?.provider).toBe("google_ads");
    expect(execution?.undo_payload).toMatchObject({ campaign_id: "111", status: "ENABLED" });
  });

  it("the same campaign id on Meta and on Google are two series, never folded together", async () => {
    const s = await business({ care: true });
    const [meta] = await db
      .insert(connections)
      .values({ account_id: s.account_id, provider: "meta_ads" })
      .returning({ id: connections.id });
    const google = await googleConnection(s);
    const today = new Date().toISOString().slice(0, 10);
    const rows = [];
    for (const [connId, provider] of [
      [meta!.id, "meta_ads"],
      [google.id, "google_ads"],
    ] as const) {
      for (let i = 1; i <= 14; i++) {
        for (const metric of ["ad_spend.campaign.daily", "ad_purchase_value.campaign.daily"]) {
          rows.push({
            connection_id: connId,
            provider,
            metric_key: metric,
            dimensions: { campaign_ref: "120000001", campaign_name: "Same id", currency: "EUR" },
            dimension_key: JSON.stringify({ campaign_ref: "120000001", currency: "EUR" }),
            period_date: shiftDay(today, -i),
            value_minor: metric === "ad_spend.campaign.daily" ? 2_000 : 500,
            currency: "EUR",
            observed_at: new Date().toISOString(),
          });
        }
      }
    }
    await db.insert(metricObservations).values(rows);
    const run = await proposeAdChanges(s.profile_id, { limitLlm: noLimits });
    expect(run.created.map((p) => p.originating_finding).sort()).toEqual([
      `ads:120000001:pause:${today.slice(0, 7)}`,
      `ads:google:120000001:pause:${today.slice(0, 7)}`,
    ]);
  });
});
