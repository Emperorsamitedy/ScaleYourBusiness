// P3-23b — readbackForProposal chooses its series by kind. Thresholds
// pinned at their boundaries in both directions (the anomaly discipline);
// the honest non-verdicts proven; and the done-when: a seeded published
// item with insights rows receives a per-post verdict with the arithmetic
// shown, and a campaign pause is judged on its own ROAS series — not on
// the business's revenue, which says something else in the same fixture.

import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { metricObservations } from "../../db/schema";
import {
  fxAdChange,
  fxBusiness,
  fxCampaignDays,
  fxCleanup,
  fxExecuteConnection,
  fxMeasureMetaAds,
  fxPublishedItem,
  fxSnapshots,
} from "../content/readback-fixture";
import { AD_READBACK, judgeCampaign } from "./campaign-readback";
import type { CampaignWindow } from "./campaign-readback";
import {
  POST_READBACK,
  ageInDays,
  comparisonAge,
  judgePost,
  median,
  postOutcome,
  postOutcomes,
} from "./post-readback";
import { judgedOn, readbackForProposal } from "./readback";
import { buildTrustView } from "./scorecard";
import { shiftDay } from "./series";

afterAll(async () => {
  await fxCleanup();
});

const NOW = new Date("2026-10-19T06:00:00Z");
const BASELINE = [100, 100, 100];

const judge = (reach: number, interactions?: number, baseline = BASELINE) =>
  judgePost({
    platform_word: "Instagram",
    age_days: 7,
    comparisons: [
      { label: "reach", value: reach, baseline },
      ...(interactions !== undefined
        ? [{ label: "interactions", value: interactions, baseline }]
        : []),
    ],
  });

describe("P3-23b — the per-post thresholds, at the boundary, both directions", () => {
  it("+20% exactly is helped; +19.9% did nothing", () => {
    expect(judge(120).verdict).toBe("helped");
    expect(judge(120).delta_pct).toBe(20);
    expect(judge(119.9).verdict).toBe("did_nothing");
  });

  it("−20% exactly is backfired; −19.9% did nothing", () => {
    expect(judge(80).verdict).toBe("backfired");
    expect(judge(80).delta_pct).toBe(-20);
    expect(judge(80.1).verdict).toBe("did_nothing");
  });

  it("one figure up and the other down is did_nothing; either figure alone can carry it", () => {
    expect(judge(130, 70).verdict).toBe("did_nothing");
    expect(judge(100, 125).verdict).toBe("helped");
    expect(judge(100, 75).verdict).toBe("backfired");
  });

  it("fewer than 3 earlier posts at the same age is too_early, saying how many it has", () => {
    const early = judge(500, undefined, [100, 100]);
    expect(early.verdict).toBe("too_early");
    expect(early.arithmetic).toContain("2 earlier Instagram post(s) measured on day 7");
    expect(judge(500, undefined, [100, 100, 100]).verdict).toBe("helped");
  });

  it("a median of zero: any reach is up from none, no reach is did_nothing", () => {
    expect(judge(5, undefined, [0, 0, 0]).verdict).toBe("helped");
    expect(judge(5, undefined, [0, 0, 0]).delta_pct).toBeNull();
    expect(judge(0, undefined, [0, 0, 0]).verdict).toBe("did_nothing");
  });

  it("the arithmetic names both figures, the medians and the thresholds", () => {
    const out = judge(150, 40, [100, 120, 80]);
    expect(out.arithmetic).toContain("reach 150 against a median of 100 (+50%)");
    expect(out.arithmetic).toContain("interactions 40 against a median of 100 (-60%)");
    expect(out.arithmetic).toContain("helped at +20%");
  });

  it("median, age and the comparison age: day 0 never counts; the latest day within the week is used", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(ageInDays("2026-10-01", "2026-10-08")).toBe(7);
    const snaps = (ages: number[]) =>
      new Map(
        ages.map((a) => [shiftDay("2026-10-01", a), { views: 1, reach: 1, interactions: 1 }]),
      );
    expect(comparisonAge("2026-10-01", snaps([0, 1, 2]))).toEqual({ age: 2, measured_days: 2 });
    expect(comparisonAge("2026-10-01", snaps([1, 2, 3, 8, 9]))).toEqual({
      age: 3,
      measured_days: 5,
    });
    expect(comparisonAge("2026-10-01", snaps([9, 10, 11]))).toEqual({ age: 9, measured_days: 3 });
  });
});

const window = (days: number, spend: number, value: number): CampaignWindow => ({
  from: "x",
  to: "y",
  days,
  spend_minor: spend,
  value_minor: value,
  roas: spend > 0 ? value / spend : null,
});

const campaign = (before: CampaignWindow, after: CampaignWindow) =>
  judgeCampaign({ name: "Autumn push", currency: "EUR", changed_on: "2026-10-01", before, after });

describe("P3-23b — the campaign thresholds, at the boundary, both directions", () => {
  it("a pause that held: ROAS 0.95 before is +5% helped; 0.96 did nothing; 1.05 backfired; 1.04 did nothing", () => {
    expect(campaign(window(14, 10_000, 9_500), window(10, 0, 0)).verdict).toBe("helped");
    expect(campaign(window(14, 10_000, 9_600), window(10, 0, 0)).verdict).toBe("did_nothing");
    expect(campaign(window(14, 10_000, 10_500), window(10, 0, 0)).verdict).toBe("backfired");
    expect(campaign(window(14, 10_000, 10_400), window(10, 0, 0)).verdict).toBe("did_nothing");
  });

  it("a budget change compares ROAS after with before: +5% helped, +4.9% did nothing, −5% backfired, −4.9% did nothing", () => {
    const before = window(28, 10_000, 30_000); // ROAS 3.00
    expect(campaign(before, window(10, 10_000, 31_500)).verdict).toBe("helped");
    expect(campaign(before, window(10, 10_000, 31_470)).verdict).toBe("did_nothing");
    expect(campaign(before, window(10, 10_000, 28_500)).verdict).toBe("backfired");
    expect(campaign(before, window(10, 10_000, 28_530)).verdict).toBe("did_nothing");
  });

  it("too_early under 7 measured days after; unmeasured with no spend before", () => {
    const early = campaign(window(14, 10_000, 5_000), window(AD_READBACK.min_after_days - 1, 0, 0));
    expect(early.verdict).toBe("too_early");
    expect(early.arithmetic).toContain("needs 7");
    expect(campaign(window(0, 0, 0), window(10, 0, 0)).verdict).toBe("unmeasured");
  });

  it("the arithmetic carries money in the currency's own units and names Meta's attribution", () => {
    const out = campaign(window(14, 14_000, 8_680), window(10, 0, 0));
    expect(out.arithmetic).toContain("returned 0.62 on ad spend");
    expect(out.arithmetic).toContain("€140.00");
    expect(out.arithmetic).toContain("attribution is Meta's own");
    expect(out.delta_pct).toBe(38);
  });
});

describe("P3-23b — readbackForProposal chooses its series by kind", () => {
  it("judgedOn: a per-item publish proposal is a post, an ad change a campaign, the rest revenue", () => {
    expect(
      judgedOn({
        module: "content",
        action: { kind: "content_publishing", detail: { item_id: "i" } },
      }),
    ).toBe("post");
    // The calendar shares the kind but names no item: revenue, as before.
    expect(
      judgedOn({ module: "content", action: { kind: "content_publishing", detail: {} } }),
    ).toBe("revenue");
    expect(judgedOn({ module: "ads", action: { kind: "x", detail: { campaign_ref: "1" } } })).toBe(
      "campaign",
    );
    expect(judgedOn({ module: "diagnosis", action: { kind: "price_increase" } })).toBe("revenue");
  });

  it("DONE-WHEN: a seeded published item with insights rows gets a per-post verdict, arithmetic shown", async () => {
    const b = await fxBusiness();
    const conn = await fxExecuteConnection(b.account_id);
    // Four earlier Instagram posts, each with reach 100 and 10 interactions on day 7.
    for (let i = 0; i < 4; i++) {
      const day = shiftDay("2026-09-01", i * 3);
      const id = `1790000000000010${i}`;
      await fxPublishedItem(b, {
        platform: "instagram",
        post_id: id,
        published_at: `${day}T10:00:00Z`,
      });
      await fxSnapshots(conn.id, "instagram", id, day, [
        { age: 6, reach: 90, interactions: 9 },
        { age: 7, reach: 100 + i * 10, interactions: 10 },
      ]);
    }
    // The judged post: reach 150, interactions 14 on its day 7 — the median is 115 / 10.
    const { item, proposal } = await fxPublishedItem(b, {
      platform: "instagram",
      post_id: "17900000000000200",
      published_at: "2026-10-01T10:00:00Z",
    });
    await fxSnapshots(conn.id, "instagram", "17900000000000200", "2026-10-01", [
      { age: 1, reach: 40, interactions: 3 },
      { age: 5, reach: 120, interactions: 12 },
      { age: 7, reach: 150, interactions: 14 },
      { age: 9, reach: 400, interactions: 40 },
    ]);
    const outcome = await readbackForProposal(proposal, NOW);
    expect(outcome.judged_on).toBe("post");
    expect(outcome.metric).toBe("content.reach.daily");
    expect(outcome.verdict).toBe("helped");
    expect(outcome.delta_pct).toBe(30.4);
    expect(outcome.arithmetic).toContain("on day 7 after posting");
    expect(outcome.arithmetic).toContain("reach 150 against a median of 115 (+30.4%)");
    expect(outcome.arithmetic).toContain("interactions 14 against a median of 10 (+40%)");
    expect(outcome.arithmetic).toContain("previous 4 Instagram post(s)");

    // /content reads the same outcome, with the figures it was judged on.
    const view = (await postOutcomes(b.profile_id))[item.id];
    expect(view).toMatchObject({
      verdict: "helped",
      age_days: 7,
      audience_metric: "reach",
      figures: { reach: 150, interactions: 14 },
    });
    // And the scorecard counts it with the same verdicts as ever.
    const trust = await buildTrustView(b.profile_id, NOW);
    expect(trust.scorecard.outcomes.helped).toBeGreaterThanOrEqual(1);
  });

  it("under 3 measured days is too_early; a Facebook post is judged on views", async () => {
    const b = await fxBusiness();
    const conn = await fxExecuteConnection(b.account_id);
    const { item } = await fxPublishedItem(b, {
      platform: "facebook",
      post_id: "1000000001_900",
      published_at: "2026-10-15T10:00:00Z",
    });
    await fxSnapshots(conn.id, "facebook", "1000000001_900", "2026-10-15", [
      { age: 0, views: 5 },
      { age: 1, views: 50, interactions: 4 },
      { age: 2, views: 80, interactions: 6 },
    ]);
    const early = await postOutcome(item);
    expect(early.verdict).toBe("too_early");
    expect(early.audience_metric).toBe("views");
    expect(early.arithmetic).toContain("2 measured day(s)");

    await fxSnapshots(conn.id, "facebook", "1000000001_900", "2026-10-15", [
      { age: 3, views: 90, interactions: 7 },
    ]);
    const judged = await postOutcome(item);
    // Measured now, but no earlier posts to compare with: still too early, and it says why.
    expect(judged.verdict).toBe("too_early");
    expect(judged.measured_days).toBe(3);
    expect(judged.arithmetic).toContain("0 earlier Facebook post(s) measured on day 3");
  });

  it("a post never published is unmeasured, not too early", async () => {
    const out = await postOutcome({
      id: crypto.randomUUID(),
      profile_id: crypto.randomUUID(),
      status: "drafted",
      platform: null,
      platform_post_id: null,
      published_at: null,
    });
    expect(out.verdict).toBe("unmeasured");
  });

  it("DONE-WHEN: a campaign pause is judged on its own ROAS series, not on the business's revenue", async () => {
    const b = await fxBusiness();
    const ads = await fxMeasureMetaAds(b.account_id);
    const day = "2026-09-20";
    // 14 loss-making days before the pause: €100 spent, €60 attributed each day (ROAS 0.60).
    const before = Array.from({ length: 14 }, (_, i) => ({
      date: shiftDay(day, -14 + i),
      spend: 10_000,
      value: 6_000,
    }));
    // After: the account synced 10 days; the paused campaign reported nothing.
    const covered = Array.from({ length: 10 }, (_, i) => shiftDay(day, 1 + i));
    await fxCampaignDays(ads.id, "120200000000001", before, covered);
    // Business revenue fell 50% in the same fixture: a revenue judge would say backfired.
    await db.insert(metricObservations).values(
      Array.from({ length: 38 }, (_, i) => {
        const d = shiftDay(day, -28 + i);
        return {
          connection_id: ads.id,
          provider: "meta_ads",
          metric_key: "revenue.daily",
          dimensions: { currency: "EUR" },
          dimension_key: '{"currency":"EUR"}',
          period_date: d,
          value_minor: d < day ? 10_000 : 5_000,
          currency: "EUR",
          observed_at: NOW.toISOString(),
        };
      }),
    );
    const proposal = await fxAdChange(b, {
      campaign_ref: "120200000000001",
      change: "pause",
      day,
    });
    const outcome = await readbackForProposal(proposal, new Date("2026-10-01T06:00:00Z"));
    expect(outcome.judged_on).toBe("campaign");
    expect(outcome.verdict).toBe("helped");
    expect(outcome.delta_pct).toBe(40);
    expect(outcome.currency).toBe("EUR");
    expect(outcome.arithmetic).toContain('"Autumn push" returned 0.60 on ad spend');
    expect(outcome.arithmetic).toContain("it spent nothing on 10 measured day(s)");

    // Another campaign's change, nothing measured for it: unmeasured, never revenue's verdict.
    const other = await fxAdChange(b, { campaign_ref: "120200000000999", change: "pause", day });
    const none = await readbackForProposal(other, new Date("2026-10-01T06:00:00Z"));
    expect(none.verdict).toBe("unmeasured");
    expect(POST_READBACK.min_measured_days).toBe(3);
  });
});
