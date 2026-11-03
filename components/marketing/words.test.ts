// L-3d: the landing page's words in the catalogue (messages/en.json
// "landing") say in English exactly what lib/marketing always said, and
// the figures and dates beside them follow the reader's language.

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { PANELS } from "../../lib/marketing/areas";
import { CHART_DAY_COUNT, CHART_SERIES, chartDate } from "../../lib/marketing/sample-chart";
import { DEMO_SAMPLES, SHOP_SAMPLE, SALON_SAMPLE } from "../../lib/marketing/sample-diagnosis";
import { CHAPTERS } from "../../lib/marketing/walkthrough";
import {
  LANDING_FIGURES,
  OPTION_BOUNDS,
  chartDay,
  factWords,
  moneyDash,
  offerFigure,
  optionWords,
  sizeUsd,
  stampTime,
} from "./words";

const messages = en as unknown as Record<string, unknown>;

function tr(namespace: string, locale: AppLocale = "en"): Tr {
  const t = createTranslator({
    locale,
    messages: messages as typeof en,
    namespace: namespace as "common",
  }) as unknown as Tr;
  return (key, values) => t(key, values);
}

const landing = tr("landing");
const walk = tr("landing.walk");
const chart = tr("landing.storeChart");

describe("the landing's English is lib/marketing's own words", () => {
  it("names the nine panels and their markers as PANELS does", () => {
    for (const p of PANELS) {
      expect(landing(`panels.p${p.no}.name`), p.no).toBe(p.name);
      expect(landing(`panels.p${p.no}.markers`), p.no).toBe(p.markers);
    }
  });

  it("titles, captions, crumbs and states the six chapters as CHAPTERS does", () => {
    for (const c of CHAPTERS) {
      for (const key of ["title", "caption", "crumb", "state"] as const) {
        expect(walk(`chapter.c${c.n}.${key}`, { count: LANDING_FIGURES.decisions }), c.n).toBe(
          c[key],
        );
      }
    }
  });

  it("says each demo's words as its sample does", () => {
    for (const s of DEMO_SAMPLES) {
      const own = (key: string, values?: Record<string, string | number>) =>
        walk(`${s.id}.${key}`, values);
      expect(landing(`demo.${s.id}`)).toBe(s.label);
      expect(own("reads")).toBe(s.connect.reads);
      expect(own("question")).toBe(s.record.question);
      s.record.rows.forEach((r, i) => {
        expect(own(`r${i}`, { days: String(LANDING_FIGURES.recordDays) })).toBe(r.what);
        if ("words" in r.figure) expect(own(`w${i}`)).toBe(r.figure.words);
      });
      s.markers.forEach((m, i) => expect(own(`m${i}`)).toBe(m.measure));
      expect(own("area")).toBe(s.proposal.area);
      expect(own("proposal")).toBe(s.proposal.title);
      expect(own("metric")).toBe(s.outcome.metric);
      expect(own("caption")).toBe(
        `Demo with an illustrative ${s.noun}. Your numbers will be your own.`,
      );
      expect(own("stage", { n: "3", caption: "X" })).toBe(
        `Walkthrough with an illustrative ${s.noun}, chapter 3: X`,
      );
      expect(factWords(s, walk, "en")).toBe(s.record.fact);
      expect(optionWords(s, walk, "en")).toEqual([...s.record.options]);
    }
  });

  it("formats the answer tiles from the same bounds the English strings print", () => {
    for (const s of DEMO_SAMPLES) {
      const { money, bounds } = OPTION_BOUNDS[s.id];
      const fromBounds = bounds.flatMap((b) =>
        "under" in b ? [b.under] : "over" in b ? [b.over] : [b.from, b.to],
      );
      const fromEnglish = s.record.options.flatMap((o) => (o.match(/\d+/g) ?? []).map(Number));
      expect(fromBounds.map((v) => (money ? v / 100 : v))).toEqual(fromEnglish);
    }
  });

  it("titles, labels and describes each chart as its series does", () => {
    for (const c of CHART_SERIES) {
      const own = (key: string, values?: Record<string, string | number>) =>
        chart(`${c.id}.${key}`, values);
      expect(own("title")).toBe(c.title);
      expect(own("volume")).toBe(c.volume_label);
      expect(own("subtitle", { days: CHART_DAY_COUNT })).toBe(`Illustrative ${c.noun} · 90 days`);
      expect(own("description", { days: CHART_DAY_COUNT })).toBe(c.description);
      for (const e of c.events) {
        expect(own(`${e.key}.key`)).toBe(e.key);
        expect(own(`${e.key}.label`)).toBe(e.label);
        expect(own(`${e.key}.note`)).toBe(e.note);
      }
    }
  });

  it("keeps the page's own English figures", () => {
    expect(offerFigure(null, 7, "en")).toBe("[7]");
    expect(landing("steps.whenMinutes", { day: "0", minutes: "2" })).toBe("Day 0 · 2 min");
    expect(landing("steps.whenDay", { day: "[7]" })).toBe("Day [7]");
    expect(landing("hero.lede", { checks: "36", daysText: "[7]", days: 7 })).toBe(
      "We run 36 checks on your sales, bookings, payments and ads, price every leak in euros, and hand you a signed report in [7] days.",
    );
    expect(landing("price.markers", { count: 36 })).toBe("36 markers, each priced");
    expect(landing("price.fixes", { count: 3 })).toBe("3 fixes, in order");
    expect(landing("price.walkthrough", { minutes: "30" })).toBe("Signed, 30-min walkthrough");
    expect(landing("price.refund", { leaksText: "[3]", leaks: 3 })).toBe(
      "Fewer than [3] fixable leaks? Full refund.",
    );
    expect(landing("faq.sizeA", { low: sizeUsd(10_000, "en"), high: sizeUsd(50_000, "en") })).toBe(
      "Built for businesses doing about $10k–$50k a month. Too small to read? We tell you before you pay.",
    );
    expect(walk("s5.stamp", { time: stampTime("en") })).toBe("APPROVED · runs 15:00");
    expect(walk("s1.connected", { months: 12 })).toBe("Connected · reading 12 months");
    expect(walk("s5.expectedRange", { low: "€780", high: "€1,420" })).toBe("+€780–€1,420 / mo");
    expect(walk("s6.keyLegend", { key: walk("s6.key") })).toBe("A = approved");
    expect(moneyDash("EUR", "en")).toBe("€ —");
    expect(chartDay(0, "en")).toBe(chartDate(0));
    expect(chart("weekOf", { day: chartDate(7) })).toBe("Week of 27 Jul");
    expect(chart("day", { count: "1" })).toBe("1D");
  });
});

describe("the landing's figures and dates in another language", () => {
  it("formats the tiles, the fact and the dash in German, never in euros typed", () => {
    const de = tr("landing.walk", "de-DE");
    const nb = " ";
    expect(optionWords(SHOP_SAMPLE, de, "de-DE")).toEqual([
      `< 6${nb}€`,
      `6${nb}€–9${nb}€`,
      `9${nb}€–12${nb}€`,
      `12${nb}€+`,
    ]);
    expect(optionWords(SALON_SAMPLE, de, "de-DE")).toEqual(["0–5", "6–12", "13–20", "20+"]);
    expect(factWords(SHOP_SAMPLE, de, "de-DE")).toBe(`Shipping 9${nb}€–12${nb}€`);
    expect(moneyDash("EUR", "de-DE")).toBe(`—${nb}€`);
    expect(stampTime("de-DE")).toBe("15:00");
  });

  it("dates the chart in French and writes the size in French", () => {
    expect(chartDay(0, "fr-FR")).toBe("20 juil.");
    expect(sizeUsd(10_000, "fr-FR")).toMatch(/^10\s?k\s\$US$|^10\sk\s\$$/u);
    expect(offerFigure(1200, 7, "fr-FR")).toBe("1 200");
  });
});
