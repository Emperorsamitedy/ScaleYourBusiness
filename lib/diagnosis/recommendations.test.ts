// Session F, proven offline. The dividing line under test: the model
// frames, the code proves. There is no schema field where a model could
// place a profit figure — so these tests feed levers in and check that
// every number out is arithmetic over snapshot facts, shown in full.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  offers,
  profileSnapshots,
  snapshotRecords,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { loadBank } from "../bank/loader";
import { money } from "../core/money";
import type { OfferEconomics } from "../economics/unit-economics";
import { writeField } from "../profile/field-store";
import { DiagnosisError } from "./findings";
import type { RecommendationsLlm } from "./recommendations";
import {
  buildRecommendations,
  closeGapScenario,
  priceChangeScenario,
  runRecommendations,
  ScenarioError,
  sensitivityCallouts,
} from "./recommendations";

/** The landing page's syrup: price 4 990, cost 4 090, 310 units/month. */
const SYRUP: OfferEconomics = {
  offer_id: "of-1",
  name: "Szörp 0.5L",
  kind: "physical",
  price: money(499_000, "HUF"),
  cost_to_deliver: money(409_000, "HUF"),
  margin_pct: null,
  contribution: null,
  volume: 310,
};

describe("P1-30/33 — the discount states its break-even, arithmetic shown", () => {
  it("a 10% discount on a thin-margin product demands a 124% lift, and says why", () => {
    const s = priceChangeScenario({
      offer: SYRUP,
      change_pct: -10,
      volume_response: { base_pct: 15, downside_pct: 0, upside_pct: 40 },
    });

    // margin 900 → 401; 900/401 − 1 = 124.4%
    expect(s.breakeven_condition).toContain("sales must rise at least 124.4%");
    // the arithmetic is visible, not asserted
    expect(s.breakeven_condition).toContain("900 HUF");
    expect(s.breakeven_condition).toContain("401 HUF");
    expect(s.breakeven_condition).toContain("2.24×");

    // outcomes carry their formulas with real numbers
    expect(s.base_case.formula).toContain("401 HUF × 357 units − 900 HUF × 310 units");
    expect(s.base_case.profit_delta_monthly!.amount_minor).toBe(401 * 357 * 100 - 900 * 310 * 100);
    expect(s.downside_case.profit_delta_monthly!.amount_minor).toBeLessThan(0);
  });

  it("a price rise states the tolerable volume loss — the landing ladder's 53%", () => {
    // +12% on 4990 → 5589, margin 1499; 1 − 900/1499 = 40.0%
    const s = priceChangeScenario({
      offer: SYRUP,
      change_pct: 12,
      volume_response: { base_pct: -5, downside_pct: -25, upside_pct: 0 },
    });
    expect(s.breakeven_condition).toContain("sales can fall up to 40%");
    expect(s.breakeven_condition).toContain("1,498.80 HUF");
  });

  it("every shown formula adds up on a calculator, to the cent", () => {
    // The demo mug: €34, €9.80 to deliver, 397 a month, +8%. Rounded to
    // whole euros the margins read 27 and 24, and 27 × 385 − 24 × 397 is
    // 867, not the 757 the scenario computed.
    const mug: OfferEconomics = {
      ...SYRUP,
      name: "Speckled Everyday Mug",
      price: money(3_400, "EUR"),
      cost_to_deliver: money(980, "EUR"),
      volume: 397,
    };
    const s = priceChangeScenario({
      offer: mug,
      change_pct: 8,
      volume_response: { base_pct: -3, downside_pct: -9, upside_pct: 0 },
    });
    const amount = (t: string) => Number(t.replace(/,/g, ""));
    const FORMULA =
      /^([\d,.]+) EUR × (\d+) units − ([\d,.]+) EUR × (\d+) units = ([+−])([\d,.]+) EUR$/;
    for (const c of [s.base_case, s.downside_case, s.upside_case]) {
      const m = FORMULA.exec(c.formula ?? "");
      expect(m, c.formula ?? "").not.toBeNull();
      const [, a, u, b, v, sign, r] = m!;
      const shown = Math.round((amount(a!) * Number(u) - amount(b!) * Number(v)) * 100);
      expect(shown).toBe((sign === "−" ? -1 : 1) * Math.round(amount(r!) * 100));
      expect(shown).toBe(c.profit_delta_monthly!.amount_minor);
    }
    expect(s.base_case.formula).toBe("26.92 EUR × 385 units − 24.20 EUR × 397 units = +756.80 EUR");
    expect(s.assumptions[1]!.statement).toBe("each unit costs 9.80 EUR to deliver");
  });

  it("a discount below unit cost is named unwinnable, not silently produced", () => {
    const s = priceChangeScenario({
      offer: SYRUP,
      change_pct: -20, // 3992 < 4090 cost
      volume_response: { base_pct: 30, downside_pct: 0, upside_pct: 60 },
    });
    expect(s.breakeven_condition).toContain("no volume can break even");
  });

  it("refuses missing cost, missing volume, blended currencies, silly levers", () => {
    expect(() =>
      priceChangeScenario({
        offer: { ...SYRUP, cost_to_deliver: null },
        change_pct: -10,
        volume_response: { base_pct: 0, downside_pct: 0, upside_pct: 0 },
      }),
    ).toThrow(ScenarioError);
    expect(() =>
      priceChangeScenario({
        offer: { ...SYRUP, volume: null },
        change_pct: -10,
        volume_response: { base_pct: 0, downside_pct: 0, upside_pct: 0 },
      }),
    ).toThrow(/no volume/);
    expect(() =>
      priceChangeScenario({
        offer: { ...SYRUP, cost_to_deliver: money(1_000, "EUR") },
        change_pct: -10,
        volume_response: { base_pct: 0, downside_pct: 0, upside_pct: 0 },
      }),
    ).toThrow(/currencies/);
    expect(() =>
      priceChangeScenario({
        offer: SYRUP,
        change_pct: 0,
        volume_response: { base_pct: 0, downside_pct: 0, upside_pct: 0 },
      }),
    ).toThrow(/implausible/);
  });
});

describe("P1-28/31 — assumptions carry computed sensitivity, called out inline", () => {
  it("volume response is always a high-sensitivity assumption with no source field", () => {
    const s = priceChangeScenario({
      offer: SYRUP,
      change_pct: -10,
      volume_response: { base_pct: 15, downside_pct: 0, upside_pct: 40 },
    });
    const response = s.assumptions.find((a) => a.source_field === null)!;
    expect(response.sensitivity).toBe("high");

    // thin post-change margin (401/4491 ≈ 9%) → cost flips to high too
    const cost = s.assumptions.find((a) => a.source_field?.endsWith("cost_to_deliver"))!;
    expect(cost.sensitivity).toBe("high");

    const callouts = sensitivityCallouts(s.assumptions);
    expect(callouts.length).toBeGreaterThanOrEqual(2);
    expect(callouts[0]).toMatch(/^this depends heavily on: /);
  });

  it("a fat post-change margin keeps cost at medium — sensitivity is computed, not vibes", () => {
    const s = priceChangeScenario({
      offer: { ...SYRUP, cost_to_deliver: money(100_000, "HUF") }, // margin 3 990
      change_pct: -10,
      volume_response: { base_pct: 10, downside_pct: 0, upside_pct: 20 },
    });
    const cost = s.assumptions.find((a) => a.source_field?.endsWith("cost_to_deliver"))!;
    expect(cost.sensitivity).toBe("medium");
  });

  it("every assumption from the profile names its source field", () => {
    const s = priceChangeScenario({
      offer: SYRUP,
      change_pct: -10,
      volume_response: { base_pct: 0, downside_pct: 0, upside_pct: 0 },
    });
    const sourced = s.assumptions.filter((a) => a.source_field !== null);
    expect(sourced.map((a) => a.source_field)).toEqual([
      "offers.of-1.price",
      "offers.of-1.cost_to_deliver",
      "offers.of-1.volume_period",
    ]);
  });
});

describe("P1-29/32 — validation: real findings, real offers, stated undo", () => {
  const OFFERS = new Map([["of-1", SYRUP]]);
  const KEYS = new Set(["costs.fixed_monthly", "offers.of-1.price"]);
  const RAW = {
    addresses: [0],
    title: "Raise the 0.5L price",
    rationale: "Margin is thin.",
    effort: "low",
    reversibility_level: "easy",
    if_you_change_your_mind: "Change the price back; nothing else moves.",
    scenario: {
      kind: "price_change",
      offer_id: "of-1",
      change_pct: 12,
      volume_response_base_pct: -5,
      volume_response_downside_pct: -25,
      volume_response_upside_pct: 0,
      gap_field_keys: null,
      gap_why: null,
    },
  };

  it("keeps a full recommendation and computes its scenario", () => {
    const { kept, rejected } = buildRecommendations([RAW], 2, OFFERS, KEYS);
    expect(rejected).toHaveLength(0);
    expect(kept[0]!.scenario.breakeven_condition).toContain("sales can fall");
    expect(kept[0]!.reversibility.level).toBe("easy");
    expect(kept[0]!.sensitivity_callouts.length).toBeGreaterThan(0);
  });

  it("rejects addressing findings that do not exist", () => {
    const { kept, rejected } = buildRecommendations(
      [
        { ...RAW, addresses: [5] },
        { ...RAW, addresses: [] },
      ],
      2,
      OFFERS,
      KEYS,
    );
    expect(kept).toHaveLength(0);
    expect(rejected.every((r) => r.reason.includes("findings that do not exist"))).toBe(true);
  });

  it("rejects a missing undo story — reversibility is not optional prose", () => {
    const { rejected } = buildRecommendations(
      [{ ...RAW, if_you_change_your_mind: "  " }],
      2,
      OFFERS,
      KEYS,
    );
    expect(rejected[0]!.reason).toContain("reversibility");
  });

  it("rejects an unknown offer and a close_gap citing invented fields", () => {
    const { rejected } = buildRecommendations(
      [
        { ...RAW, scenario: { ...RAW.scenario, offer_id: "ghost" } },
        {
          ...RAW,
          title: "Fill a gap",
          scenario: {
            kind: "close_gap",
            offer_id: null,
            change_pct: null,
            volume_response_base_pct: null,
            volume_response_downside_pct: null,
            volume_response_upside_pct: null,
            gap_field_keys: ["made.up_key"],
            gap_why: "x",
          },
        },
      ],
      2,
      OFFERS,
      KEYS,
    );
    expect(rejected[0]!.reason).toContain("ghost");
    expect(rejected[1]!.reason).toContain("made.up_key");
    expect(rejected[1]!.reason).toContain("neither recorded nor fillable");
  });

  it("close_gap may cite a fillable-but-missing key — the live run's rejected rec", () => {
    const fillable = new Set([...KEYS, "offers.of-2.cost_to_deliver"]);
    const { kept, rejected } = buildRecommendations(
      [
        {
          ...RAW,
          title: "Record what Winter spice costs to make",
          scenario: {
            kind: "close_gap",
            offer_id: null,
            change_pct: null,
            volume_response_base_pct: null,
            volume_response_downside_pct: null,
            volume_response_upside_pct: null,
            gap_field_keys: ["offers.of-2.cost_to_deliver"],
            gap_why: "its margin cannot be judged without it",
          },
        },
      ],
      2,
      OFFERS,
      fillable,
    );
    expect(rejected).toHaveLength(0);
    expect(kept[0]!.scenario.breakeven_condition).toContain("costs time, not margin");
  });

  it("close_gap with real keys yields the time-not-margin scenario", () => {
    const s = closeGapScenario(["costs.fixed_monthly"], "fixed costs are unknown");
    expect(s.breakeven_condition).toContain("costs time, not margin");
    expect(s.base_case.profit_delta_monthly).toBeNull();
  });
});

/* ── the run, against a real profile with a real offer ── */

let accountId: string;
let profileId: string;

beforeAll(async () => {
  await loadBank("specs/question-bank-v1.json");
  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: "HUF", locale: "hu-HU" })
    .returning();
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: account!.id, schema_version: "1.0.0" })
    .returning();
  accountId = account!.id;
  profileId = profile!.id;

  const [offer] = await db
    .insert(offers)
    .values({ profile_id: profileId, kind: "physical" })
    .returning();
  const at = isoDateTime(new Date().toISOString());
  const write = (key: string, value: unknown): Promise<string> =>
    writeField(
      profileId,
      createField<unknown>({
        id: fieldId(key),
        value,
        status: "answered",
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: at,
        recorded_at: at,
      }),
    );
  await write(`offers.${offer!.id}.name`, "Szörp 0.5L");
  await write(`offers.${offer!.id}.price`, { amount_minor: 499_000, currency: "HUF" });
  await write(`offers.${offer!.id}.cost_to_deliver`, { amount_minor: 409_000, currency: "HUF" });
  await write(`offers.${offer!.id}.volume_period`, 310);
});

afterAll(async () => {
  const snaps = await db
    .select({ id: profileSnapshots.id })
    .from(profileSnapshots)
    .where(eq(profileSnapshots.profile_id, profileId));
  for (const s of snaps) {
    await db.delete(snapshotRecords).where(eq(snapshotRecords.snapshot_id, s.id));
  }
  await db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, profileId));
  await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profileId));
  await db.delete(offers).where(eq(offers.profile_id, profileId));
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

const FINDINGS = [
  {
    area: "finance" as const,
    title: "Best seller barely makes money",
    detail: "Margin per unit is 900 HUF on a 4 990 HUF price.",
    evidence: ["offers"],
    severity: "high" as const,
    confidence: 0.8,
  },
];

function stubLlm(reply: (offerId: string) => unknown): {
  llm: RecommendationsLlm;
  prompts: string[];
} {
  const prompts: string[] = [];
  return {
    prompts,
    llm: ({ user }) => {
      prompts.push(user);
      const offerId = /OFFER ([0-9a-f-]{36})/.exec(user)?.[1] ?? "missing";
      return Promise.resolve({ text: JSON.stringify(reply(offerId)), calls: [] });
    },
  };
}

describe("the run — model frames, code proves", () => {
  it("shows the model the offers with UNKNOWNs marked, and computes what it framed", async () => {
    const { llm, prompts } = stubLlm((offerId) => ({
      recommendations: [
        {
          addresses: [0],
          title: "Test a 12% price rise on the 0.5L",
          rationale: "Thin margin, loyal buyers.",
          effort: "low",
          reversibility_level: "easy",
          if_you_change_your_mind: "Set the price back; no contracts change.",
          scenario: {
            kind: "price_change",
            offer_id: offerId,
            change_pct: 12,
            volume_response_base_pct: -5,
            volume_response_downside_pct: -25,
            volume_response_upside_pct: 0,
            gap_field_keys: null,
            gap_why: null,
          },
        },
      ],
    }));

    const result = await runRecommendations({ accountId, profileId, findings: FINDINGS, llm });

    expect(prompts[0]).toContain("price=4990 HUF");
    expect(prompts[0]).toContain("volume=310/month");
    expect(result.recommendations).toHaveLength(1);
    const rec = result.recommendations[0]!;
    expect(rec.scenario.breakeven_condition).toContain("sales can fall up to 40%");
    expect(rec.scenario.base_case.formula).toContain("units");
    expect(rec.sensitivity_callouts.join(" ")).toContain("depends heavily");
    expect(result.snapshot_id).toBeTruthy();
  });

  it("throws when every recommendation is rejected, naming the reasons", async () => {
    const { llm } = stubLlm(() => ({
      recommendations: [
        {
          addresses: [7],
          title: "Addresses a ghost finding",
          rationale: "x",
          effort: "low",
          reversibility_level: "easy",
          if_you_change_your_mind: "x",
          scenario: {
            kind: "close_gap",
            offer_id: null,
            change_pct: null,
            volume_response_base_pct: null,
            volume_response_downside_pct: null,
            volume_response_upside_pct: null,
            gap_field_keys: ["costs.fixed_monthly"],
            gap_why: "x",
          },
        },
      ],
    }));
    await expect(
      runRecommendations({ accountId, profileId, findings: FINDINGS, llm }),
    ).rejects.toThrow(/do not exist/);
  });

  it("refuses to run with no findings", async () => {
    await expect(
      runRecommendations({ accountId, profileId, findings: [], llm: stubLlm(() => ({})).llm }),
    ).rejects.toThrow(DiagnosisError);
  });
});
