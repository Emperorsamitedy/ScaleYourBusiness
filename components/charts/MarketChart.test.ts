// The market chart's text alternative, rendered: the summary as the
// figure's accessible name, a visually-hidden table with a row per candle,
// the keyboard-reachable switch, and the empty state's invitation.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { shiftDay } from "../../lib/anomaly/baseline";
import { BUCKET_SPAN, bucketCandles, lastBuckets } from "../../lib/charts/candles";
import type { MarketInputs } from "../../lib/charts/model";
import { buildMarketModel, chartSummary } from "../../lib/charts/model";
import { CHART_ARCHETYPES } from "../../lib/charts/profiles";
import { MarketChart } from "./MarketChart";

const LAST = "2026-10-24";

function shop(days: number): MarketInputs {
  const values = new Map<string, number>();
  const volume = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const d = shiftDay(LAST, -i);
    values.set(d, 100000 + ((i * 7919) % 30000));
    volume.set(d, 20 + (i % 7));
  }
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
    volume: { candidate: CHART_ARCHETYPES.shop.volume[0]!, source: "Shopify", values: volume },
    bookings: null,
    capacity: null,
    campaigns: null,
    stock: null,
    waiting: [],
    events: [
      { date: shiftDay(LAST, -3), kind: "connected", label: "Shopify connected", detail: "d" },
    ],
    other_currencies: [],
  };
}

describe("MarketChart renders its text alternative", () => {
  it("names the figure with the summary and hides a table of every plotted candle", () => {
    const model = buildMarketModel(shop(120));
    if (model.status !== "drawn") throw new Error("expected drawn");
    const html = renderToStaticMarkup(createElement(MarketChart, { model }));
    const candles = lastBuckets(bucketCandles(model.days, "day"), BUCKET_SPAN.day.wide);
    const summary = chartSummary(model, candles, "day");
    expect(html).toContain('role="img"');
    expect(html).toContain(
      `aria-label="${summary.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`,
    );
    expect(html).toContain('aria-describedby="mk-table"');
    expect(html).toContain('tabindex="0"');
    const hidden = html.slice(html.indexOf('<div class="sr-only" id="mk-table">'));
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.match(/<tr>/g)?.length).toBe(candles.length + 1);
    // The switch: three pressed-state buttons in a labelled group.
    expect(html).toContain('role="group" aria-label="Candle period"');
    expect(html.match(/aria-pressed="(true|false)"/g)).toHaveLength(3);
    expect(html).toContain("Your shop, read like a stock");
    // The event is keyed in words, not only drawn.
    expect(html).toContain("Shopify connected");
  });

  it("the empty state invites the connection, with no figure at all", () => {
    const model = buildMarketModel({ ...shop(0), price: null, volume: null });
    const html = renderToStaticMarkup(createElement(MarketChart, { model }));
    expect(html).toContain("Nothing to draw yet.");
    expect(html).toContain("Connect Shopify or WooCommerce");
    expect(html).toContain('href="/connections"');
    expect(html).not.toContain("<svg");
  });
});
