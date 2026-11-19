// L-4b of TASKS-LANGUAGES.md — the sentences Seasons & bundles,
// Competitors and Reviews build from data, through a translator: English
// by default word for word what the code always said, and with another
// translator nothing English left and the figures in that locale.

import "dotenv/config"; // lib/seasons/load and lib/competitors/view import the db (no query here)
import { describe, expect, it } from "vitest";
import { pairMargin } from "../bundles/pairs";
import { money } from "../core/money";
import { changeSentence, detectChanges, type ChangeFacts } from "../competitors/changes";
import { priceGap } from "../competitors/compare";
import { reasonIn } from "../competitors/view";
import { GOOGLE_READ_OUTCOMES, googleReadWords } from "../google-business/reasons";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
import { refusalIn } from "../review-desk/draft";
import { addDays, englishSeasonWords, rewordSeason, seasonForecast } from "./forecast";
import { seasonsInWords, seriesIn } from "./load";

const fake: Tr = (k, v) => `[${k}${v ? " " + JSON.stringify(v) : ""}]`;
const DE = { tr: fake, locale: "de-DE" as const };
const TODAY = "2026-10-26";
const INFO = {
  noun: "revenue",
  source: "Shopify",
  currency: "EUR",
  metric: "revenue.daily",
  provider: "shopify",
};

function year(): Map<string, number> {
  const m = new Map<string, number>();
  for (let d = "2025-10-20"; d <= "2026-10-25"; d = addDays(d, 1)) {
    m.set(d, d >= "2025-11-24" && d <= "2025-12-21" ? 20_000 : 10_000);
  }
  return m;
}

/** Every sentence is a catalogue key, nothing left in English. */
const allKeys = (xs: readonly string[]) => xs.every((x) => /^\[[a-zA-Z.]+( \{.*\})?\]$/.test(x));

describe("the season forecast's words", () => {
  it("English through the catalogue is the code's own English", () => {
    const r = seasonForecast(year(), INFO, TODAY);
    expect(seasonForecast(year(), INFO, TODAY, englishSeasonWords())).toEqual(r);
    if (r.status !== "ready") throw new Error("ready expected");
    expect(r.headline).toBe(
      "Your busy stretch starts in 4 weeks: last year it ran 2.0× your normal week.",
    );
    expect(r.upcoming[0]?.sentence).toBe(
      "The 4 weeks from 24 Nov to 21 Dec last year ran 2.0× your normal week: above it. The same weeks this year start in 4 weeks, on 23 Nov.",
    );
    expect(rewordSeason(r, englishSeasonWords())).toEqual(r);
  });

  it("another translator says every sentence, with German figures and dates", () => {
    const r = rewordSeason(seasonForecast(year(), INFO, TODAY), DE);
    if (r.status !== "ready") throw new Error("ready expected");
    expect(allKeys([r.headline, ...r.notes])).toBe(true);
    expect(r.headline).toContain('"ratio":"2,0×"');
    const s = r.upcoming[0]!.sentence;
    expect(s).toMatch(/^\[season\.upcoming /);
    expect(s).toContain('"from":"24. Nov."');
    expect(s).toContain("[season.when.startsIn");
  });

  it("too little history: the headline, can and cannot", () => {
    const short = new Map<string, number>();
    for (let d = "2026-06-01"; d <= "2026-10-25"; d = addDays(d, 1)) short.set(d, 10_000);
    const en = seasonForecast(short, INFO, TODAY);
    if (en.status !== "too_little") throw new Error("too_little expected");
    expect(en.headline).toBe(
      "I have about 5 months of your revenue, not enough to say which weeks of the year are your busy ones.",
    );
    const de = rewordSeason(en, DE);
    if (de.status !== "too_little") throw new Error("too_little expected");
    expect(allKeys([de.headline, ...de.can, ...de.cannot])).toBe(true);
  });

  it("the series noun, source and connect line by code, brands kept", () => {
    expect(seriesIn(INFO, englishSeasonWords())).toEqual(INFO);
    expect(seriesIn(INFO, DE)).toMatchObject({ noun: "[noun.revenue]", source: "Shopify" });
    expect(seriesIn({ ...INFO, provider: "bookings_import" }, DE).source).toBe(
      "[source.bookingsExport]",
    );
    const v = seasonsInWords(
      { result: { status: "no_data" }, connect: "x", archetype: "shop", other_currencies: [] },
      DE,
    );
    expect(v.connect).toBe("[connect.shop]");
    expect(englishTr("patternsWords")("connect.shop")).toBe(
      "Connect Shopify or WooCommerce, or your till through Square, and I'll draw this",
    );
  });

  it("a pair margin's why", () => {
    const plate = { name: "Plate", economics: null };
    const bowl = { name: "Bowl", economics: null };
    expect(pairMargin(plate, bowl)).toEqual({
      known: false,
      why: "no price on record for Plate or Bowl",
    });
    expect(pairMargin(plate, bowl, fake)).toEqual({
      known: false,
      why: '[margin.noPrice {"count":2,"a":"Plate","b":"Bowl"}]',
    });
  });
});

describe("the competitors' words", () => {
  it("a price gap, in English and in German money", () => {
    expect(priceGap(money(6900, "EUR"), money(8500, "EUR"))?.words).toBe("€16 below yours (−19%)");
    const de = priceGap(money(6900, "EUR"), money(8500, "EUR"), DE)!.words;
    expect(de).toMatch(/^\[gap\.belowPct /);
    expect(de).toMatch(/"amount":"16\s€"/u);
  });

  it("a change said from its stored parts", () => {
    const o = (name: string, minor: number) => ({
      key: name.toLowerCase(),
      name,
      price: money(minor, "EUR"),
      from: false,
      method: "pattern" as const,
      url: "https://x.test/p",
      fetched_at: "2026-10-01T00:00:00Z",
    });
    const [ch] = detectChanges({
      competitor: "Salon Ivy",
      before: [o("Cut and colour", 8000)],
      after: [o("Cut and colour", 7000)],
      freshUrls: new Set(["https://x.test/p"]),
      ratingBefore: null,
      ratingAfter: null,
    });
    expect(ch!.sentence).toBe("Salon Ivy cut its cut and colour price from €80 to €70.");
    expect(changeSentence(ch!.flag, ch!.facts)).toBe(ch!.sentence);
    const de = changeSentence(ch!.flag, ch!.facts as ChangeFacts, DE);
    expect(de).toMatch(/^\[change\.cheaper /);
    expect(de).toContain('"name":"Cut and colour"');
    expect(de).toMatch(/"price":"70\s€"/u);
  });

  it("a read's problem: known reasons by the catalogue, anything else as stored", () => {
    for (const r of [
      "it asks for a login, and I never read pages behind one",
      "the page answered 404",
      "no answer within 8 seconds",
      "past the 5-page limit per competitor",
    ]) {
      expect(reasonIn(r)).toBe(r);
      expect(reasonIn(r, DE)).toMatch(/^\[reason\./);
    }
    expect(reasonIn("the page answered 404", DE)).toBe('[reason.answered {"status":"404"}]');
    expect(reasonIn("something nobody wrote", DE)).toBe("something nobody wrote");
  });
});

describe("the reviews' words", () => {
  it("Google's last-read outcome", () => {
    for (const [k, v] of Object.entries(GOOGLE_READ_OUTCOMES)) {
      expect(googleReadWords(k, englishTr("reviewsWords"))).toBe(v);
      expect(googleReadWords(k, fake)).toBe(`[googleRead.${k}]`);
    }
    expect(googleReadWords("nonsense", fake)).toBeNull();
  });

  it("the draft refusals, the budget in the reader's money", () => {
    expect(refusalIn("budget")).toBe(
      "This month's support budget (€5) is spent, so I won't draft: write it yourself.",
    );
    expect(refusalIn("cap")).toBe(
      "I've suggested a reply to this review 3 times already: write this one yourself.",
    );
    expect(refusalIn("budget", DE)).toMatch(/^\[draft\.budget \{"amount":"5\s€"\}\]$/u);
    expect(refusalIn("offer", DE)).toBe("[draft.offer]");
  });
});
