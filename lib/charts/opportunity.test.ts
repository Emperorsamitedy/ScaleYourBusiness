import { describe, expect, it } from "vitest";
import { shiftDay } from "../anomaly/baseline";
import type {
  BookingDay,
  BookingsInput,
  CampaignInput,
  OpportunityComponent,
  PricedComponent,
} from "./opportunity";
import {
  OPPORTUNITY,
  aboutRange,
  bookingPriceRange,
  emptyCapacity,
  headline,
  lateCancellations,
  losingAds,
  noShows,
  onTheTable,
  perMonth,
  rangeText,
  revenueDips,
  slowStock,
  windowEnding,
} from "./opportunity";

const isPriced = (c: OpportunityComponent): c is PricedComponent => c.status === "priced";
function priced(c: OpportunityComponent): PricedComponent {
  if (!isPriced(c)) throw new Error(`expected priced, got absent: ${c.reason}`);
  return c;
}

/** Two whole weeks, Mon 2026-10-05 .. Sun 2026-10-18. */
const MON = "2026-10-05";
const W = { from: MON, to: shiftDay(MON, 13) };

function bookings(
  perDay: (i: number) => Partial<BookingDay>,
  over: Partial<BookingsInput> = {},
): BookingsInput {
  return {
    source: "your bookings export",
    series: "connector:bookings_import",
    currency: "EUR",
    late_separated: true,
    days: Array.from({ length: 14 }, (_, i) => ({
      date: shiftDay(MON, i),
      completed: 10,
      no_show: 0,
      late: 0,
      revenue_minor: 10 * 4000,
      ...perDay(i),
    })),
    ...over,
  };
}

describe("the measured average booking price", () => {
  it("is a range from the lowest to the highest weekly average, never narrower than the mean", () => {
    // Week 1 at €40 an appointment, week 2 at €50.
    const b = bookings((i) => ({ revenue_minor: 10 * (i < 7 ? 4000 : 5000) }));
    const p = bookingPriceRange(b, W);
    expect(p).toMatchObject({ status: "ok", low_minor: 4000, high_minor: 5000, mean_minor: 4500 });
  });

  it("a week below the completed floor doesn't widen the range (boundary: 4 vs 5)", () => {
    const floor = OPPORTUNITY.min_week_completed;
    // Week 2 has only floor − 1 completed appointments, at a much higher price.
    const thin = bookings((i) =>
      i < 7
        ? {}
        : i === 7
          ? { completed: floor - 1, revenue_minor: (floor - 1) * 9000 }
          : { completed: 0, revenue_minor: 0 },
    );
    const p = bookingPriceRange(thin, W);
    expect(p.status).toBe("ok");
    if (p.status !== "ok") return;
    expect(p.weeks).toBe(1);
    // The mean still counts every appointment, so the range reaches it.
    expect(p.high_minor).toBe(p.mean_minor);
    const enough = bookings((i) =>
      i < 7
        ? {}
        : i === 7
          ? { completed: floor, revenue_minor: floor * 9000 }
          : { completed: 0, revenue_minor: 0 },
    );
    const q = bookingPriceRange(enough, W);
    expect(q.status === "ok" && q.weeks).toBe(2);
    expect(q.status === "ok" && q.high_minor).toBe(9000);
  });

  it("is absent without prices, or without a completed appointment", () => {
    expect(
      bookingPriceRange(
        bookings(() => ({}), { currency: null }),
        W,
      ),
    ).toMatchObject({
      status: "absent",
    });
    expect(
      bookingPriceRange(
        bookings(() => ({ completed: 0, revenue_minor: 0 })),
        W,
      ).status,
    ).toBe("absent");
  });
});

describe("no-shows and late cancellations × the measured price", () => {
  const b = bookings((i) => ({ no_show: i === 2 ? 2 : i === 9 ? 1 : 0, late: i === 4 ? 1 : 0 }));

  it("prices each no-show at the price range, by day", () => {
    const c = priced(noShows(b, W));
    expect(c.basis).toBe("DERIVED");
    expect(c.total).toEqual({ low_minor: 3 * 4000, high_minor: 3 * 4000, currency: "EUR" });
    expect(c.daily).toEqual([
      { date: shiftDay(MON, 2), low_minor: 8000, high_minor: 8000 },
      { date: shiftDay(MON, 9), low_minor: 4000, high_minor: 4000 },
    ]);
    expect(c.formula).toContain("3 no-shows in 14 measured days");
    expect(c.derived_from).toContain("connector:bookings_import:appointments_no_show.daily");
    // A month is 30 days over the 14 measured.
    expect(c.monthly?.low_minor).toBe(perMonth(12000, 14));
  });

  it("zero no-shows is a priced zero, a finding, not an absence", () => {
    const c = priced(
      noShows(
        bookings(() => ({})),
        W,
      ),
    );
    expect(c.total.high_minor).toBe(0);
    expect(c.daily).toEqual([]);
  });

  it("is absent without bookings, saying what would fill it", () => {
    const c = noShows(null, W);
    expect(c.status).toBe("absent");
    expect(c.status === "absent" && c.reason).toMatch(/import your bookings/);
  });

  it("late cancellations price the same way, or say the source doesn't separate them", () => {
    expect(priced(lateCancellations(b, W)).total.high_minor).toBe(4000);
    const square = lateCancellations({ ...b, late_separated: false, source: "Square" }, W);
    expect(square.status).toBe("absent");
    expect(square.status === "absent" && square.reason).toMatch(/Square doesn't separate/);
  });
});

describe("empty capacity — only on a capacity the owner gave", () => {
  const stated = { per_week: 70, basis: "STATED" as const };

  it("is absent with no stated capacity, and says it won't assume one", () => {
    const c = emptyCapacity(
      bookings(() => ({})),
      null,
      W,
    );
    expect(c.status === "absent" && c.reason).toMatch(/won't assume a capacity/);
    expect(
      emptyCapacity(
        bookings(() => ({})),
        { per_week: 0, basis: "STATED" },
        W,
      ).status,
    ).toBe("absent");
  });

  it("a full book is zero; one slot short is one slot × the price (the boundary)", () => {
    expect(
      priced(
        emptyCapacity(
          bookings(() => ({})),
          stated,
          W,
        ),
      ).total.high_minor,
    ).toBe(0);
    const short = bookings((i) => (i === 3 ? { completed: 9, revenue_minor: 9 * 4000 } : {}));
    const c = priced(emptyCapacity(short, stated, W));
    expect(c.total).toEqual({ low_minor: 4000, high_minor: 4000, currency: "EUR" });
    expect(c.basis).toBe("DERIVED");
    expect(c.basis_note).toMatch(/STATED/);
  });

  it("doesn't count a no-show slot as empty: those are priced on their own line", () => {
    const b = bookings((i) =>
      i === 3 ? { completed: 9, no_show: 1, revenue_minor: 9 * 4000 } : {},
    );
    expect(priced(emptyCapacity(b, stated, W)).total.high_minor).toBe(0);
  });

  it("never goes negative when the week is over-booked", () => {
    const busy = bookings(() => ({ completed: 12, revenue_minor: 12 * 4000 }));
    expect(priced(emptyCapacity(busy, stated, W)).total.low_minor).toBe(0);
  });

  it("pro-rates a part week by its measured days, and spreads a week evenly", () => {
    // One measured Monday at 7 a week: one slot; 0 completed → 1 empty.
    const one: BookingsInput = {
      ...bookings(() => ({})),
      days: [{ date: MON, completed: 0, no_show: 0, late: 0, revenue_minor: 0 }],
    };
    // No price in the window, so it says so rather than inventing one.
    expect(emptyCapacity(one, { per_week: 7, basis: "STATED" }, W).status).toBe("absent");
    const b = bookings((i) => (i < 7 ? { completed: 8, revenue_minor: 8 * 4000 } : {}));
    const c = priced(emptyCapacity(b, stated, W));
    // Week 1: 70 − 56 = 14 empty × €40 = €560, spread over 7 days at €80.
    expect(c.total.high_minor).toBe(14 * 4000);
    expect(c.daily.filter((d) => d.date < shiftDay(MON, 7)).map((d) => d.high_minor)).toEqual(
      Array(7).fill(8000),
    );
  });

  it("puts a week's empty slots on its open days, not the days it was shut", () => {
    // Closed Mondays (index 0 and 7): nothing held.
    const b = bookings((i) =>
      i % 7 === 0 ? { completed: 0, revenue_minor: 0 } : { completed: 9, revenue_minor: 9 * 4000 },
    );
    const c = priced(emptyCapacity(b, stated, W));
    // 70 − 54 = 16 empty × €40 = €640 a week, over 6 open days.
    expect(c.total.high_minor).toBe(2 * 16 * 4000);
    expect(c.daily.some((d) => d.date === MON)).toBe(false);
    const week1 = c.daily.filter((d) => d.date < shiftDay(MON, 7));
    expect(week1).toHaveLength(6);
    expect(week1.reduce((n, d) => n + d.high_minor, 0)).toBe(16 * 4000);
  });

  it("names an estimated capacity as estimated", () => {
    const b = bookings((i) => (i === 3 ? { completed: 9, revenue_minor: 9 * 4000 } : {}));
    expect(priced(emptyCapacity(b, { per_week: 70, basis: "ESTIMATED" }, W)).basis_note).toMatch(
      /ESTIMATED/,
    );
  });
});

describe("revenue dips — the detector's own baseline", () => {
  const START = "2026-01-01";
  const day = (i: number) => shiftDay(START, i);
  /** 40 days at €100; days 38 and 39 at €40 unless overridden. */
  function series(over: Record<number, number> = { 38: 4000, 39: 4000 }) {
    const m = new Map<string, number>();
    for (let i = 0; i < 40; i++) m.set(day(i), over[i] ?? 10000);
    return {
      series: m,
      currency: "EUR",
      series_id: "connector:shopify:revenue.daily",
      noun: "revenue",
    };
  }
  const w = { from: day(30), to: day(39) };

  it("prices a two-day run: high = expected − actual, low leaves one usual variation", () => {
    // By hand: both days expect €100 with a usual variation of €5 (the 5% floor).
    const c = priced(revenueDips(series(), w));
    expect(c.total).toEqual({ low_minor: 2 * 5500, high_minor: 2 * 6000, currency: "EUR" });
    expect(c.daily.map((d) => d.date)).toEqual([day(38), day(39)]);
    expect(c.formula).toMatch(/2 days in 1 run of 2\+/);
  });

  it("one odd day is noise, not a dip (the run boundary)", () => {
    const c = priced(revenueDips(series({ 38: 4000 }), w));
    expect(c.total.high_minor).toBe(0);
  });

  it("a spike is never a loss", () => {
    expect(priced(revenueDips(series({ 38: 30000, 39: 30000 }), w)).total.high_minor).toBe(0);
  });

  it("takes off what the day's other components already price, so nothing counts twice", () => {
    const explained = new Map([[day(38), { low_minor: 1000, high_minor: 2000 }]]);
    const c = priced(revenueDips(series(), w, explained));
    expect(c.daily[0]).toEqual({ date: day(38), low_minor: 5500 - 2000, high_minor: 6000 - 1000 });
    const all = new Map([[day(38), { low_minor: 99999, high_minor: 99999 }]]);
    expect(priced(revenueDips(series(), w, all)).daily.map((d) => d.date)).toEqual([day(39)]);
  });

  it("is absent with too little history, or no series at all", () => {
    const short = new Map([[day(0), 1000]]);
    expect(
      revenueDips({ series: short, currency: "EUR", series_id: "x", noun: "revenue" }, w).status,
    ).toBe("absent");
    expect(revenueDips(null, w).status).toBe("absent");
  });
});

describe("ads that lose money — Meta's attribution", () => {
  const camp = (ref: string, spend: number, value: number, currency = "EUR"): CampaignInput => ({
    campaign_ref: ref,
    campaign_name: `Campaign ${ref}`,
    currency,
    days: [{ date: W.to, spend_minor: spend, value_minor: value }],
  });

  it("a return of exactly 1.0 is not losing; just below is (strict, the pause line)", () => {
    expect(priced(losingAds([camp("a", 10000, 10000)], W, "EUR")).total.high_minor).toBe(0);
    const c = priced(losingAds([camp("a", 10000, 9900)], W, "EUR"));
    expect(c.total).toEqual({ low_minor: 100, high_minor: 100, currency: "EUR" });
    expect(c.basis_note).toMatch(/Meta's own attribution/);
  });

  it("never adds a campaign in another currency", () => {
    const c = priced(losingAds([camp("a", 10000, 5000), camp("b", 9000, 1000, "USD")], W, "EUR"));
    expect(c.total.high_minor).toBe(5000);
    expect(c.note).toMatch(/USD left out/);
  });

  it("is absent without Meta, or with nothing spent in the window", () => {
    expect(losingAds(null, W, "EUR").status).toBe("absent");
    expect(losingAds([], W, "EUR").status).toBe("absent");
  });
});

describe("slow stock — a balance, never a month", () => {
  it("is a stock with no monthly figure", () => {
    const c = priced(
      slowStock(
        [
          { name: "Vase", cash_tied_minor: 50000, currency: "EUR", cost_basis: "measured" },
          { name: "Bowl", cash_tied_minor: null, currency: "EUR", cost_basis: null },
          { name: "Jug", cash_tied_minor: 9000, currency: "GBP", cost_basis: "measured" },
        ],
        "EUR",
        "2026-10-20",
      ),
    );
    expect(c.kind).toBe("stock");
    expect(c.monthly).toBeNull();
    expect(c.total.high_minor).toBe(50000);
    expect(c.basis).toBe("OBSERVED");
    expect(c.note).toMatch(/no known cost/);
    expect(c.note).toMatch(/another currency/);
  });

  it("is DERIVED when a cost the owner gave stands in", () => {
    const c = priced(
      slowStock(
        [{ name: "Vase", cash_tied_minor: 100, currency: "EUR", cost_basis: "stated" }],
        "EUR",
        null,
      ),
    );
    expect(c.basis).toBe("DERIVED");
  });

  it("is absent with no stock source", () => {
    expect(slowStock(null, "EUR", null).status).toBe("absent");
  });
});

describe("on the table — the waiting proposals' own cases", () => {
  const p = (base: number | null, upside: number | null, currency = "EUR") => ({
    id: `p${base}`,
    summary: "Raise a price",
    base: base === null ? null : { amount_minor: base, currency },
    upside: upside === null ? null : { amount_minor: upside, currency },
  });

  it("sums base case to upside, ESTIMATED, as a forecast", () => {
    const c = priced(onTheTable([p(86588, 121584), p(10000, 20000)], "EUR", "2026-10-25"));
    expect(c.basis).toBe("ESTIMATED");
    expect(c.kind).toBe("forecast");
    expect(c.total).toEqual({ low_minor: 96588, high_minor: 141584, currency: "EUR" });
  });

  it("a negative base case counts as nothing at the low end, never a negative gain", () => {
    expect(priced(onTheTable([p(-5000, 3000)], "EUR", "2026-10-25")).total).toEqual({
      low_minor: 0,
      high_minor: 3000,
      currency: "EUR",
    });
  });

  it("leaves out unpriced and other-currency proposals, and is absent when nothing is left", () => {
    expect(onTheTable([p(null, null), p(100, 200, "USD")], "EUR", "2026-10-25").status).toBe(
      "absent",
    );
    expect(onTheTable([], "EUR", "2026-10-25").status).toBe("absent");
  });
});

describe("the headline", () => {
  const flow = (
    key: "no_shows" | "revenue_dips" | "losing_ads",
    lo: number,
    hi: number,
    currency = "EUR",
  ) =>
    ({
      key,
      label: key,
      kind: "flow",
      status: "priced",
      basis: "DERIVED",
      basis_note: null,
      window: { from: W.from, to: W.to, days: 30 },
      total: { low_minor: lo, high_minor: hi, currency },
      monthly: { low_minor: lo, high_minor: hi, currency },
      derived_from: [],
      formula: "",
      daily: [],
      note: null,
    }) satisfies PricedComponent;

  it("adds the monthly flows and names the largest", () => {
    const h = headline(
      [flow("no_shows", 90000, 140000), flow("revenue_dips", 28000, 55000)],
      "EUR",
    );
    expect(h.monthly).toEqual({ low_minor: 118000, high_minor: 195000, currency: "EUR" });
    expect(h.text).toBe("About €1,180–€1,950 a month is slipping away — mostly no-shows.");
    expect(h.lead).toBe("no_shows");
  });

  it("never adds a stock, a forecast or another currency", () => {
    const stock = priced(
      slowStock(
        [{ name: "x", cash_tied_minor: 999999, currency: "EUR", cost_basis: "measured" }],
        "EUR",
        null,
      ),
    );
    const table = priced(
      onTheTable(
        [
          {
            id: "a",
            summary: "s",
            base: { amount_minor: 5000, currency: "EUR" },
            upside: { amount_minor: 9000, currency: "EUR" },
          },
        ],
        "EUR",
        W.to,
      ),
    );
    const h = headline(
      [flow("no_shows", 1000, 2000), stock, table, flow("losing_ads", 7000, 7000, "USD")],
      "EUR",
    );
    expect(h.monthly).toEqual({ low_minor: 1000, high_minor: 2000, currency: "EUR" });
  });

  it("says so when nothing is priced, or nothing slipped", () => {
    expect(headline([noShows(null, W)], "EUR")).toMatchObject({ monthly: null, lead: null });
    expect(headline([flow("no_shows", 0, 0)], "EUR").text).toBe(
      "Nothing measured is slipping away right now.",
    );
  });

  it("'about' rounds out to tens, keeps a point a point, and stays ordered", () => {
    expect(aboutRange({ low_minor: 118049, high_minor: 194951, currency: "EUR" })).toEqual({
      low_minor: 118000,
      high_minor: 195000,
      currency: "EUR",
    });
    expect(aboutRange({ low_minor: 46969, high_minor: 46969, currency: "EUR" })).toEqual({
      low_minor: 47000,
      high_minor: 47000,
      currency: "EUR",
    });
    // JPY has no minor unit: tens of yen, by the currency's own exponent.
    expect(aboutRange({ low_minor: 12345, high_minor: 12399, currency: "JPY" })).toEqual({
      low_minor: 12340,
      high_minor: 12400,
      currency: "JPY",
    });
    expect(rangeText({ low_minor: 4000, high_minor: 4000, currency: "EUR" })).toBe("€40");
  });
});

describe("money stays integer minor units, ranges ordered, across every component", () => {
  it("holds for a mixed business", () => {
    const b = bookings((i) => ({
      no_show: i % 3 === 0 ? 1 : 0,
      late: i % 5 === 0 ? 1 : 0,
      completed: 7 + (i % 3),
      revenue_minor: (7 + (i % 3)) * (3999 + i * 7),
    }));
    const all = [
      noShows(b, W),
      lateCancellations(b, W),
      emptyCapacity(b, { per_week: 63, basis: "STATED" }, W),
      onTheTable(
        [
          {
            id: "a",
            summary: "s",
            base: { amount_minor: 333, currency: "EUR" },
            upside: { amount_minor: 777, currency: "EUR" },
          },
        ],
        "EUR",
        W.to,
      ),
    ].filter(isPriced);
    expect(all).toHaveLength(4);
    for (const c of all) {
      for (const v of [
        c.total.low_minor,
        c.total.high_minor,
        c.monthly?.low_minor ?? 0,
        c.monthly?.high_minor ?? 0,
      ]) {
        expect(Number.isSafeInteger(v)).toBe(true);
      }
      expect(c.total.low_minor).toBeLessThanOrEqual(c.total.high_minor);
      for (const d of c.daily) {
        expect(Number.isSafeInteger(d.low_minor) && Number.isSafeInteger(d.high_minor)).toBe(true);
        expect(d.low_minor).toBeLessThanOrEqual(d.high_minor);
      }
      expect(c.formula.length).toBeGreaterThan(0);
      expect(c.derived_from.length).toBeGreaterThan(0);
    }
  });

  it("the window ends on the latest measured day and is 90 days long", () => {
    const w = windowEnding("2026-10-24");
    expect(w).toEqual({ from: "2026-07-27", to: "2026-10-24" });
  });
});
