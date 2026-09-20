// P2-19 — the Meta Ads connector, against a recorded-shape Graph API.
//
// What these tests hold:
//
//   · READ-ONLY, PROVEN. Meta reports a token's granted permissions, so
//     ads_management or anything beyond ads_read is refused for real;
//     every request is a GET to one of three paths on graph.facebook.com,
//     the token travels in a header and never in a URL, and the source scan
//     fails the build if any of that changes.
//   · THE ARITHMETIC. Spend in minor units in the account currency, zero
//     days filled, overlapping purchase action types never summed.
//   · THE SYNC. A year in windows, cursor paging, the last 8 days re-read.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Observation, Provider, PullPage } from "./provider";
import { ProviderError } from "./provider";
import {
  META_HISTORY_DAYS,
  META_MAX_ATTEMPTS,
  META_REREAD_DAYS,
  aggregateInsights,
  createMetaAdsProvider,
  parseMetaCredential,
  purchasesFrom,
} from "./providers/meta-ads";
import type { FakeMeta, FakeMetaOptions } from "./providers/meta-fake";
import {
  FAKE_META_ACCOUNT,
  FAKE_META_SECRET,
  FAKE_META_TOKEN,
  fakeMeta,
  metaError,
} from "./providers/meta-fake";
import { ScopeViolationError, verifyGrantedScopes } from "./scopes";

const NOW = new Date("2026-09-14T12:00:00Z");

function meta(options: FakeMetaOptions = {}): { fake: FakeMeta; provider: Provider } {
  const fake = fakeMeta(options);
  return { fake, provider: createMetaAdsProvider({ fetch: fake.fetch, sleep: async () => {} }) };
}

async function runToDone(provider: Provider, cursor: string | null = null): Promise<PullPage[]> {
  const pages: PullPage[] = [];
  let at = cursor;
  for (let i = 0; i < 100; i += 1) {
    const page = await provider.pull(FAKE_META_SECRET, at, NOW);
    pages.push(page);
    at = page.cursor;
    if (page.done) break;
  }
  return pages;
}

const spendOf = (obs: readonly Observation[]): number =>
  obs
    .filter((o) => o.metric_key === "ad_spend.daily")
    .reduce((s, o) => s + (o.value_minor ?? 0), 0);
const purchasesOf = (obs: readonly Observation[]): number =>
  obs
    .filter((o) => o.metric_key === "ad_purchases.daily")
    .reduce((s, o) => s + (o.value_num ?? 0), 0);
const spendDays = (obs: readonly Observation[]): string[] =>
  obs.filter((o) => o.metric_key === "ad_spend.daily").map((o) => o.period_date);

describe("P2-19 — the credential", () => {
  it("accepts an ad account ID with or without act_", () => {
    expect(parseMetaCredential(FAKE_META_SECRET).account_id).toBe(FAKE_META_ACCOUNT);
    expect(
      parseMetaCredential(
        JSON.stringify({ ad_account_id: FAKE_META_ACCOUNT, access_token: "EAAx" }),
      ).account_id,
    ).toBe(FAKE_META_ACCOUNT);
  });

  it("refuses a malformed account ID or a token with whitespace in it", () => {
    expect(() =>
      parseMetaCredential(JSON.stringify({ ad_account_id: "my shop", access_token: "EAAx" })),
    ).toThrow(/ad account ID/);
    expect(() =>
      parseMetaCredential(
        JSON.stringify({ ad_account_id: FAKE_META_ACCOUNT, access_token: "EAA x" }),
      ),
    ).toThrow(/one line/);
  });
});

describe("P2-19 — connecting reads the real permissions", () => {
  it("reports ads_read, ignoring public_profile, and proves the ad account is visible", async () => {
    const { fake, provider } = meta();
    expect((await provider.connect(FAKE_META_SECRET)).granted_scopes).toEqual(["ads_read"]);
    expect(fake.calls.map((c) => c.url.pathname)).toEqual([
      "/v25.0/me/permissions",
      `/v25.0/act_${FAKE_META_ACCOUNT}`,
    ]);
  });

  it("RULE 9, FOR REAL: a token that can manage ads is refused by the registry check", async () => {
    const { provider } = meta({
      permissions: [
        { permission: "ads_read", status: "granted" },
        { permission: "ads_management", status: "granted" },
      ],
    });
    const { granted_scopes } = await provider.connect(FAKE_META_SECRET);
    expect(() => verifyGrantedScopes("meta_ads", granted_scopes)).toThrow(ScopeViolationError);
  });

  it("a declined permission doesn't count as granted", async () => {
    const { provider } = meta({ permissions: [{ permission: "ads_read", status: "declined" }] });
    await expect(provider.connect(FAKE_META_SECRET)).rejects.toThrow(
      /needs the ads_read permission/,
    );
  });

  it("an invalid token is reported as not accepted, without echoing it", async () => {
    const { provider } = meta();
    const secret = JSON.stringify({
      ad_account_id: FAKE_META_ACCOUNT,
      access_token: "EAAwrongToken",
    });
    try {
      await provider.connect(secret);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).toMatch(/not accepted/);
      expect((error as Error).message).not.toContain("EAAwrongToken");
    }
  });

  it("an ad account the token can't see says how to fix it", async () => {
    const { provider } = meta();
    const secret = JSON.stringify({ ad_account_id: "99999999", access_token: FAKE_META_TOKEN });
    await expect(provider.connect(secret)).rejects.toThrow(/can't read ad account act_99999999/);
  });
});

describe("rule 9 — the connector can only read", () => {
  it("every request is a GET to a registered path, with the token never in the URL", async () => {
    const { fake, provider } = meta({ days: [{ date: "2026-03-01", spend: "20.00" }] });
    await provider.connect(FAKE_META_SECRET);
    await runToDone(provider);

    const allowed = [
      "/v25.0/me/permissions",
      `/v25.0/act_${FAKE_META_ACCOUNT}`,
      `/v25.0/act_${FAKE_META_ACCOUNT}/insights`,
    ];
    expect(fake.calls.length).toBeGreaterThan(10);
    for (const call of fake.calls) {
      expect(call.init.method).toBe("GET");
      expect(call.url.origin).toBe("https://graph.facebook.com");
      expect(allowed).toContain(call.url.pathname);
      expect(call.url.toString()).not.toContain(FAKE_META_TOKEN);
      expect(call.url.searchParams.has("access_token")).toBe(false);
    }
  });

  it("THE BUILD GATE: the source names no other verb and sets no other method", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./providers/meta-ads.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(source).not.toMatch(/access_token=/);
    const methods = [...source.matchAll(/method:\s*([^,;\n}]+)/g)].map((m) => m[1]?.trim());
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) expect(['"GET"', "init.method"]).toContain(method);
  });
});

describe("P2-19 — the arithmetic", () => {
  it("never sums overlapping purchase types", () => {
    expect(
      purchasesFrom([
        { action_type: "purchase", value: "3" },
        { action_type: "omni_purchase", value: "4" },
        { action_type: "offsite_conversion.fb_pixel_purchase", value: "3" },
      ]),
    ).toBe(4);
    expect(
      purchasesFrom([{ action_type: "offsite_conversion.fb_pixel_purchase", value: "2" }]),
    ).toBe(2);
    expect(purchasesFrom([{ action_type: "link_click", value: "80" }])).toBe(0);
  });

  it("spend becomes minor units in the account currency, with zero days filled", () => {
    const obs = aggregateInsights(
      [
        {
          date: "2026-09-01",
          spend: "45.67",
          currency: "EUR",
          actions: [{ action_type: "purchase", value: "2" }],
        },
        { date: "2026-09-03", spend: "10.00", currency: "EUR", actions: [] },
      ],
      "EUR",
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-03T00:00:00Z"),
      NOW.toISOString(),
    );
    expect(spendDays(obs)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(spendOf(obs)).toBe(5_567);
    expect(purchasesOf(obs)).toBe(2);
    expect(
      obs.find((o) => o.metric_key === "ad_spend.daily" && o.period_date === "2026-09-02"),
    ).toMatchObject({
      value_minor: 0,
      dimensions: { currency: "EUR" },
    });
  });

  it("a row in another currency is an error, never a blend (rule 1)", () => {
    expect(() =>
      aggregateInsights(
        [{ date: "2026-09-01", spend: "5.00", currency: "USD", actions: [] }],
        "EUR",
        new Date("2026-09-01T00:00:00Z"),
        new Date("2026-09-01T00:00:00Z"),
        NOW.toISOString(),
      ),
    ).toThrow(/USD, not the account's EUR/);
  });
});

describe("P2-19 — the sync", () => {
  it("reads a year in windows, following Meta's paging", async () => {
    const days = Array.from({ length: 150 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 3, 1) + i * 86_400_000).toISOString().slice(0, 10),
      spend: "10.00",
      actions: [{ action_type: "omni_purchase", value: "1" }],
    }));
    const { fake, provider } = meta({ days });
    const pages = await runToDone(provider);
    const all = pages.flatMap((p) => p.observations);

    expect(spendDays(all)).toHaveLength(META_HISTORY_DAYS);
    expect(spendOf(all)).toBe(150 * 1_000);
    expect(purchasesOf(all)).toBe(150);
    expect(pages.at(-1)).toMatchObject({ cursor: "2026-09-13", done: true });
    expect(fake.calls.some((c) => c.url.searchParams.has("after"))).toBe(false);
  });

  it("follows the after cursor when a window has more rows than one page", async () => {
    const days = Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 7, 15) + i * 86_400_000).toISOString().slice(0, 10),
      spend: "1.00",
    }));
    const { fake } = meta({ days });
    const provider = createMetaAdsProvider({
      fetch: async (url, init) => {
        const u = new URL(url);
        if (u.pathname.endsWith("/insights")) u.searchParams.set("limit", "7");
        return fake.fetch(u.toString(), init);
      },
      sleep: async () => {},
    });
    const page = await provider.pull(FAKE_META_SECRET, "2026-08-14", NOW);
    expect(spendOf(page.observations)).toBe(3_000);
    expect(fake.calls.filter((c) => c.url.searchParams.has("after")).length).toBeGreaterThanOrEqual(
      4,
    );
  });

  it("a daily run re-reads the last 8 days, while Meta is still attributing purchases", async () => {
    const { provider } = meta();
    const page = await provider.pull(FAKE_META_SECRET, "2026-09-12", NOW);
    expect(spendDays(page.observations)).toHaveLength(META_REREAD_DAYS);
    expect(page).toMatchObject({ cursor: "2026-09-13", done: true });
  });

  it("rate limiting retries to the cap, then fails", async () => {
    const { fake, provider } = meta({
      respond: (call) =>
        call.url.pathname.endsWith("/insights")
          ? metaError(17, "User request limit reached")
          : null,
    });
    await expect(provider.pull(FAKE_META_SECRET, null, NOW)).rejects.toThrow(/still rate limited/);
    expect(fake.calls.filter((c) => c.url.pathname.endsWith("/insights"))).toHaveLength(
      META_MAX_ATTEMPTS,
    );
  });
});
