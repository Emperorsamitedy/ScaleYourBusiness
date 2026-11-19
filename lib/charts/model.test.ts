import { describe, expect, it } from "vitest";
import { shiftDay } from "../anomaly/baseline";
import { bucketCandles } from "./candles";
import type { DrawnModel, MarketInputs } from "./model";
import {
  MIN_DRAWN_DAYS,
  buildMarketModel,
  chartSummary,
  chartTable,
  chartTitle,
  groupEvents,
} from "./model";
import type { BookingsInput } from "./opportunity";
import { CHART_ARCHETYPES } from "./profiles";

const TODAY = "2026-10-25";
const LAST = shiftDay(TODAY, -1);

/** A salon's last `n` days: 10 completed a day at €40, a no-show every fourth day. */
function salon(n = 120): { values: Map<string, number>; bookings: BookingsInput } {
  const values = new Map<string, number>();
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = shiftDay(LAST, -i);
    const noShow = i % 4 === 0 ? 1 : 0;
    values.set(date, 10 * 4000);
    days.push({ date, completed: 10, no_show: noShow, late: 0, revenue_minor: 10 * 4000 });
  }
  return {
    values,
    bookings: {
      source: "your bookings export",
      series: "connector:bookings_import",
      currency: "EUR",
      late_separated: true,
      days,
    },
  };
}

function inputs(over: Partial<MarketInputs> = {}): MarketInputs {
  const s = salon();
  return {
    today: TODAY,
    noun: "your salon",
    archetype: "appointments",
    price: {
      candidate: CHART_ARCHETYPES.appointments.price[0]!,
      source: "your bookings export",
      series_id: "connector:bookings_import:booking_revenue.daily",
      currency: "EUR",
      values: s.values,
    },
    volume: {
      candidate: CHART_ARCHETYPES.appointments.volume[0]!,
      source: "your bookings export",
      values: new Map([...s.values.keys()].map((d) => [d, 10])),
    },
    bookings: s.bookings,
    capacity: { per_week: 80, basis: "STATED" },
    campaigns: null,
    stock: null,
    waiting: [
      {
        id: "p1",
        summary: "Take a deposit on first bookings",
        base: { amount_minor: 20000, currency: "EUR" },
        upside: { amount_minor: 35000, currency: "EUR" },
      },
    ],
    events: [
      {
        date: shiftDay(LAST, -10),
        kind: "approved",
        label: "Deposit rule",
        detail: "You approved it.",
      },
      { date: "2020-01-01", kind: "anomaly", label: "Too old", detail: "Before the chart." },
    ],
    other_currencies: [],
    ...over,
  };
}

function drawn(over: Partial<MarketInputs> = {}): DrawnModel {
  const m = buildMarketModel(inputs(over));
  if (m.status !== "drawn") throw new Error("expected a drawn chart");
  return m;
}

describe("the empty state — a business with no data", () => {
  it("invites the connection the profile names, with every component's reason", () => {
    const m = buildMarketModel(
      inputs({ price: null, volume: null, bookings: null, capacity: null }),
    );
    expect(m.status).toBe("empty");
    if (m.status !== "empty") return;
    expect(m.title).toBe("Your salon, read like a stock");
    expect(m.message).toBe("Import your bookings export or connect Square, and I'll draw this.");
    expect(m.href).toBe("/connections");
    expect(m.components.map((c) => c.key)).toEqual([...CHART_ARCHETYPES.appointments.components]);
    for (const c of m.components) {
      expect(c.status).toBe("absent");
      expect(c.reason.length).toBeGreaterThan(10);
    }
    expect(m.components.find((c) => c.key === "empty_capacity")?.reason).toMatch(
      /won't assume a capacity/,
    );
  });

  it("is still empty one day short of the drawing floor, and draws at it", () => {
    const short = new Map([...salon(MIN_DRAWN_DAYS - 1).values]);
    const price = { ...inputs().price!, values: short };
    expect(buildMarketModel(inputs({ price })).status).toBe("empty");
    const enough = { ...inputs().price!, values: new Map([...salon(MIN_DRAWN_DAYS).values]) };
    expect(buildMarketModel(inputs({ price: enough })).status).toBe("drawn");
  });

  it("a shop with nothing says what a shop connects", () => {
    const m = buildMarketModel(
      inputs({ archetype: "shop", noun: "your shop", price: null, bookings: null }),
    );
    expect(m.status === "empty" && m.message).toMatch(/^Connect Shopify or WooCommerce/);
  });
});

describe("a drawn chart", () => {
  it("lists the profile's components in order, and leads with the largest flow", () => {
    const m = drawn();
    expect(m.components.map((c) => c.key)).toEqual([...CHART_ARCHETYPES.appointments.components]);
    expect(m.title).toBe(chartTitle("your salon"));
    expect(m.headline.text).toMatch(/^About €[\d,]+( to €[\d,]+)? a month is slipping away: /);
    expect(m.headline.lead).not.toBeNull();
    // No Meta connection: the ads line says what would fill it.
    const ads = m.components.find((c) => c.key === "losing_ads");
    expect(ads?.status === "absent" && ads.reason).toMatch(/connect Meta Ads/);
  });

  it("carries each day's slip for the line, never the ads, and keeps events in range", () => {
    const m = drawn();
    const withSlip = m.days.filter((d) => d.slip && d.slip.length > 0);
    expect(withSlip.length).toBeGreaterThan(0);
    for (const d of withSlip) {
      for (const s of d.slip!)
        expect(["no_shows", "late_cancellations", "empty_capacity", "revenue_dips"]).toContain(
          s.key,
        );
    }
    expect(m.events.map((e) => e.label)).toEqual(["Deposit rule"]);
    expect(m.price.basis).toBe("OBSERVED");
    expect(m.window.days).toBe(90);
  });

  it("skips a component that doesn't apply (no stock held)", () => {
    const m = drawn({ archetype: "shop", noun: "your shop", skip: ["slow_stock"] });
    expect(m.components.map((c) => c.key)).not.toContain("slow_stock");
  });

  it("says so when the price is measured in a second currency it won't draw", () => {
    expect(drawn({ other_currencies: ["GBP"] }).notes[0]).toMatch(/GBP isn't drawn/);
  });

  it("is JSON-safe: the API sends it as is", () => {
    const m = drawn();
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
});

describe("event markers", () => {
  it("fold same-day events of one kind into one marker, oldest first", () => {
    const e = (date: string, kind: "approved" | "anomaly", label: string) => ({
      date,
      kind,
      label,
      detail: `${label}.`,
    });
    const g = groupEvents([
      e("2026-10-09", "approved", "B"),
      e("2026-10-01", "anomaly", "Z"),
      e("2026-10-09", "approved", "A"),
      e("2026-10-09", "anomaly", "Y"),
    ]);
    expect(g.map((x) => x.label)).toEqual(["Z", "2 changes: B; A", "Y"]);
    expect(g[1]!.detail).toBe("B. A.");
  });
});

describe("the text alternative", () => {
  it("has a summary sentence and a row per plotted candle, for every bucket", () => {
    const m = drawn();
    for (const bucket of ["day", "week", "month"] as const) {
      const candles = bucketCandles(m.days, bucket);
      const summary = chartSummary(m, candles, bucket);
      expect(summary).toContain("Your salon, read like a stock");
      expect(summary).toContain(m.headline.text);
      expect(summary).toMatch(/candles of booking revenue a day from your bookings export/);
      const table = chartTable(m, candles, bucket);
      expect(table.rows).toHaveLength(candles.length);
      expect(table.head).toContain("Appointments");
      for (const r of table.rows) expect(r).toHaveLength(table.head.length);
      expect(table.caption.length).toBeGreaterThan(10);
    }
  });

  it("says what is missing when nothing is in range", () => {
    expect(chartSummary(drawn(), [], "week")).toMatch(/nothing measured/);
  });
});
