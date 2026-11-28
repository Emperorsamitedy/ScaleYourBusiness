// Feature 34 and P5-05 - the stock screen's words, and who the screen exists for.

import { describe, expect, it } from "vitest";
import type { CoverItemView, StockItemView, StockView } from "../../app/api/stock/route";
import type { FieldView } from "../../lib/conditions/evaluate";
import { evaluate } from "../../lib/conditions/evaluate";
import { STOCK_APPLIES } from "../../lib/stock/applies";
import { GROUPS, visibleGroups } from "../nav/AppFrame";
import type { NavCounts } from "../../app/api/nav/route";
import {
  cashBars,
  coverBars,
  coverFlagClass,
  coverText,
  headline,
  itemStatus,
  lastsWords,
  leadText,
  moneyLine,
  plainTitle,
  plainWhy,
  proposalWord,
  quietText,
  statedVsMeasured,
  statusTone,
  statusWord,
  stockHeadline,
  vsPriorText,
} from "./stock-view";

const item = (over: Partial<StockItemView> = {}): StockItemView => ({
  key: "c:p",
  name: "Large Serving Bowl",
  source: "Shopify",
  as_of: "2026-10-22",
  on_hand: 40,
  sold: { 30: 0, 60: 0, 90: 0 },
  days_of_cover: null,
  days_since_sale: null,
  no_sale_for_at_least: 120,
  cash_tied_minor: 104_000,
  value_at_price_minor: 356_000,
  currency: "EUR",
  cost_basis: "measured",
  flag: "STUCK",
  why: "no sale in the 120 days on record",
  proposed_for: true,
  options: [],
  ...over,
});

const view = (over: Partial<StockView> = {}): StockView => ({
  applies: true,
  sources: [{ label: "Shopify", as_of: "2026-10-22", items: 3 }],
  slow: [item()],
  totals: [{ currency: "EUR", cash_tied_minor: 104_000, items: 1, unknown_cost: 0 }],
  stated_dead_stock: null,
  ...over,
});

describe("the screen's words", () => {
  it("states the cash tied up as the headline", () => {
    expect(headline(view())).toBe("€1,040 is tied up in 1 item that isn't selling.");
    expect(headline(view({ slow: [] }))).toBe("Everything you hold is selling.");
    expect(headline(view({ sources: [{ label: "Shopify", as_of: null, items: 0 }] }))).toBe(
      "I haven't read your stock yet.",
    );
  });

  it("prints quiet days as a lower bound when no sale is on record, and cover in words when there's no rate", () => {
    expect(quietText(item())).toBe("120+");
    expect(quietText(item({ days_since_sale: 75, no_sale_for_at_least: null }))).toBe("75");
    expect(coverText(item())).toBe("no sales");
    expect(coverText(item({ days_of_cover: 900 }))).toBe("900");
  });

  it("says plainly when a standing rule blocked an option", () => {
    const o = {
      key: "markdown",
      label: "Mark it down",
      unavailable: null,
      recovered: { low: 0, high: 0, expected: 0 },
      given_up: { low: 0, high: 0, expected: 0 },
      per_euro: null,
      efficiency: "",
      arithmetic: "",
      reversibility: "",
      proposal: { id: "x", status: "blocked", blocked_by_limit: "13.5: We never discount." },
    };
    expect(proposalWord(o)).toEqual({ word: "Blocked by your rule", tone: "alarm" });
  });

  it("shows the owner's dead-stock estimate beside what was measured (rule 11)", () => {
    expect(
      statedVsMeasured(view({ stated_dead_stock: { amount_minor: 50_000, currency: "EUR" } })),
    ).toBe(
      "You estimated your dead stock at €500; I measure €1,040 at cost in stock that isn't selling: €540 more. Your estimate stays on your fact sheet.",
    );
    expect(statedVsMeasured(view())).toBeNull();
  });
});

describe("who sees it - data, not an if on business type", () => {
  const ctx = (fields: Record<string, FieldView>) => ({ get: (k: string) => fields[k] });
  const sells = (...codes: string[]) => ({
    status: "answered" as const,
    value: codes.map((code) => ({ code })),
  });

  it("a business selling physical products sees it; a services-only one never does", () => {
    expect(
      evaluate(STOCK_APPLIES, ctx({ "identity.sells": sells("physical_products", "services") })),
    ).toBe(true);
    expect(evaluate(STOCK_APPLIES, ctx({ "identity.sells": sells("services") }))).toBe(false);
    expect(evaluate(STOCK_APPLIES, ctx({}))).toBe(false);
  });

  it('an owner who said they hold no stock (1.4.1.2 "no") doesn\'t see it', () => {
    expect(
      evaluate(
        STOCK_APPLIES,
        ctx({
          "identity.sells": sells("physical_products"),
          "offers.physical.holds_inventory": { status: "answered", value: { code: "no" } },
        }),
      ),
    ).toBe(false);
  });

  it("the menu shows Stock only when the counts say the business holds stock", () => {
    const counts = (stock: boolean) => ({ stock, by_module: {} }) as unknown as NavCounts;
    const hrefs = (c: NavCounts | null) =>
      visibleGroups(null, c).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs(counts(true))).toContain("/stock");
    expect(hrefs(counts(false))).not.toContain("/stock");
    expect(hrefs(null)).not.toContain("/stock"); // still loading: not shown on a guess
    // Without counts the size table alone decides, as before.
    expect(visibleGroups(null)).toEqual(GROUPS);
  });
});

const coverItem = (over: Partial<CoverItemView> = {}): CoverItemView => ({
  key: "c:mug",
  name: "Speckled Everyday Mug",
  source: "Shopify",
  as_of: "2026-10-27",
  on_hand: 90,
  sold_recent: 416,
  vs_prior: { change: 23, band: 40, direction: "flat" },
  sell_through: "",
  cover_text: "3 to 4",
  runs_out: { earliest: "2026-10-30", latest: "2026-10-31" },
  lead: { days: 10, basis: "stated", supplier: "Midland Clay Supplies", why: "" },
  flag: "ACT NOW",
  warning: "Speckled Everyday Mug runs out in about 3–4 days; Midland Clay Supplies takes 10 days.",
  why: null,
  boosted: false,
  per_day: 15.7,
  reorder: null,
  assumed: [],
  sources: "",
  ...over,
});

describe("P5-05 - what runs out, in words", () => {
  const base: StockView = {
    applies: true,
    sources: [{ label: "Shopify", as_of: "2026-10-27", items: 7 }],
    slow: [],
    totals: [],
  };

  it("the headline is the soonest stock-out when there is one", () => {
    const view = { ...base, cover: { items: [coverItem()] } } as unknown as StockView;
    expect(stockHeadline(view)).toBe("Speckled Everyday Mug runs out in about 3–4 days.");
  });

  it("without a warning the headline is the slow-stock line", () => {
    const view = {
      ...base,
      cover: { items: [coverItem({ warning: null, flag: "IN RANGE" })] },
    } as unknown as StockView;
    expect(stockHeadline(view)).toBe(headline(view));
    expect(stockHeadline(view)).toBe("Everything you hold is selling.");
  });

  it("tints each flag, the word carrying the meaning", () => {
    expect(coverFlagClass("ACT NOW")).toBe("alarm");
    expect(coverFlagClass("RUNNING LOW")).toBe("drift");
    expect(coverFlagClass("IN RANGE")).toBe("ok");
    expect(coverFlagClass("SOLD OUT")).toBe("low");
    expect(coverFlagClass("TOO EARLY")).toBe("low");
  });

  it("prints the change between windows, and a dash without two windows", () => {
    expect(vsPriorText(coverItem())).toBe("+23 · about the same");
    expect(vsPriorText(coverItem({ vs_prior: { change: -60, band: 40, direction: "down" } }))).toBe(
      "−60 · down",
    );
    expect(vsPriorText(coverItem({ vs_prior: null }))).toBe("-");
    expect(vsPriorText(coverItem({ vs_prior: { change: 0, band: 0, direction: "flat" } }))).toBe(
      "none sold",
    );
  });

  it("names the supplier, or says the delivery time is ASSUMED", () => {
    expect(leadText(coverItem())).toBe("10 d · Midland Clay Supplies");
    expect(
      leadText(coverItem({ lead: { days: 14, basis: "assumed", supplier: null, why: "" } })),
    ).toBe("14 d · ASSUMED");
  });

  it("words a note's status and cost", () => {
    expect(statusWord({ status: "pending" })).toEqual({ word: "Waiting for you", tone: "ok" });
    expect(statusWord({ status: "rejected" }).word).toBe("Declined");
    expect(moneyLine({ amount_minor: 280_280, currency: "EUR" })).toBe("€2,802.80 at cost");
    expect(proposalWord({ unavailable: "no price", proposal: null } as never)?.word).toBe("Can't");
  });
});

describe("the bars beside the figures", () => {
  it("draws cover against the delivery time on one scale, the tone following the row's flag", () => {
    const bars = coverBars(
      [
        coverItem(),
        coverItem({
          key: "c:vase",
          runs_out: { earliest: "2026-11-06", latest: "2026-11-16" },
          lead: { days: 14, basis: "assumed", supplier: null, why: "" },
          flag: "IN RANGE",
        }),
        coverItem({ key: "c:jug", runs_out: { earliest: "2026-11-01", latest: null } }),
        coverItem({ key: "c:new", runs_out: null, flag: "TOO EARLY" }),
      ],
      "2026-10-27",
    );
    // 3–4 days against a 10-day delivery, on a scale of the longest stretch (20 days).
    expect(bars[0]).toEqual({ low: 0.15, high: 0.2, lead: 0.5, tone: "drift" });
    expect(bars[1]).toEqual({ low: 0.5, high: 1, lead: 0.7, tone: "ink" });
    expect(bars[2]).toMatchObject({ low: 0.25, high: null });
    expect(bars[3]).toBeNull();
  });

  it("ends the scale at four delivery times, so months of cover fill the bar and the rest stay readable", () => {
    const bars = coverBars(
      [
        coverItem(),
        coverItem({
          key: "c:bowl",
          runs_out: { earliest: "2027-04-17", latest: "2027-06-28" },
          flag: "IN RANGE",
        }),
      ],
      "2026-10-27",
    );
    // A 10-day delivery: the scale is 40 days, not the bowl's 244.
    expect(bars[0]).toMatchObject({ low: 0.075, high: 0.1, lead: 0.25 });
    expect(bars[1]).toMatchObject({ low: 1, high: 1 });
  });

  it("draws no cover bar without the dates to read it from", () => {
    expect(coverBars([], "2026-10-27")).toEqual([]);
    expect(coverBars([coverItem()], undefined)).toEqual([null]);
    expect(coverBars([coverItem({ runs_out: null })], "2026-10-27")).toEqual([null]);
  });

  it("sets cash tied up against the largest in its own currency, hollow on a stated cost", () => {
    const bars = cashBars([
      item(),
      item({ key: "b", cash_tied_minor: 26_000, cost_basis: "stated" }),
      item({ key: "c", cash_tied_minor: 900_000, currency: "HUF" }),
      item({ key: "d", cash_tied_minor: null, currency: null, cost_basis: null }),
    ]);
    expect(bars).toEqual([
      { share: 1, tone: "ink" },
      { share: 0.25, tone: "hollow" },
      { share: 1, tone: "ink" },
      null,
    ]);
  });

  it("draws no cash bar where nothing is known", () => {
    expect(cashBars([])).toEqual([]);
    expect(cashBars([item({ cash_tied_minor: 0 })])).toEqual([null]);
  });
});

describe("said plainly (2026-11-28)", () => {
  const reorder = {
    quantity: 250,
    lead_demand: 193,
    safety: 31,
    before_moq: 224,
    arithmetic: "",
    moq: 250,
    rounded_to_moq: true,
    cost: { amount_minor: 245_000, currency: "EUR" },
    cost_arithmetic: null,
    proposal: null,
  };

  it("says how long an item lasts in words", () => {
    expect(lastsWords(coverItem(), "2026-10-27")).toBe("3 to 4 days");
    expect(
      lastsWords(
        coverItem({ runs_out: { earliest: "2026-10-27", latest: "2026-10-27" } }),
        "2026-10-27",
      ),
    ).toBe("Runs out today");
    expect(
      lastsWords(coverItem({ runs_out: { earliest: "2026-10-28", latest: null } }), "2026-10-27"),
    ).toBe("About 1 day");
    expect(lastsWords(coverItem({ flag: "SOLD OUT", on_hand: 0 }), "2026-10-27")).toBe("Sold out");
    expect(lastsWords(coverItem({ flag: "NO SALES", runs_out: null }), "2026-10-27")).toBe(
      "No sales",
    );
    expect(lastsWords(coverItem({ runs_out: null, flag: "TOO EARLY" }), "2026-10-27")).toBe(
      "Not known yet",
    );
  });

  it("ends each row on what it needs, and calls stock the slow list names far too much", () => {
    expect(itemStatus(coverItem())).toBe("order");
    expect(itemStatus(coverItem({ flag: "RUNNING LOW" }))).toBe("soon");
    expect(itemStatus(coverItem({ flag: "IN RANGE" }))).toBe("enough");
    expect(itemStatus(coverItem({ flag: "IN RANGE" }), new Set(["c:mug"]))).toBe("tooMuch");
    expect(itemStatus(coverItem({ flag: "NO SALES" }))).toBe("noSales");
    expect(itemStatus(coverItem({ flag: "TOO EARLY" }))).toBe("early");
    expect(statusTone("order")).toBe("alarm");
    expect(statusTone("tooMuch")).toBe("drift");
    expect(statusTone("enough")).toBe("ok");
  });

  it("says why the quantity in plain sentences, from the parts the code worked out", () => {
    expect(plainWhy(coverItem({ boosted: true, reorder }))).toBe(
      "About 16 a day for the 10 days delivery takes, a little more for the busy weeks: 193. " +
        "Plus 31 spare in case it sells faster: 224. The minimum order from Midland Clay Supplies is 250.",
    );
    // The order counted the busy weeks (193 is above 15.7 a day for 10 days) though the run-out didn't.
    expect(plainWhy(coverItem({ reorder }))).toMatch(/a little more for the busy weeks: 193\./);
    expect(
      plainWhy(
        coverItem({
          reorder: { ...reorder, lead_demand: 157, safety: 0, rounded_to_moq: false, moq: null },
        }),
      ),
    ).toBe("About 16 a day for the 10 days delivery takes: 157.");
    expect(plainWhy(coverItem())).toBeNull();
    expect(plainWhy(coverItem({ reorder, per_day: null }))).toBeNull();
  });

  it("titles the page with the soonest stock-out, else the slow-stock line", () => {
    const base: StockView = {
      applies: true,
      today: "2026-10-27",
      sources: [{ label: "Shopify", as_of: "2026-10-27", items: 7 }],
      slow: [],
      totals: [],
    };
    const view = (over: Partial<CoverItemView>) =>
      ({ ...base, cover: { items: [coverItem(over)] } }) as unknown as StockView;
    expect(plainTitle(view({}))).toBe("Your Speckled Everyday Mug runs out in 3 to 4 days");
    expect(plainTitle(view({ runs_out: { earliest: "2026-10-27", latest: "2026-10-27" } }))).toBe(
      "Your Speckled Everyday Mug runs out about today",
    );
    expect(plainTitle(view({ runs_out: { earliest: "2026-10-29", latest: null } }))).toBe(
      "Your Speckled Everyday Mug runs out in about 2 days",
    );
    expect(plainTitle(view({ warning: null, flag: "IN RANGE" }))).toBe(headline(view({})));
  });
});
