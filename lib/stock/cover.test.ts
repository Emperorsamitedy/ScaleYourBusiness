// Phase 5 Session A — what runs out, and when. Pure: every rule with a
// passing and a failing case.
//   P5-01  two windows, the change, and its noise band; refusal under 2N days
//   P5-02  cover as a range; the warning against the delivery time (stated,
//          else ASSUMED); refusal under N days, saying when it's ready
//   P5-03  sales over the delivery time + safety margin, up to the MOQ,
//          with the arithmetic in words; cost in minor units with currency
//   P5-04  an approaching busy stretch raises the rate for its days, stated

import { describe, expect, it } from "vitest";
import { dayMonthYear } from "../i18n/format";
import type { SeasonResult } from "../seasons/forecast";
import { addDays, seasonForecast } from "../seasons/forecast";
import type { StockItem } from "./assess";
import { shiftDay } from "./assess";
import type { LeadTime, SupplierInfo } from "./cover";
import {
  COVER,
  assessCover,
  coverColumn,
  coverFlag,
  coverDays,
  demandBetween,
  leadTimeFor,
  rankWarnings,
  recentRate,
  reorderFor,
  seasonBoost,
  sellThrough,
  wholeDays,
} from "./cover";

const TODAY = "2026-10-27";
const YESTERDAY = shiftDay(TODAY, -1);

/** A store item selling `perDay(i)` units on the day i days before yesterday. */
function item(
  onHand: number,
  perDay: (daysBeforeYesterday: number) => number,
  over: Partial<StockItem> = {},
  covered = 120,
): StockItem {
  const daily = new Map<string, number>();
  for (let i = 0; i < covered; i++) {
    const u = perDay(i);
    if (u > 0) daily.set(shiftDay(YESTERDAY, -i), u);
  }
  return {
    provider: "shopify",
    connection_id: "c1",
    ref: "gid://shopify/Product/1",
    name: "Blue Mug",
    as_of: TODAY,
    on_hand: onHand,
    value_at_cost: onHand * 980,
    value_at_price: onHand * 3400,
    currency: "EUR",
    cost_basis: "measured",
    offer_id: "offer-mug",
    sales: { kind: "series", covered_days: covered, daily },
    ...over,
  };
}

const CLAY: SupplierInfo = {
  id: "s-clay",
  name: "Midland Clay",
  lead_time_days: 7,
  moq: null,
  offer_ids: ["offer-mug"],
};
const stated = (days: number, moq: number | null = null): LeadTime =>
  leadTimeFor({ offer_id: "offer-mug" }, [{ ...CLAY, lead_time_days: days, moq }]);

describe("P5-01 two-window sell-through", () => {
  it("compares the last 28 days with the 28 before, ending yesterday", () => {
    // 2 a day in window A, 1 a day in window B.
    const st = sellThrough(
      item(10, (i) => (i < 28 ? 2 : 1)),
      TODAY,
    );
    expect(st.status).toBe("ready");
    if (st.status !== "ready") return;
    expect(st.a).toEqual({ from: shiftDay(YESTERDAY, -27), to: YESTERDAY, units: 56 });
    expect(st.b).toEqual({
      from: shiftDay(YESTERDAY, -55),
      to: shiftDay(YESTERDAY, -28),
      units: 28,
    });
    expect(st.change).toBe(28);
    expect(st.change_pct).toBe(100);
    // Band: 2 × √(56 + 28) = 18.3 → 19. 28 is outside it.
    expect(st.band).toBe(19);
    expect(st.direction).toBe("up");
    expect(st.sentence).toContain("more than chance (±19)");
  });

  it("calls a change inside the noise band chance, not a trend", () => {
    // 30 against 25: a difference of 5 inside ±2√55 ≈ 15.
    const st = sellThrough(
      item(10, (i) => (i < 28 ? (i < 2 ? 2 : 1) : i < 53 ? 1 : 0)),
      TODAY,
    );
    expect(st.status).toBe("ready");
    if (st.status !== "ready") return;
    expect(st.a.units).toBe(30);
    expect(st.b.units).toBe(25);
    expect(st.direction).toBe("flat");
    expect(st.sentence).toContain("within chance");
  });

  it("says a fall is a fall when it is outside the band", () => {
    const st = sellThrough(
      item(10, (i) => (i < 28 ? 1 : 3)),
      TODAY,
    );
    expect(st.status === "ready" && st.direction).toBe("down");
  });

  it("refuses under two whole windows, saying how much there is and when it can", () => {
    const st = sellThrough(
      item(10, () => 1, {}, 40),
      TODAY,
    );
    expect(st.status).toBe("too_little");
    if (st.status !== "too_little") return;
    expect(st.covered_days).toBe(40);
    expect(st.needed_days).toBe(56);
    expect(st.ready_on).toBe(shiftDay(TODAY, 16));
    expect(st.sentence).toMatch(/Only 40 days.*I can say what sold; I can't say/);
  });

  it("a stock file has one window: it says so rather than guessing a second", () => {
    const st = sellThrough(
      item(10, () => 0, {
        sales: { kind: "file", window_days: 90, units_in_window: 30, days_since_sale: 2 },
      }),
      TODAY,
    );
    expect(st.status).toBe("too_little");
    expect(st.status === "too_little" && st.ready_on).toBeNull();
  });
});

describe("P5-02 the rate and days of cover, as ranges", () => {
  it("reads the rate over the last 28 days, ± one standard deviation", () => {
    const r = recentRate(
      item(10, () => 1),
      TODAY,
    );
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    expect(r.rate.units).toBe(28);
    expect(r.rate.per_day).toBe(1);
    expect(r.rate.low).toBeCloseTo((28 - Math.sqrt(28)) / 28);
    expect(r.rate.high).toBeCloseTo((28 + Math.sqrt(28)) / 28);
    expect(r.rate.low).toBeLessThan(r.rate.per_day);
    expect(r.rate.high).toBeGreaterThan(r.rate.per_day);
  });

  it("refuses under 28 measured days, with the day it will be ready", () => {
    const r = recentRate(
      item(10, () => 1, {}, 20),
      TODAY,
    );
    expect(r.status).toBe("too_little");
    if (r.status !== "too_little") return;
    expect(r.ready_on).toBe(shiftDay(TODAY, 8));
    expect(r.sentence).toContain("I can't say when it runs out until");
  });

  it("no sale in the window is not a rate", () => {
    expect(
      recentRate(
        item(10, (i) => (i > 40 ? 1 : 0)),
        TODAY,
      ).status,
    ).toBe("no_sales");
  });

  it("reads a stock file's window, and refuses a window shorter than 28 days", () => {
    const f = (window_days: number | null, units: number | null) =>
      item(10, () => 0, {
        provider: "stock_import",
        sales: { kind: "file", window_days, units_in_window: units, days_since_sale: null },
      });
    const ok = recentRate(f(90, 45), TODAY);
    expect(ok.status === "ready" && ok.rate.per_day).toBe(0.5);
    expect(recentRate(f(14, 10), TODAY).status).toBe("too_little");
    expect(recentRate(f(null, null), TODAY).status).toBe("too_little");
  });

  it("cover is on hand over the rate, low end from the fast end", () => {
    const c = assessCover(
      item(8, () => 1),
      TODAY,
      stated(7),
      null,
      "Shopify",
    );
    expect(c.status).toBe("ready");
    const low = 8 / ((28 + Math.sqrt(28)) / 28);
    const high = 8 / ((28 - Math.sqrt(28)) / 28);
    expect(c.cover!.low).toBeCloseTo(low);
    expect(c.cover!.mid).toBeCloseTo(8);
    expect(c.cover!.high).toBeCloseTo(high);
    expect(coverColumn(c)).toBe(`${Math.round(low)} to ${Math.round(high)}`);
    expect(c.runs_out!.earliest).toBe(shiftDay(TODAY, Math.floor(low)));
  });

  it("a count taken days ago has kept selling since", () => {
    const fresh = assessCover(
      item(20, () => 1),
      TODAY,
      stated(7),
      null,
      "Shopify",
    );
    const old = assessCover(
      item(20, () => 1, { as_of: shiftDay(TODAY, -5) }),
      TODAY,
      stated(7),
      null,
      "Shopify",
    );
    expect(fresh.cover!.mid - old.cover!.mid).toBeCloseTo(5);
    expect(old.assumed.join(" ")).toContain("kept selling at that pace since the stock was read");
  });

  it("warns when cover's low end falls below the supplier's delivery time", () => {
    // 8 on hand at 1 a day: about 7–10 days; the supplier takes 7.
    const c = assessCover(
      item(8, () => 1),
      TODAY,
      stated(7),
      null,
      "Shopify",
    );
    expect(c.warning?.level).toBe("tight");
    expect(c.warning?.flag).toBe("RUNNING LOW");
    expect(c.warning?.sentence).toBe(
      "Blue Mug runs out in about 7 to 10 days; Midland Clay takes 7 days.",
    );
    expect(c.reorder).not.toBeNull();
  });

  it("does not warn when even the fast end outlasts the delivery time", () => {
    const c = assessCover(
      item(30, () => 1),
      TODAY,
      stated(7),
      null,
      "Shopify",
    );
    expect(c.warning).toBeNull();
    expect(c.reorder).toBeNull();
  });

  it("is ACT NOW when even the slow end runs out before a delivery would arrive", () => {
    const c = assessCover(
      item(3, () => 1),
      TODAY,
      stated(7),
      null,
      "Shopify",
    );
    expect(c.warning?.level).toBe("before_restock");
    expect(c.warning?.flag).toBe("ACT NOW");
  });

  it("a sold-out item is SOLD OUT in the column, never a warning or a reorder", () => {
    const out = assessCover(
      item(0, () => 1),
      TODAY,
      stated(7),
      null,
      "Shopify",
    );
    expect(out.sold_out).toBe(true);
    expect(coverColumn(out)).toBe("sold out");
    expect(out.warning).toBeNull();
    expect(out.reorder).toBeNull();
    // One left is not sold out: it warns.
    const last = assessCover(
      item(1, () => 1),
      TODAY,
      stated(7),
      null,
      "Shopify",
    );
    expect(last.sold_out).toBe(false);
    expect(last.warning?.flag).toBe("ACT NOW");
  });

  it("states its window, its sources and what is assumed", () => {
    const c = assessCover(
      item(8, () => 1),
      TODAY,
      stated(7),
      null,
      "Shopify",
    );
    expect(c.sources).toContain(
      `28 sold ${dayMonthYear(shiftDay(YESTERDAY, -27), "en")} to ${dayMonthYear(YESTERDAY, "en")}, measured by Shopify`,
    );
    expect(c.sources).toContain("Midland Clay takes 7 days, from your answer");
    expect(c.assumed[0]).toContain("the pace of the last 28 days");
  });

  it("too little history: no cover, no warning, and the reason", () => {
    const c = assessCover(
      item(2, () => 1, {}, 10),
      TODAY,
      stated(7),
      null,
      "Shopify",
    );
    expect(c.status).toBe("too_little");
    expect(c.cover).toBeNull();
    expect(c.warning).toBeNull();
    expect(c.why).toContain("Only 10 days");
    expect(coverColumn(c)).toBe("-");
  });
});

describe("P5-02 the delivery time: stated from 1.4.1.3, else ASSUMED", () => {
  const packaging: SupplierInfo = {
    id: "s-box",
    name: "Nore Packaging",
    lead_time_days: 4,
    moq: 500,
    offer_ids: ["offer-mug"],
  };

  it("takes the longest stated time among the item's suppliers, with its fact", () => {
    const lead = leadTimeFor({ offer_id: "offer-mug" }, [packaging, { ...CLAY, moq: 250 }]);
    expect(lead.basis).toBe("stated");
    expect(lead.days).toBe(7);
    expect(lead.supplier?.name).toBe("Midland Clay");
    expect(lead.source_field).toBe("suppliers.s-clay.lead_time_days");
    expect(lead.moq).toBe(250);
    expect(lead.why).toContain("the longest of the 2 suppliers");
  });

  it("falls back to the stated default, marked ASSUMED, saying why", () => {
    const unmatched = leadTimeFor({ offer_id: null }, [CLAY]);
    expect(unmatched.basis).toBe("assumed");
    expect(unmatched.days).toBe(COVER.default_lead_days);
    expect(unmatched.source_field).toBeNull();
    expect(unmatched.why).toMatch(/^14 days, ASSUMED: this item isn't matched/);
    const noTime = leadTimeFor({ offer_id: "offer-mug" }, [{ ...CLAY, lead_time_days: null }]);
    expect(noTime.basis).toBe("assumed");
    expect(noTime.why).toContain("no delivery time on file for Midland Clay");
    const other = leadTimeFor({ offer_id: "offer-vase" }, [CLAY]);
    expect(other.why).toContain("no supplier on file for this item");
  });

  it("the assumed default is named in the warning and the assumptions", () => {
    const lead = leadTimeFor({ offer_id: null }, []);
    const c = assessCover(
      item(10, () => 1),
      TODAY,
      lead,
      null,
      "Shopify",
    );
    expect(c.warning?.sentence).toContain("a delivery takes 14 days (ASSUMED)");
    expect(c.assumed.some((a) => a.startsWith("ASSUMED delivery time"))).toBe(true);
  });
});

describe("P5-03 the reorder quantity", () => {
  const rateOf = (it: StockItem) => {
    const r = recentRate(it, TODAY);
    if (r.status !== "ready") throw new Error("no rate");
    return r.rate;
  };

  it("is sales over the delivery time plus the fast end's margin, with its arithmetic", () => {
    const it = item(8, () => 1);
    const r = reorderFor(it, rateOf(it), stated(7), null);
    // 1.0 a day × 7 = 7; the fast end (1.19 a day) × 7 = 8.3 → 9: a margin of 2.
    expect(r.lead_demand.mid).toBeCloseTo(7);
    expect(r.before_moq).toBe(9);
    expect(r.safety).toBe(2);
    expect(r.quantity).toBe(9);
    expect(r.rounded_to_moq).toBe(false);
    expect(r.arithmetic).toBe(
      "1.0 a day (up to 1.2) over 7 days = 7, + 2 safety margin (the fast end of the range) = 9; no minimum order on file.",
    );
  });

  it("rounds up to the supplier's minimum order quantity, and says so", () => {
    const it = item(8, () => 1);
    const r = reorderFor(it, rateOf(it), stated(7, 250), null);
    expect(r.quantity).toBe(250);
    expect(r.rounded_to_moq).toBe(true);
    expect(r.arithmetic).toContain("Midland Clay's minimum order is 250, so 250");
    // Over the minimum, the quantity stands.
    const busy = item(8, () => 10);
    const over = reorderFor(busy, rateOf(busy), stated(7, 50), null);
    expect(over.quantity).toBe(over.before_moq);
    expect(over.quantity).toBeGreaterThan(50);
    expect(over.arithmetic).toContain("over Midland Clay's minimum order of 50");
  });

  it("prices the reorder at the item's own unit cost, in minor units and its currency", () => {
    const it = item(8, () => 1);
    const r = reorderFor(it, rateOf(it), stated(7), null);
    expect(r.cost).toEqual({ amount_minor: 9 * 980, currency: "EUR" });
    expect(r.cost_basis).toBe("measured");
    expect(r.cost_arithmetic).toContain("9 × €9.80 at cost");
    // Sold out, or no cost on the read: no unit cost, no guess.
    const out = item(0, () => 1);
    expect(reorderFor(out, rateOf(out), stated(7), null).cost).toBeNull();
    const noCost = item(8, () => 1, { value_at_cost: null });
    expect(reorderFor(noCost, rateOf(noCost), stated(7), null).cost).toBeNull();
  });
});

describe("piecewise demand and cover", () => {
  const boost = { from_day: 5, to_day: 15 };
  it("raises the rate only inside the stretch", () => {
    expect(demandBetween(0, 10, { per_day: 2, boost: null, multiple: 1 })).toBe(20);
    // 5 days at 2, 5 days at 3.
    expect(demandBetween(0, 10, { per_day: 2, boost, multiple: 1.5 })).toBe(25);
    expect(demandBetween(20, 30, { per_day: 2, boost, multiple: 1.5 })).toBe(20);
  });
  it("cover walks the segments", () => {
    expect(coverDays(10, { per_day: 2, boost: null, multiple: 1 })).toBe(5);
    // 10 in the first 5 days, then 6 more at 3 a day: 2 days.
    expect(coverDays(16, { per_day: 2, boost, multiple: 1.5 })).toBe(7);
    expect(coverDays(10, { per_day: 0, boost: null, multiple: 1 })).toBeNull();
    expect(coverDays(1e9, { per_day: 1, boost: null, multiple: 1 })).toBe(COVER.max_cover_days);
  });
});

/** A ready season result whose busy stretch starts `inDays` from TODAY. */
function season(inDays: number, index: number, recentIndex: number | null): SeasonResult {
  const starts = shiftDay(TODAY, inDays);
  const weeks =
    recentIndex === null
      ? []
      : [3, 2, 1, 0].map((k) => ({
          start: shiftDay(TODAY, -7 * (k + 1)),
          value: 100,
          index: recentIndex,
          low: recentIndex,
          high: recentIndex,
          flag: null,
        }));
  return {
    status: "ready",
    series: { noun: "revenue", source: "Shopify", currency: "EUR" },
    today: TODAY,
    first_day: "2025-10-01",
    last_day: YESTERDAY,
    covered_days: 391,
    years: 1,
    normal: { median: 100, p25: 90, p75: 110, weeks: 52, from: "2025-10-27", to: YESTERDAY },
    weeks,
    months: [],
    runs: [],
    ahead: [],
    upcoming: [
      {
        run: {
          kind: "busy",
          start: addDays(starts, -364),
          end: addDays(starts, -364 + 27),
          weeks: 4,
          total: 400 * index,
          index,
          low: index - 0.2,
          high: index + 0.2,
        },
        starts_in_weeks: Math.round(inDays / 7),
        starts_on: starts,
        ends_on: shiftDay(starts, 27),
        in_progress: inDays <= 0,
        sentence: "",
      },
    ],
    headline: "",
    notes: [],
  };
}

describe("P5-04 the busy season raises cover targets", () => {
  it("counts an approaching stretch against the recent weeks, and says so", () => {
    const b = seasonBoost(season(3, 1.7, 1.0), TODAY)!;
    expect(b.from_day).toBe(3);
    expect(b.to_day).toBe(31);
    expect(b.multiple.mid).toBeCloseTo(1.7);
    expect(b.sentence).toContain("last year it ran 1.7× your normal week");
    expect(b.sentence).toContain("so I count 1.7× your recent pace for those days");
  });

  it("does not count twice what the recent weeks already ran", () => {
    expect(seasonBoost(season(3, 1.7, 1.25), TODAY)!.multiple.mid).toBeCloseTo(1.36);
    const already = seasonBoost(season(0, 1.7, 1.8), TODAY)!;
    expect(already.multiple.mid).toBe(1);
    expect(already.sentence).toContain("already holds it");
  });

  it("brings the warning forward, and the warning says why", () => {
    // 12 on hand at 1 a day: 10–15 days, clear of a 7-day delivery. A 2×
    // stretch from day 2 runs it out in about 6–8 days.
    const it = item(12, () => 1);
    const plain = assessCover(it, TODAY, stated(7), null, "Shopify");
    expect(plain.warning).toBeNull();
    const boost = seasonBoost(season(2, 2.0, 1.0), TODAY);
    const busy = assessCover(it, TODAY, stated(7), boost, "Shopify");
    expect(busy.boosted).toBe(true);
    expect(busy.cover!.low).toBeLessThan(plain.cover!.low);
    expect(busy.warning).not.toBeNull();
    expect(busy.warning!.sentence).toContain("That counts your busy stretch from");
    expect(busy.assumed.join(" ")).toContain("follows your business's own season");
    expect(busy.sources).toContain("the season from your revenue from Shopify");
    // The reorder covers the stretch's days inside the delivery time.
    const r = busy.reorder!;
    expect(r.lead_demand.mid).toBeCloseTo(2 + 5 * 2);
    expect(r.arithmetic).toContain("with the busy stretch at 2.0×");
  });

  it("a stretch past the cover changes nothing and isn't claimed", () => {
    const it = item(8, () => 1);
    const c = assessCover(it, TODAY, stated(7), seasonBoost(season(40, 2.0, 1.0), TODAY), "S");
    expect(c.boosted).toBe(false);
    expect(c.warning!.sentence).not.toContain("busy stretch");
  });

  it("no forecast, or a forecast with too little history, raises nothing", () => {
    expect(seasonBoost(null, TODAY)).toBeNull();
    expect(seasonBoost({ status: "no_data" }, TODAY)).toBeNull();
    // A real forecast over 120 days of history refuses, and so does the boost.
    const s = new Map<string, number>();
    for (let d = shiftDay(TODAY, -120); d < TODAY; d = addDays(d, 1)) s.set(d, 1000);
    const short = seasonForecast(s, { noun: "revenue", source: "Shopify", currency: "EUR" }, TODAY);
    expect(short.status).toBe("too_little");
    expect(seasonBoost(short, TODAY)).toBeNull();
  });
});

describe("warnings, ranked", () => {
  it("ACT NOW first, then the soonest out; sold out and clear items are not warnings", () => {
    const lead = stated(7);
    const rows = [
      {
        name: "Plate",
        cover: assessCover(
          item(6, () => 1),
          TODAY,
          lead,
          null,
          "S",
        ),
      },
      {
        name: "Vase",
        cover: assessCover(
          item(40, () => 1),
          TODAY,
          lead,
          null,
          "S",
        ),
      },
      {
        name: "Seconds",
        cover: assessCover(
          item(0, () => 1),
          TODAY,
          lead,
          null,
          "S",
        ),
      },
      {
        name: "Mug",
        cover: assessCover(
          item(2, () => 1),
          TODAY,
          lead,
          null,
          "S",
        ),
      },
    ];
    expect(rankWarnings(rows).map((r) => r.name)).toEqual(["Mug", "Plate"]);
  });
});

describe("rule 25: a range, never a point", () => {
  it("widens to floor and ceiling when rounding would meet", () => {
    expect(wholeDays({ low: 6.7, high: 9.9 })).toEqual([7, 10]);
    expect(wholeDays({ low: 3.6, high: 4.47 })).toEqual([3, 5]);
    expect(wholeDays({ low: 4, high: 4 })).toEqual([4, 5]);
  });
});

describe("P5-04 from the season forecast itself", () => {
  it("a year with a 1.7× November raises the rate from the stretch's first day", () => {
    // Revenue a day: 1000, and 1700 for the four weeks from Monday 3 Nov 2025.
    const s = new Map<string, number>();
    for (let d = "2025-09-01"; d < TODAY; d = addDays(d, 1)) {
      s.set(d, d >= "2025-11-03" && d <= "2025-11-30" ? 1700 : 1000);
    }
    const result = seasonForecast(
      s,
      { noun: "revenue", source: "Shopify", currency: "EUR" },
      TODAY,
    );
    expect(result.status).toBe("ready");
    const b = seasonBoost(result, TODAY)!;
    expect(b).not.toBeNull();
    expect(b.starts_on).toBe("2026-11-02");
    expect(b.from_day).toBe(6);
    expect(b.multiple.mid).toBeCloseTo(1.7, 1);
    expect(b.sentence).toContain("starts in 6 days");
    // 20 on hand at 1 a day: 20 days plain; with the stretch from day 6, about 14.
    const c = assessCover(
      item(20, () => 1),
      TODAY,
      stated(7),
      b,
      "Shopify",
    );
    expect(c.boosted).toBe(true);
    expect(c.cover!.mid).toBeCloseTo(6 + 14 / 1.7, 0);
  });
});

describe("the cover column's flag", () => {
  it("says each state in a word", () => {
    const lead = stated(7);
    const flag = (it: StockItem) => coverFlag(assessCover(it, TODAY, lead, null, "S"));
    expect(flag(item(2, () => 1))).toBe("ACT NOW");
    expect(flag(item(8, () => 1))).toBe("RUNNING LOW");
    expect(flag(item(30, () => 1))).toBe("IN RANGE");
    expect(flag(item(0, () => 1))).toBe("SOLD OUT");
    expect(flag(item(5, () => 0))).toBe("NO SALES");
    expect(flag(item(5, () => 1, {}, 10))).toBe("TOO EARLY");
  });
});
