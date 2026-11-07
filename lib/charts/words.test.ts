// L-4b: the charts' sentences come from the "chartsWords" catalogue. In
// English they are the code's own words; with another translator nothing
// English is left, and every figure and date is the reader's.

import "dotenv/config"; // ./load imports the database module (nothing here queries it)
import { describe, expect, it } from "vitest";
import { shiftDay } from "../anomaly/baseline";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
import { METRIC_NOUN, sourceLabel } from "./load";
import { buildMarketModel, chartSummary, chartTable } from "./model";
import type { MarketInputs } from "./model";
import type { BookingsInput } from "./opportunity";
import { headline, noShows, onTheTable, revenueDips } from "./opportunity";
import { ARCHETYPE_KEYS, CHART_ARCHETYPES } from "./profiles";
import { buildAdsChart, buildBookingsChart } from "./small";
import { bucketCandles } from "./candles";
import type { Words } from "./words";
import { englishChartWords, percentText, sentenceDay } from "./words";

const en = englishTr("chartsWords");
/** A translator that only echoes its key and values: anything English in the output came from code. */
const fake: Tr = (k, v) => `[${k}${v ? " " + JSON.stringify(v) : ""}]`;
const de: Words = { tr: fake, locale: "de-DE" };

const MON = "2026-10-05";
const W = { from: MON, to: shiftDay(MON, 13) };
const bookings: BookingsInput = {
  source: "Square",
  series: "connector:square",
  currency: "EUR",
  late_separated: true,
  days: Array.from({ length: 14 }, (_, i) => ({
    date: shiftDay(MON, i),
    completed: 10,
    no_show: i % 4 === 0 ? 1 : 0,
    late: 0,
    revenue_minor: 10 * 123400,
  })),
};

function shop(): MarketInputs {
  const values = new Map<string, number>();
  for (let i = 59; i >= 0; i--)
    values.set(shiftDay("2026-10-24", -i), 100000 + ((i * 7919) % 30000));
  return {
    today: "2026-10-25",
    noun: "your shop",
    archetype: "shop",
    price: {
      candidate: CHART_ARCHETYPES.shop.price[0]!,
      source: "Shopify",
      series_id: "connector:shopify:revenue.daily",
      currency: "EUR",
      values,
    },
    volume: null,
    bookings: null,
    capacity: null,
    campaigns: null,
    stock: null,
    waiting: [],
    events: [{ date: "2026-10-01", kind: "connected", label: "Shopify connected", detail: "d" }],
    other_currencies: ["GBP"],
  };
}

describe("the charts' sentences in English are the code's own words", () => {
  it("invites each kind of business to connect in the profile's own words", () => {
    for (const a of ARCHETYPE_KEYS)
      expect(en(`connect.${a}`)).toBe(`${CHART_ARCHETYPES[a].connect}.`);
  });

  it("names every detected series as the event label always did", () => {
    const code: Record<string, string> = {
      "revenue.daily": "revenue",
      "orders.daily": "orders",
      "sessions.daily": "sessions",
      "ad_spend.daily": "adSpend",
      "ad_purchases.daily": "adPurchases",
      "appointments_completed.daily": "appointmentsCompleted",
      "booking_revenue.daily": "bookingRevenue",
    };
    for (const [metric, noun] of Object.entries(METRIC_NOUN)) {
      expect(en("event.drop", { metric: code[metric]!, noun: "x", pct: "" })).toBe(`${noun} fell`);
      expect(en("event.riseBy", { metric: code[metric]!, noun: "x", pct: "41%" })).toBe(
        `${noun} rose 41% above the usual level`,
      );
    }
    expect(en("event.drop", { metric: "other", noun: "ad_spend.campaign.daily", pct: "" })).toBe(
      "ad_spend.campaign.daily fell",
    );
  });

  it("is the default every builder takes", () => {
    expect(noShows(bookings, W, englishChartWords())).toEqual(noShows(bookings, W));
    expect(headline([noShows(bookings, W)], "EUR").text).toMatch(
      /^About €\d[\d,]*(–€[\d,]+)? a month is slipping away — all of it no-shows\.$/,
    );
    expect(sourceLabel("bookings_import")).toBe("your bookings export");
    expect(percentText(41, "en")).toBe("41%");
    expect(sentenceDay("2026-10-05", "en")).toBe("5 Oct 2026");
  });
});

describe("the charts' sentences in another language", () => {
  it("route every reason, formula and headline through the translator, figures in the locale", () => {
    const c = noShows(bookings, W, de);
    if (c.status !== "priced") throw new Error("expected priced");
    expect(c.formula).toMatch(/^\[formula\.noShows /);
    expect(c.formula).toMatch(/"price":"1\.234\s€"/);
    expect(c.formula).toContain("[price.arithmetic ");
    const h = headline([c], "EUR", de);
    expect(h.text).toMatch(/^\[headline\.all /);
    expect(h.text).toContain('"lead":"no_shows"');
    expect(revenueDips(null, W, undefined, de)).toMatchObject({ reason: "[reason.noTakings]" });
    const t = onTheTable(
      [{ id: "p", summary: "Raise the mug price", base: null, upside: null }],
      "EUR",
      MON,
      de,
    );
    expect(t).toMatchObject({ reason: "[reason.noPricedGain]" });
  });

  it("keeps stored text as stored, and dates days in the language", () => {
    const t = onTheTable(
      [
        {
          id: "p",
          summary: "Raise the mug price",
          base: { amount_minor: 1000000, currency: "EUR" },
          upside: { amount_minor: 2000000, currency: "EUR" },
        },
      ],
      "EUR",
      MON,
      de,
    );
    if (t.status !== "priced") throw new Error("expected priced");
    expect(t.formula).toContain("Raise the mug price");
    expect(t.formula).toMatch(/10\.000\s€–20\.000\s€/);
    expect(sentenceDay("2026-10-05", "de-DE")).toBe("5. Okt. 2026");
    expect(percentText(41, "fr-FR")).toMatch(/^41\s%$/u);
  });

  it("builds the market model, summary, caption and small charts with no English sentence left", () => {
    const m = buildMarketModel(shop(), de);
    if (m.status !== "drawn") throw new Error("expected drawn");
    expect(m.headline.text).toMatch(/^\[headline\./);
    expect(m.notes[0]).toMatch(/^\[note\.otherCurrencies /);
    const candles = bucketCandles(m.days, "week");
    const market: Tr = (k) => `<${k}>`;
    const s = chartSummary(m, candles, "week", de, market);
    expect(s).toMatch(/^\[summary\.week /);
    expect(s).toContain('"title":"<title>"');
    expect(s).toContain("[summary.events ");
    expect(s).not.toMatch(/candles|closed|a day from/);
    expect(chartTable(m, candles, "week", "de-DE", market, de).caption).toMatch(
      /^\[caption\.week /,
    );
    const empty = buildMarketModel({ ...shop(), price: null }, de);
    expect(empty.status === "empty" && empty.message).toBe("[connect.shop]");
    const b = buildBookingsChart(bookings, m, W, de);
    expect(b?.summary).toMatch(/^\[small\.bookingsLateWorth /);
    expect(b?.lost_note).toMatch(/^\[small\.sentence /);
    const ads = buildAdsChart(
      [
        {
          campaign_ref: "c",
          campaign_name: "Autumn mugs",
          currency: "EUR",
          measured_days: 14,
          spend_minor: 123456,
          value_minor: 0,
          roas: 0,
          losing: true,
        },
      ],
      W,
      de,
    );
    expect(ads?.summary).toMatch(/^\[small\.ads /);
    expect(ads?.summary).toContain("Autumn mugs");
    expect(ads?.summary).toMatch(/1\.234,56\s€/);
  });
});
