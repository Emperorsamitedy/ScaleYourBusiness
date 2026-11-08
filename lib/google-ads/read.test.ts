// P2-20 — the Google Ads daily read: GAQL rows into observations, money in
// integer minor units of the account currency (rule 1), zero days kept,
// and the pull against the recorded-shape fake. No network, no database.

import "dotenv/config";
import { describe, expect, it, vi } from "vitest";
import type { GoogleAdsEnv } from "../env";
import { fakeGoogleAds } from "./fake";
import {
  aggregateGoogleAds,
  campaignDayQuery,
  createGoogleAdsReadSource,
  readCampaignDay,
} from "./read";

const ENV: GoogleAdsEnv = {
  client_id: "c",
  client_secret: "s",
  access_level: "test",
  developer_token: null,
  login_customer_id: null,
  redirect_uri: null,
  app_url: null,
};

const SECRET = JSON.stringify({
  v: 1,
  refresh_token: "1//r",
  profile_id: "p",
  customer_id: "1234567890",
  name: "Lumen Ads",
  currency: "EUR",
  time_zone: "Europe/Budapest",
});

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("P2-20 — campaign days into observations", () => {
  it("the query is one SELECT over the window, dates validated", () => {
    expect(campaignDayQuery("2026-10-01", "2026-10-30")).toBe(
      "SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros, metrics.clicks, " +
        "metrics.conversions, metrics.conversions_value FROM campaign " +
        "WHERE segments.date BETWEEN '2026-10-01' AND '2026-10-30'",
    );
    expect(() => campaignDayQuery("2026-10-01' OR '1'='1", "2026-10-30")).toThrow();
  });

  it("reads Google's lowerCamelCase rows, int64 as strings, absent metrics as zero", () => {
    expect(
      readCampaignDay({
        segments: { date: "2026-11-01" },
        campaign: { id: "111", name: " Spring sale " },
        metrics: { costMicros: "12340000", clicks: "17", conversions: 2.5, conversionsValue: 61.2 },
      }),
    ).toEqual({
      date: "2026-11-01",
      campaign_id: "111",
      campaign_name: "Spring sale",
      cost_micros: 12_340_000,
      clicks: 17,
      conversions: 2.5,
      conversions_value: 61.2,
    });
    expect(
      readCampaignDay({ segments: { date: "2026-11-01" }, campaign: { id: "111" }, metrics: {} }),
    ).toMatchObject({ cost_micros: 0, clicks: 0, conversions: 0, campaign_name: "111" });
    expect(readCampaignDay({ segments: { date: "nope" }, campaign: { id: "111" } })).toBeNull();
    expect(readCampaignDay({ segments: { date: "2026-11-01" }, campaign: {} })).toBeNull();
  });

  it("sums the business's day in micros first, keeps zero days, and writes campaign series", () => {
    const rows = [
      { date: "2026-11-01", campaign_id: "111", campaign_name: "A", cost_micros: 1_005_000, clicks: 3, conversions: 1, conversions_value: 10 },
      { date: "2026-11-01", campaign_id: "222", campaign_name: "B", cost_micros: 1_005_000, clicks: 2, conversions: 0.5, conversions_value: 0 },
      { date: "2026-11-05", campaign_id: "111", campaign_name: "A", cost_micros: 9_000_000, clicks: 1, conversions: 0, conversions_value: 0 },
    ];
    const obs = aggregateGoogleAds(rows, "eur", d("2026-11-01"), d("2026-11-03"), "t");
    const spend = obs.filter((o) => o.metric_key === "ad_spend.daily");
    expect(spend.map((o) => [o.period_date, o.value_minor, o.dimensions.currency])).toEqual([
      ["2026-11-01", 201, "EUR"], // 2 010 000 micros = 2.01, not 1.01 + 1.01 rounded twice
      ["2026-11-02", 0, "EUR"],
      ["2026-11-03", 0, "EUR"],
    ]);
    expect(obs.find((o) => o.metric_key === "ad_clicks.daily" && o.period_date === "2026-11-01")?.value_num).toBe(5);
    expect(obs.find((o) => o.metric_key === "ad_conversions.daily" && o.period_date === "2026-11-01")?.value_num).toBe(1.5);
    const campaign = obs.filter((o) => o.metric_key === "ad_spend.campaign.daily");
    expect(campaign.map((o) => [o.dimensions.campaign_ref, o.value_minor])).toEqual([
      ["111", 101],
      ["222", 101],
    ]);
    const value = obs.find(
      (o) => o.metric_key === "ad_purchase_value.campaign.daily" && o.dimensions.campaign_ref === "111",
    );
    expect(value).toMatchObject({ value_minor: 1000, dimensions: { currency: "EUR", campaign_name: "A" } });
    // Outside the window: nothing.
    expect(obs.some((o) => o.period_date === "2026-11-05")).toBe(false);
    // Every money value is an integer (rule 1); no ad_purchases.daily from Google.
    for (const o of obs) if (o.value_minor !== undefined) expect(Number.isSafeInteger(o.value_minor)).toBe(true);
    expect(obs.some((o) => o.metric_key === "ad_purchases.daily")).toBe(false);
  });
});

describe("P2-20 — the pull, against the recorded-shape fake", () => {
  it("refreshes, checks the currency, reads the window, and advances the cursor", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fake = fakeGoogleAds({
      campaigns: [{ id: "111", name: "Spring sale", status: "ENABLED", budget_id: "9", amount_micros: 10_000_000 }],
      days: [
        { date: "2026-11-06", campaign_id: "111", cost_micros: 5_000_000, clicks: 4, conversions: 1, conversions_value: 20 },
      ],
    });
    const source = createGoogleAdsReadSource({ fetch: fake.fetch, env: () => ENV });
    const page = await source.pull(SECRET, "2026-11-05", new Date("2026-11-08T06:00:00Z"));
    expect(page.cursor).toBe("2026-11-07");
    expect(page.done).toBe(true);
    expect(
      page.observations.find((o) => o.metric_key === "ad_spend.daily" && o.period_date === "2026-11-06")
        ?.value_minor,
    ).toBe(500);
    // Token, customer, campaign days — and never a mutate.
    expect(fake.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/token",
      "/v26/customers/1234567890/googleAds:search",
      "/v26/customers/1234567890/googleAds:search",
    ]);
  });

  it("refuses a currency that changed since consent, and refuses without SYB's setup", async () => {
    const fake = fakeGoogleAds({ customers: [{ id: "1234567890", name: "X", currency: "USD" }] });
    const source = createGoogleAdsReadSource({ fetch: fake.fetch, env: () => ENV });
    await expect(source.pull(SECRET, null, new Date("2026-11-08T06:00:00Z"))).rejects.toThrow(
      /USD, not the EUR/,
    );
    const off = createGoogleAdsReadSource({ fetch: fake.fetch, env: () => null });
    await expect(off.pull(SECRET, null, new Date())).rejects.toThrow(/not set up/);
  });
});
