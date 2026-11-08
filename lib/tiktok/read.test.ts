// TikTok Ads — the daily read: GET-only by a source scan (the I-45a fence),
// and the arithmetic that turns TikTok's report into the Phase 2 shapes in
// integer minor units (rule 1). Fake HTTP only.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addDays, utcMidnight } from "../connectors/days";
import type { TikTokContext } from "./api";
import { fakeTikTok } from "./fake";
import type { TikTokCampaignRow } from "./read";
import {
  TIKTOK_WINDOW_DAYS,
  TikTokReadError,
  aggregateTikTok,
  parseReportRow,
  pullTikTok,
  tiktokMinor,
} from "./read";

const noSleep = async () => undefined;
const SRC = readFileSync(join(process.cwd(), "lib", "tiktok", "read.ts"), "utf8");
const code = SRC.replace(/^\s*\/\/.*$/gm, "");

describe("TikTok Ads — the read can only read (THE BUILD GATE)", () => {
  it("calls TikTok only through tiktokRead", () => {
    expect(code).not.toMatch(/\btiktokCall\b/);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).toMatch(/tiktokRead\(/);
  });

  it("names no write request and no write verb", () => {
    expect(code).not.toMatch(
      /campaign_update|campaign_status_update|access_token"|"POST"|DELETE|ENABLE|DISABLE/,
    );
  });

  it("names only the two reads it needs", () => {
    const used = [...code.matchAll(/tiktokRead\(\s*ctx,\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(used)).toEqual(new Set(["advertiser_info", "report"]));
  });
});

const row = (r: Partial<TikTokCampaignRow>): TikTokCampaignRow => ({
  advertiser_id: "7000000000001",
  campaign_id: "1700000000001",
  campaign_name: "Spring",
  date: "2026-11-01",
  currency: "EUR",
  spend: "10.00",
  purchases: "2",
  purchase_value: "35.50",
  ...r,
});

describe("TikTok Ads — the arithmetic", () => {
  const start = new Date("2026-11-01T00:00:00Z");
  const end = new Date("2026-11-03T00:00:00Z");
  const cur = new Map([["7000000000001", "EUR"]]);

  it("money in minor units of the account currency; every day of business-wide spend, zero days included", () => {
    const obs = aggregateTikTok(
      [
        row({}),
        row({ campaign_id: "1700000000002", spend: "5.25", purchases: "1", purchase_value: "0" }),
      ],
      cur,
      start,
      end,
      "2026-11-04T00:00:00Z",
    );
    const daily = obs.filter((o) => o.metric_key === "ad_spend.daily");
    expect(daily.map((o) => [o.period_date, o.value_minor, o.dimensions.currency])).toEqual([
      ["2026-11-01", 1525, "EUR"],
      ["2026-11-02", 0, "EUR"],
      ["2026-11-03", 0, "EUR"],
    ]);
    const purchases = obs.filter((o) => o.metric_key === "ad_purchases.daily");
    expect(purchases[0]).toMatchObject({ period_date: "2026-11-01", value_num: 3 });
    const camp = obs.filter((o) => o.metric_key === "ad_purchase_value.campaign.daily");
    expect(camp.map((o) => [o.dimensions.campaign_ref, o.value_minor])).toEqual([
      ["1700000000001", 3550],
      ["1700000000002", 0],
    ]);
    // A campaign only has rows for the days it reported.
    expect(obs.filter((o) => o.metric_key === "ad_spend.campaign.daily")).toHaveLength(2);
  });

  it("whole units for a zero-decimal currency, and HUF in fillér", () => {
    expect(tiktokMinor("1200", "JPY")).toBe(1200);
    expect(tiktokMinor("1500", "HUF")).toBe(150000);
    // TikTok's sub-minor digits are rounded, never refused.
    expect(tiktokMinor("12.345", "EUR")).toBe(1235);
    expect(tiktokMinor("", "EUR")).toBe(0);
  });

  it("refuses an amount that isn't one", () => {
    expect(() => tiktokMinor("12,50", "EUR")).toThrow(TikTokReadError);
  });

  it("refuses a row in another currency than its ad account's (rule 1: never a blend)", () => {
    expect(() =>
      aggregateTikTok([row({ currency: "USD" })], cur, start, end, "2026-11-04T00:00:00Z"),
    ).toThrow(/USD, not its ad account's EUR/);
  });

  it("keeps two ad accounts' currencies apart", () => {
    const obs = aggregateTikTok(
      [row({}), row({ advertiser_id: "7000000000002", currency: "HUF", spend: "2000" })],
      new Map([
        ["7000000000001", "EUR"],
        ["7000000000002", "HUF"],
      ]),
      start,
      start,
      "2026-11-04T00:00:00Z",
    );
    const daily = obs.filter((o) => o.metric_key === "ad_spend.daily");
    expect(daily.map((o) => [o.dimensions.currency, o.value_minor])).toEqual([
      ["EUR", 1000],
      ["HUF", 200000],
    ]);
  });

  it("parses a report row as TikTok shapes it, and refuses one without its campaign or day", () => {
    const parsed = parseReportRow(
      {
        dimensions: { campaign_id: "1700000000001", stat_time_day: "2026-11-01 00:00:00" },
        metrics: {
          campaign_name: "Spring",
          spend: "1.00",
          complete_payment: "1",
          total_complete_payment_rate: "3.00",
          currency: "eur",
        },
      },
      "7000000000001",
      "EUR",
    );
    expect(parsed).toMatchObject({ date: "2026-11-01", currency: "EUR", purchase_value: "3.00" });
    expect(() =>
      parseReportRow(
        { dimensions: { stat_time_day: "2026-11-01 00:00:00" }, metrics: {} },
        "1",
        "EUR",
      ),
    ).toThrow(TikTokReadError);
    expect(() =>
      parseReportRow({ dimensions: { campaign_id: "1700000000001" }, metrics: {} }, "1", "EUR"),
    ).toThrow(TikTokReadError);
  });
});

describe("TikTok Ads — one page of the read, against the fake", () => {
  const now = new Date("2026-11-08T09:00:00Z");
  const secret = (tok: string) =>
    JSON.stringify({
      v: 1,
      access_token: tok,
      advertiser_ids: ["7000000000001"],
      scope_ids: [100, 200, 201, 44],
    });

  it("backfills a 30-day window with GETs only, every page, and moves the cursor", async () => {
    const tt = fakeTikTok({ pageSize: 2 });
    const yesterday = addDays(utcMidnight(now), -1);
    const first = addDays(yesterday, -364);
    for (let i = 0; i < 5; i++) {
      tt.rows.push({
        advertiser_id: "7000000000001",
        campaign_id: `170000000000${i}`,
        campaign_name: `C${i}`,
        day: addDays(first, i).toISOString().slice(0, 10),
        spend: "10.00",
        purchases: "1",
        value: "20.00",
      });
    }
    const ctx: TikTokContext = { fetch: tt.fetch, sleep: noSleep };
    const page = await pullTikTok(ctx, secret(tt.token), null, now);
    expect(tt.calls.every((c) => c.method === "GET")).toBe(true);
    const reports = tt.calls.filter((c) => c.url.pathname.endsWith("/report/integrated/get/"));
    expect(reports).toHaveLength(3); // 5 rows, 2 a page
    const q = reports[0]!.url.searchParams;
    expect(q.get("data_level")).toBe("AUCTION_CAMPAIGN");
    expect(q.get("dimensions")).toBe('["campaign_id","stat_time_day"]');
    expect(JSON.parse(q.get("metrics") ?? "[]")).toEqual(
      expect.arrayContaining(["spend", "complete_payment", "total_complete_payment_rate"]),
    );
    expect(page.cursor).toBe(
      addDays(first, TIKTOK_WINDOW_DAYS - 1)
        .toISOString()
        .slice(0, 10),
    );
    expect(page.done).toBe(false);
    expect(
      page.observations.filter((o) => o.metric_key === "ad_spend.campaign.daily"),
    ).toHaveLength(5);
    expect(page.observations.filter((o) => o.metric_key === "ad_spend.daily")).toHaveLength(
      TIKTOK_WINDOW_DAYS,
    );
  });

  it("once caught up, re-reads the last eight days and is done", async () => {
    const tt = fakeTikTok();
    const yesterday = addDays(utcMidnight(now), -1).toISOString().slice(0, 10);
    const page = await pullTikTok(
      { fetch: tt.fetch, sleep: noSleep },
      secret(tt.token),
      yesterday,
      now,
    );
    expect(page.done).toBe(true);
    expect(page.observations.filter((o) => o.metric_key === "ad_spend.daily")).toHaveLength(8);
  });

  it("fails the read when TikTok refuses the token (no rows written from a refusal)", async () => {
    const tt = fakeTikTok();
    await expect(
      pullTikTok({ fetch: tt.fetch, sleep: noSleep }, secret("wrong-token"), null, now),
    ).rejects.toMatchObject({
      kind: "auth",
    });
  });
});
