// L-4b — the cash forecast's sentences come from the "cashWords" catalogue.
// (a) English through the catalogue is exactly what the code printed (the
// default and englishTr agree; the code-chosen words match their data);
// (b) a non-English translator really is used for every sentence, with
// figures and dates in the reader's locale, and the stored path stays English.

import { describe, expect, it } from "vitest";
import type { CashView } from "../../app/api/cash/route";
import { cashChartModel, headline, sourcesLine } from "../../components/cash/cash-view";
import { CHART_ARCHETYPES } from "../charts/profiles";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
import { TODAY, baseInputs, cost, daily, eur, offer } from "./fixtures";
import type { CashForecast, CashInputs, CashReady } from "./model";
import { forecastCash } from "./model";
import { PAYOUT_DAYS, PAYOUT_SOURCE } from "./payout";
import { compareScenarios, defaultChoice } from "./scenarios";
import { tightWeek } from "./warnings";
import type { Words } from "./words";

const en = englishTr("cashWords");
const fake: Tr = (k, v) => `[${k}${v ? " " + JSON.stringify(v) : ""}]`;
const german: Words = { tr: fake, locale: "de-DE" };
const sentences = { tr: fake, sheet: fake, locale: "de-DE" as const };

/** A business with every kind of line: rent, a VAT return, a loan, per-piece and per-order costs. */
const rich = (over: Partial<CashInputs> = {}): CashInputs =>
  baseInputs({
    cash: { status: "known", fact: { ...eur(5000), source_key: "told" } },
    revenue: {
      ...daily(TODAY, 120, () => 10_000),
      metric: "revenue.daily",
      provider: "stripe",
      source: "Stripe",
    },
    volume: {
      noun: "orders",
      metric: "orders.daily",
      values: daily(TODAY, 120, () => 3).values,
    },
    payout: { provider: "stripe", methods: ["card"] },
    debt: { status: "known", fact: eur(12_000) },
    costs: [
      cost("Rent", 1200, "monthly"),
      cost("VAT return", 9000, "quarterly"),
      cost("Insurance", 1200, "annual"),
      cost("Packaging", 1, "per_unit"),
      cost("Shipping", 4, "per_job"),
      cost("Dollar tool", 50, "monthly", { amount: { ...eur(50), currency: "USD" } }),
    ],
    offers: [offer("Mug", 30, 8, 100), offer("Plate", 40, null, 20)],
    connect_key: "shop",
    other_currencies: ["USD"],
    ...over,
  });

const ready = (f: CashForecast): CashReady => {
  if (f.status !== "ready") throw new Error(f.headline);
  return f;
};

/** Every sentence of a forecast the screen shows. */
function sentencesOf(f: CashForecast): string[] {
  if (f.status !== "ready")
    return [f.headline, ...f.can, ...f.cannot, ...f.needs.map((n) => n.what)];
  return [
    ...f.assumptions,
    ...f.left_out,
    ...f.needs.map((n) => n.what),
    ...f.variable.lines,
    ...f.sources.flatMap((s) => [s.label, s.source]),
    f.payout.why,
  ];
}

describe("L-4b — English through the catalogue is the code's own", () => {
  it("the default words and englishTr give the same forecast, word for word", () => {
    for (const inputs of [rich(), rich({ revenue: null }), rich({ cash: { status: "unknown" } })]) {
      expect(forecastCash(inputs, {}, { tr: en, locale: "en" })).toEqual(forecastCash(inputs));
    }
  });

  it("code-chosen words match their data: providers, the connect lines, the payout source", () => {
    for (const [code, d] of Object.entries(PAYOUT_DAYS)) {
      expect(en(`payout.provider.${code}`)).toBe(d.label);
    }
    for (const [key, row] of Object.entries(CHART_ARCHETYPES)) {
      expect(en(`connect.${key}`)).toBe(row.connect);
    }
    expect(en("payout.source")).toBe(PAYOUT_SOURCE);
    expect(en("factSource.told")).toBe("as you told me");
  });

  it("holds a few sentences as the code printed them", () => {
    const f = ready(forecastCash(rich()));
    expect(f.assumptions).toContain("Monthly costs go out on the 1st of each month.");
    expect(f.assumptions).toContain(
      "Quarterly costs go out on the 1st of January, April, July and October: you haven't told me their dates.",
    );
    expect(f.sources.find((s) => s.key === "payout")?.value).toBe("2 to 7 days");
    expect(f.left_out).toContain(
      "Dollar tool is in USD and your cash is in EUR; I don't convert between currencies, so it isn't counted.",
    );
    expect(forecastCash(rich({ revenue: null })).needs[0]?.what).toBe(
      CHART_ARCHETYPES.shop.connect,
    );
  });
});

describe("L-4b — another language goes through the translator, figures in its locale", () => {
  it("every forecast sentence is the translator's; the money is German money", () => {
    const f = ready(forecastCash(rich(), {}, german));
    for (const s of sentencesOf(f)) expect(s).toMatch(/^\[/);
    expect(f.sources.find((s) => s.key === "cash")?.value).toMatch(/^5\.000\s€$/);
    expect(f.series.noun).toBe("[series.noun.revenue]");
    expect(f.sources.find((s) => s.key === "moneyIn")?.value).not.toContain("26 Oct");
    for (const refusal of [
      rich({ revenue: null }),
      rich({ revenue: daily(TODAY, 30, () => 1) }),
      rich({ cash: { status: "missing" } }),
      rich({ cash: { status: "known", fact: { ...eur(5000), currency: "USD" } } }),
    ]) {
      for (const s of sentencesOf(forecastCash(refusal, {}, german))) expect(s).toMatch(/^\[/);
    }
  });

  it("the tight week, the scenarios and the screen's own sentences too", () => {
    const inputs = rich({
      revenue: { ...rich().revenue!, values: daily(TODAY, 120, () => 2_000).values },
    });
    const f = ready(forecastCash(inputs, {}, german));
    const t = tightWeek(f, german)!;
    expect(t.sentence).toMatch(/^\[tight\.sentence /);
    for (const r of t.reasons) expect(r).toMatch(/^\[tight\./);
    // The stored path: the default is English.
    expect(tightWeek(ready(forecastCash(inputs)))!.sentence).toMatch(/^Money could get tight/);

    const cells = compareScenarios(inputs, f, defaultChoice(inputs, f), null, german);
    for (const c of cells) {
      const text =
        c.status === "ready"
          ? [c.result.title, c.result.change, ...c.result.assumptions]
          : [c.title, c.why, ...c.needs.map((n) => n.what)];
      for (const s of text) expect(s).toMatch(/^\[scenario\./);
    }

    const view: CashView = { forecast: f, tight: t, scenarios: cells, choice: null, price: null };
    expect(headline(view, sentences)).toMatch(/^\[view\.headlineTight /);
    expect(sourcesLine(f, sentences)).toMatch(/^\[view\.sourcesReady /);
    expect(sourcesLine(f, sentences)).not.toMatch(/Cash today|money in/);
    const m = cashChartModel(f, t.index, { tr: fake, locale: "de-DE" }, sentences);
    for (const s of [m.title, m.meta, m.foot, m.summary]) {
      expect(s).toMatch(/^\[view\./);
      expect(s).not.toMatch(/cautious|the week of|all the way|buffer all/);
    }
    expect(m.meta).toContain('"observed":"[basis.OBSERVED]"');
  });
});
