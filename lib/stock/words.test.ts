// L-4b: the stock sentences go through the "stockWords" catalogue. English
// through the default is English through englishStock(), and the keys hold
// the code's own words; with another translator nothing English is left,
// and the figures come out in the reader's locale (de-DE money "1.234,56 €").

import { describe, expect, it } from "vitest";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
import { buildStockHistory, stockHistorySummary } from "../charts/stock-history";
import type { StockItem } from "./assess";
import { assessItem, shiftDay } from "./assess";
import type { LeadTime } from "./cover";
import { assessCover, coverColumn, leadTimeFor, recentRate, sellThrough } from "./cover";
import type { OptionContext } from "./options";
import { clearanceOptions, efficiencyLine } from "./options";
import type { Words } from "./words";
import { englishStock, exactMoney } from "./words";

const TODAY = "2026-10-27";
const YESTERDAY = shiftDay(TODAY, -1);

function item(onHand: number, perDay: number, over: Partial<StockItem> = {}): StockItem {
  const daily = new Map<string, number>();
  for (let i = 0; i < 120; i++) if (perDay > 0) daily.set(shiftDay(YESTERDAY, -i), perDay);
  return {
    provider: "shopify",
    connection_id: "c1",
    ref: "p1",
    name: "Blue Mug",
    as_of: TODAY,
    on_hand: onHand,
    value_at_cost: onHand * 123_456,
    value_at_price: onHand * 340_000,
    currency: "EUR",
    cost_basis: "measured",
    offer_id: null,
    sales: { kind: "series", covered_days: 120, daily },
    ...over,
  };
}

const LEAD: LeadTime = {
  days: 10,
  basis: "stated",
  supplier: { id: "s1", name: "Midland Clay Supplies" },
  source_field: "suppliers.s1.lead_time_days",
  moq: 50,
  moq_field: "suppliers.s1.moq",
  why: "Midland Clay Supplies takes 10 days, from your answer",
};

/** A translator that keeps only keys and values: any English left is a leak. */
const fake: Tr = (k, v) => `[${k}${v ? " " + JSON.stringify(v) : ""}]`;
const GERMAN: Words = { tr: fake, locale: "de-DE" };

const ctx = (fmt: (m: number) => string): OptionContext => ({
  best_seller: { name: "Green Bowl", on_hand: 4 },
  content_channel: "Instagram",
  emailable: 1200,
  email_off: null,
  fmt,
});

const NO_COLUMN: Partial<StockItem> = {
  sales: { kind: "file", window_days: null, units_in_window: null, days_since_sale: null },
};

describe("stock words — English", () => {
  it("the default is the catalogue's English, and the keys hold the code's words", () => {
    const en = englishTr("stockWords");
    expect(en("why.noneOnHand")).toBe("none on hand");
    expect(en("option.label.markdown")).toBe("Mark it down");
    expect(en("source.file")).toBe("Your stock file");
    const quiet = item(5, 0);
    expect(assessItem(quiet, TODAY).why).toBe(assessItem(quiet, TODAY, englishStock()).why);
    expect(assessItem(quiet, TODAY).why).toBe("no sale in the 120 days on record, with 5 on hand");
  });

  it("a warning, its head and the reorder arithmetic read as before", () => {
    const c = assessCover(item(20, 3), TODAY, LEAD, null, "Shopify");
    expect(c.warning!.sentence).toBe(
      "Blue Mug runs out in about 6–7 days; Midland Clay Supplies takes 10 days.",
    );
    expect(c.warning!.head).toBe("Blue Mug runs out in about 6–7 days.");
    expect(c.reorder!.arithmetic).toBe(
      "3.0 a day (up to 3.3) over 10 days = 30, + 4 safety margin (the fast end of the range) = 34; Midland Clay Supplies' minimum order is 50, so 50.",
    );
    expect(c.reorder!.cost_arithmetic).toBe("50 × €1,234.56 at cost = €61,728.00");
    expect(coverColumn(c)).toBe("6 to 7");
  });

  it("the history summary reads as before", () => {
    const model = buildStockHistory(
      [
        {
          connection_id: "c1",
          product_ref: "p1",
          period_date: "2026-10-01",
          value_minor: 120_000,
          currency: "EUR",
        },
        {
          connection_id: "c1",
          product_ref: "p1",
          period_date: "2026-10-20",
          value_minor: 90_000,
          currency: "EUR",
        },
      ],
      [{ connection_id: "c1", ref: "p1", name: "Blue Mug" }],
    )!;
    expect(model.summary).toBe(
      "Cash tied up at cost in the 1 slowest item, on each stock count from 1 Oct to 20 Oct: Blue Mug from €1,200 to €900. A stock, read on each count day — never added across days.",
    );
    expect(stockHistorySummary(model)).toBe(model.summary);
  });
});

describe("stock words — through another translator", () => {
  it("every screen sentence goes through the translator, figures in the locale", () => {
    const c = assessCover(item(20, 3), TODAY, LEAD, null, "Shopify", GERMAN);
    const said = [
      c.warning!.sentence,
      c.warning!.head,
      c.reorder!.arithmetic,
      c.reorder!.cost_arithmetic!,
      c.sources,
      ...c.assumed,
      c.sell_through.sentence,
      assessItem(item(5, 0), TODAY, GERMAN).why,
      (recentRate(item(5, 1, NO_COLUMN), TODAY, GERMAN) as { sentence: string }).sentence,
      sellThrough(item(5, 1), TODAY, 28, GERMAN).sentence,
      leadTimeFor({ offer_id: null }, [], GERMAN).why,
    ];
    for (const s of said) expect(s.startsWith("[")).toBe(true);
    expect(c.reorder!.cost_arithmetic).toContain("1.234,56 €");
    expect(c.reorder!.cost_arithmetic).toContain("61.728,00 €");
    expect(c.sources).toContain("27. Okt. 2026");
    expect(coverColumn({ ...c, sold_out: true }, GERMAN)).toBe("[cover.colSoldOut]");
  });

  it("options, their arithmetic and the efficiency line", () => {
    const fmt = (minor: number) => exactMoney(minor, "EUR", GERMAN.locale);
    expect(fmt(123_456)).toBe("1.234,56 €");
    const opts = clearanceOptions(item(40, 0), ctx(fmt), GERMAN);
    for (const o of opts) {
      expect(o.label).toBe(`[option.label.${o.key}]`);
      expect(o.arithmetic.startsWith("[option.arithmetic.")).toBe(true);
      expect(efficiencyLine(o, fmt, GERMAN).startsWith("[option.efficiency")).toBe(true);
    }
    expect(opts.find((o) => o.key === "email")!.arithmetic).toContain('"customers":"1.200"');
    expect(opts.find((o) => o.key === "markdown")!.arithmetic).toContain('"cut":"25 %"');
  });

  it("the history summary, dates and money in the locale", () => {
    const s = stockHistorySummary(
      {
        currency: "EUR",
        dates: ["2026-10-01", "2026-10-20"],
        items: [
          {
            key: "c1:p1",
            name: "Blue Mug",
            points: [
              { date: "2026-10-01", cash_minor: 120_000 },
              { date: "2026-10-20", cash_minor: 90_000 },
            ],
          },
        ],
      },
      GERMAN,
    );
    expect(s.startsWith("[history.summary")).toBe(true);
    expect(s).toContain("1.200 €");
    expect(s).toContain('"from":"1. Okt."');
  });
});
