// P3-54 — the pure halves of "Run this ad": which items can be ads, who an ad
// is shown to (special ad categories with no bypass, interests left broad),
// what a new ad may spend, and the scenario's arithmetic from the owner's own
// measured numbers. The database-backed generator and the executor are
// proven end to end in lib/execution/providers/meta-adcreate.test.ts.

import { describe, expect, it } from "vitest";
import type { CampaignRaw, MarginRaw } from "../simulate/model";
import { adReadiness, adScenario } from "./ad-run";
import { NO_CEILING_FOR_NEW_SPEND, newSpendGuard } from "./guard";
import {
  AD_AGE,
  SPECIAL_MIN_RADIUS_KM,
  buildTargeting,
  specialCategories,
  targetingViolation,
} from "./targeting";

const shiftDay = (day: string, by: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};

const code = (raw: string) =>
  /^[a-z]{2}$/i.test(raw) ? raw.toUpperCase() : raw === "Hungary" ? "HU" : null;

describe("P3-54 — which items can be run as an ad", () => {
  const ok = { kind: "post", status: "drafted", media_path: "https://blob.test/r/a.jpg" };
  it("a drafted or queued post or video with public media", () => {
    expect(adReadiness(ok)).toEqual({
      ok: true,
      media: { kind: "image", url: "https://blob.test/r/a.jpg" },
    });
    expect(
      adReadiness({ ...ok, kind: "video", media_path: "https://blob.test/r/a.mp4" }),
    ).toMatchObject({
      ok: true,
      media: { kind: "video" },
    });
    expect(adReadiness({ ...ok, status: "queued" })).toMatchObject({ ok: true });
  });
  it("refuses, in words, everything else", () => {
    expect(adReadiness({ ...ok, media_path: null })).toMatchObject({ reason: /no image or video/ });
    expect(adReadiness({ ...ok, kind: "shot_list" })).toMatchObject({
      reason: /isn't something to advertise/,
    });
    expect(adReadiness({ ...ok, status: "published", media_path: null })).toMatchObject({
      reason: /media left storage/,
    });
    expect(adReadiness({ ...ok, status: "withdrawn" })).toMatchObject({
      reason: /it is withdrawn/,
    });
    expect(adReadiness({ ...ok, media_path: "http://blob.test/r/a.jpg" })).toMatchObject({
      ok: false,
    });
    expect(adReadiness({ ...ok, media_path: "https://blob.test/r/a.gif" })).toMatchObject({
      ok: false,
    });
  });
});

describe("P3-54 — special ad categories: set with restricted targeting, or refused — never bypassed", () => {
  it("a real-estate business is housing, whatever the post says", () => {
    expect(
      specialCategories({
        business_type: "real_estate",
        restrictions_text: null,
        item_text: "Open day",
      }),
    ).toMatchObject({ categories: ["HOUSING"], refused: null });
  });
  it("the owner's own words (11.3) or the item's own caption put an ad in a category", () => {
    expect(
      specialCategories({
        business_type: "cafe",
        restrictions_text: "We offer financing on catering packages.",
        item_text: "Lunch",
      }).categories,
    ).toEqual(["FINANCIAL_PRODUCTS_SERVICES"]);
    expect(
      specialCategories({
        business_type: "cafe",
        restrictions_text: null,
        item_text: "We're hiring baristas!",
      }).categories,
    ).toEqual(["EMPLOYMENT"]);
  });
  it("politics and gambling are refused outright, saying why", () => {
    const v = specialCategories({
      business_type: null,
      restrictions_text: null,
      item_text: "Join our poker night",
    });
    expect(v.categories).toEqual(["ONLINE_GAMBLING_AND_GAMING"]);
    expect(v.refused).toMatch(/gambling.*won't run it/);
  });
  it("an ordinary café post is no category at all", () => {
    expect(
      specialCategories({
        business_type: "cafe",
        restrictions_text: null,
        item_text: "Pumpkin soup is back",
      }),
    ).toEqual({ categories: [], why: [], refused: null });
  });
});

describe("P3-54 — the audience", () => {
  const base = {
    audience: null,
    profile_country: "HU",
    categories: [],
    instagram: true,
    video: false,
    countryCode: code,
  };

  it("the default: everyone in the owner's country, 18–65+, Facebook and Instagram feeds, Advantage+ audience off", () => {
    const r = buildTargeting(base);
    if ("refused" in r) throw new Error(r.refused);
    expect(r.targeting).toEqual({
      geo_locations: { countries: ["HU"] },
      age_min: 18,
      age_max: 65,
      publisher_platforms: ["facebook", "instagram"],
      facebook_positions: ["feed"],
      instagram_positions: ["stream"],
      targeting_automation: { advantage_audience: 0 },
    });
    expect(r.words.interests).toMatch(/left broad/);
    expect(targetingViolation([], r.targeting)).toBeNull();
  });

  it("a place name without coordinates is shown, not targeted; no country at all refuses", () => {
    const r = buildTargeting({ ...base, audience: { location: { label: "Budapest" } } });
    if ("refused" in r) throw new Error(r.refused);
    expect(r.targeting.geo_locations).toEqual({ countries: ["HU"] });
    expect(r.notes[0]).toMatch(/"Budapest" isn't a place I can put on Meta's map yet/);
    expect(buildTargeting({ ...base, profile_country: null })).toMatchObject({
      refused: /which country/,
    });
  });

  it("never under 18; a special category gets no age band and a radius of at least 25 km", () => {
    const young = buildTargeting({ ...base, audience: { age_min: 13, age_max: 30 } });
    if ("refused" in young) throw new Error(young.refused);
    expect(young.targeting.age_min).toBe(AD_AGE.min);
    const housing = buildTargeting({
      ...base,
      categories: ["HOUSING"],
      audience: {
        age_min: 30,
        age_max: 40,
        location: { latitude: 47.5, longitude: 19, radius_km: 3 },
      },
    });
    if ("refused" in housing) throw new Error(housing.refused);
    expect([housing.targeting.age_min, housing.targeting.age_max]).toEqual([18, 65]);
    expect(housing.targeting.geo_locations).toMatchObject({
      custom_locations: [{ radius: SPECIAL_MIN_RADIUS_KM }],
    });
    expect(targetingViolation(["HOUSING"], housing.targeting)).toBeNull();
  });

  it("the executor's check refuses a bypass: an age band or a narrow radius on a special-category ad, interests, Advantage+ on", () => {
    const r = buildTargeting(base);
    if ("refused" in r) throw new Error(r.refused);
    const t = r.targeting;
    expect(targetingViolation(["HOUSING"], { ...t, age_min: 30 })).toMatch(
      /can't have an age band/,
    );
    expect(
      targetingViolation(["EMPLOYMENT"], {
        ...t,
        geo_locations: {
          custom_locations: [{ latitude: 1, longitude: 1, radius: 5, distance_unit: "kilometer" }],
        },
      }),
    ).toMatch(/at least 25 km/);
    expect(targetingViolation([], { ...t, flexible_spec: [{ interests: [{ id: "1" }] }] })).toMatch(
      /interests are left broad/,
    );
    expect(
      targetingViolation([], { ...t, targeting_automation: { advantage_audience: 1 } }),
    ).toMatch(/Advantage\+ audience stays off/);
    expect(targetingViolation(["ISSUES_ELECTIONS_POLITICS"], t)).toMatch(/doesn't run/);
  });
});

describe("P3-54 — what a new ad may spend", () => {
  const ceiling = { amount_minor: 30_000, currency: "EUR" };
  it("Meta's floor, the owner's ceiling over the whole account — and no ceiling, no new spend", () => {
    const a = {
      currency: "EUR",
      account_daily_minor: 0,
      monthly_ceiling: ceiling,
      floor_minor: 100,
    };
    expect(newSpendGuard({ ...a, daily_minor: 500 })).toBeNull();
    expect(newSpendGuard({ ...a, daily_minor: 50 })).toMatch(/under Meta's minimum/);
    // (€5 already a day + €6) × 30 = €330 > €300.
    expect(newSpendGuard({ ...a, daily_minor: 600, account_daily_minor: 500 })).toMatch(
      /330.*over your stated ceiling/,
    );
    expect(newSpendGuard({ ...a, daily_minor: 500, monthly_ceiling: null })).toBe(
      NO_CEILING_FOR_NEW_SPEND,
    );
    expect(
      newSpendGuard({
        ...a,
        daily_minor: 500,
        monthly_ceiling: { amount_minor: 1, currency: "HUF" },
      }),
    ).toMatch(/won't convert/);
    expect(newSpendGuard({ ...a, daily_minor: 500, floor_minor: null })).toMatch(
      /don't know Meta's minimum/,
    );
  });
});

describe("P3-54 — the scenario, from the owner's own measured numbers", () => {
  const AS_OF = "2026-10-26";
  const days = (n: number, spend: number, value: number) =>
    Array.from({ length: n }, (_, i) => ({
      date: shiftDay(AS_OF, -1 - i),
      spend_minor: spend,
      value_minor: value,
    }));
  const margin: MarginRaw = {
    computed_pct: null,
    computed_formula: null,
    stated_pct: 50,
    stated_basis: "STATED",
  };

  it("with measured campaigns: spend × the measured weekly return × margin, as ranges", () => {
    const campaigns: CampaignRaw[] = [
      { ref: "1", name: "A", currency: "EUR", days: days(28, 1_000, 3_000) },
    ];
    const s = adScenario({
      daily_minor: 500,
      run_days: 7,
      currency: "EUR",
      campaigns,
      margin,
      as_of: AS_OF,
    });
    expect(s.spend_minor).toBe(3_500);
    expect(s.roas).toEqual({ low: 3, high: 3 });
    expect(s.revenue).toEqual({ low: 10_500, high: 10_500 });
    expect(s.profit).toEqual({ low: 1_750, high: 1_750 });
    expect(s.scenario.upside_case.profit_delta_monthly).toEqual({
      amount_minor: 1_750,
      currency: "EUR",
    });
    expect(s.scenario.breakeven_condition).toMatch(/2\.00/);
  });

  it("without them: the spend at most, the return not guessed, the worst case all of it", () => {
    const s = adScenario({
      daily_minor: 500,
      run_days: 7,
      currency: "EUR",
      campaigns: [],
      margin,
      as_of: AS_OF,
    });
    expect(s.revenue).toBeNull();
    expect(s.scenario.base_case.statement).toMatch(/can't be sized yet/);
    expect(s.scenario.downside_case.profit_delta_monthly).toEqual({
      amount_minor: -3_500,
      currency: "EUR",
    });
    expect(s.scenario.upside_case.profit_delta_monthly).toBeNull();
    // Reach is never forecast.
    expect(s.scenario.assumptions.some((a) => /Reach isn't forecast/.test(a.statement))).toBe(true);
  });
});
