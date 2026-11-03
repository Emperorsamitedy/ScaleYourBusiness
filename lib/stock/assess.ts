// Slow stock, found deterministically — feature 34.
//
// Pure module: per item, units on hand, units sold in the last 30/60/90
// days, days of cover, cash tied up (on hand × unit cost) and days since the
// last sale, from the item's own measured figures. "Not selling" is two
// pinned thresholds (STOCK), boundary-tested both ways in assess.test.ts:
//
//   STUCK  stock on hand and no sale in the last 60 days (so the last one,
//          if any, was 61 or more days ago) — measured, not assumed: the
//          history has to cover those 60 days
//   SLOW   not stuck, but more than 180 days of cover at the item's own
//          rate of sale (or no sale at all in the history it has)
//
// Windows end yesterday: today is never a whole day (the ads precedent).
// An imported stock file is judged as of the day it was counted, never
// stretched to today: sales since the count are not in the file. Nothing
// here calls a model (cost rule) and nothing converts currencies (rule 1).
//
// L-4b: the reason (`why`) is the "stockWords" catalogue through optional
// words, English by default (./words) — what is stored stays English.

import type { Words } from "./words";
import { dayCount, dec2, englishStock, int } from "./words";

export const STOCK = {
  /** STUCK: on hand, and no sale in the last this-many days (the last one ≥ this + 1 days ago). */
  stuck_no_sale_days: 60,
  /** SLOW: more than this many days of cover at the item's rate of sale. */
  slow_cover_days: 180,
  /** The rate of sale is read over this many days (or the history, when shorter). */
  rate_window_days: 90,
  /** The sold columns: units in the last N days. */
  windows: [30, 60, 90] as const,
  /** Fewer measured days of sales history than this: no flag, too early to say. */
  min_history_days: 30,
  /** How far back a store's units sold are read. */
  history_days: 365,
} as const;

export type StockFlag = "STUCK" | "SLOW";
export type SoldWindow = (typeof STOCK.windows)[number];

/** A store's measured daily sales of one item. */
export interface SeriesSales {
  kind: "series";
  /** Measured days ending yesterday (the store's sync covers them, sale or none). */
  covered_days: number;
  /** "YYYY-MM-DD" → units sold that day; only days with sales. */
  daily: ReadonlyMap<string, number>;
}

/** What an imported stock file says about sales, as of its count date. */
export interface FileSales {
  kind: "file";
  /** The window the units-sold column covers, when the file has one. */
  window_days: number | null;
  units_in_window: number | null;
  /** Days from the last sale to the count date, when the file has a last-sold date. */
  days_since_sale: number | null;
}

export interface StockItem {
  /** Which source: "shopify", "woocommerce", "stock_import". */
  provider: string;
  connection_id: string;
  /** The store's product id, or the imported item's key. */
  ref: string;
  name: string;
  /** The day the stock was read or counted — every figure is as of this day. */
  as_of: string;
  on_hand: number;
  /** On hand × unit cost, when known. */
  value_at_cost: number | null;
  value_at_price: number | null;
  currency: string | null;
  /**
   * Where the cost came from: the platform or file ("measured"), or the
   * owner's own cost for the matched offer ("stated"), or nowhere (null).
   */
  cost_basis: "measured" | "stated" | null;
  /** The matched offer, when the owner matched this product to one. */
  offer_id: string | null;
  sales: SeriesSales | FileSales;
}

export interface StockAssessment {
  /** Units sold in the last 30/60/90 days; null where the history doesn't cover the window. */
  sold: Record<SoldWindow, number | null>;
  /** Exact days since the last sale, when one is on record. */
  days_since_sale: number | null;
  /** No sale in the whole history on record: at least this many days. */
  no_sale_for_at_least: number | null;
  /** Units per day, and over what it was read. */
  rate: { per_day: number; over_days: number } | null;
  /** On hand ÷ rate; null when there's no rate, or no sales to divide by. */
  days_of_cover: number | null;
  /** On hand × unit cost: the cash the stock holds. */
  cash_tied_minor: number | null;
  flag: StockFlag | null;
  /** One sentence: why it is flagged, or why it isn't judged. */
  why: string;
}

/** Pure: "YYYY-MM-DD" shifted by whole days. */
export function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Pure: judge one item, as of `today` for store figures and as of its count for a file. */
export function assessItem(
  item: StockItem,
  today: string,
  w: Words = englishStock(),
): StockAssessment {
  const { tr, locale } = w;
  const sold: Record<SoldWindow, number | null> = { 30: null, 60: null, 90: null };
  let daysSince: number | null = null;
  let atLeast: number | null = null;
  let rate: StockAssessment["rate"] = null;
  let judgeable: boolean;
  let noHistoryWhy = "";

  if (item.sales.kind === "series") {
    const s = item.sales;
    const end = shiftDay(today, -1);
    for (const w of STOCK.windows) {
      if (s.covered_days < w) continue;
      const from = shiftDay(end, -(w - 1));
      let units = 0;
      for (const [day, u] of s.daily) if (day >= from && day <= end) units += u;
      sold[w] = units;
    }
    const saleDays = [...s.daily.entries()].filter(([, u]) => u > 0).map(([d]) => d);
    const last = saleDays.length > 0 ? saleDays.sort().at(-1)! : null;
    if (last !== null) daysSince = daysBetween(last, today);
    else atLeast = s.covered_days;
    const over = Math.min(STOCK.rate_window_days, s.covered_days);
    judgeable = s.covered_days >= STOCK.min_history_days;
    if (judgeable) {
      const from = shiftDay(end, -(over - 1));
      let units = 0;
      for (const [day, u] of s.daily) if (day >= from && day <= end) units += u;
      rate = { per_day: units / over, over_days: over };
    } else {
      noHistoryWhy = tr("why.tooLittle", {
        ...dayCount(s.covered_days, locale),
        min: int(STOCK.min_history_days, locale),
      });
    }
  } else {
    const f = item.sales;
    if (f.window_days !== null && f.units_in_window !== null) {
      for (const w of STOCK.windows) {
        if (f.window_days === w) sold[w] = f.units_in_window;
        else if (f.units_in_window === 0 && f.window_days > w) sold[w] = 0;
      }
      rate = { per_day: f.units_in_window / f.window_days, over_days: f.window_days };
    }
    if (f.days_since_sale !== null) {
      daysSince = f.days_since_sale;
      for (const w of STOCK.windows) if (sold[w] === null && f.days_since_sale > w) sold[w] = 0;
    } else if (f.units_in_window === 0 && f.window_days !== null) {
      atLeast = f.window_days;
    }
    judgeable = rate !== null || daysSince !== null;
    if (!judgeable) noHistoryWhy = tr("why.fileNoSales");
  }

  const cash = item.value_at_cost;
  const cover = rate !== null && rate.per_day > 0 ? item.on_hand / rate.per_day : null;
  const base = { sold, days_since_sale: daysSince, no_sale_for_at_least: atLeast, rate };
  const result = (flag: StockFlag | null, why: string): StockAssessment => ({
    ...base,
    days_of_cover: cover,
    cash_tied_minor: cash,
    flag,
    why,
  });

  if (item.on_hand <= 0) return result(null, tr("why.noneOnHand"));
  // Whole days without a sale, ending yesterday: a sale N days ago leaves N − 1.
  const quiet = daysSince !== null ? daysSince - 1 : atLeast;
  if (quiet !== null && quiet >= STOCK.stuck_no_sale_days) {
    return result(
      "STUCK",
      tr(daysSince !== null ? "why.stuck" : "why.stuckOnRecord", {
        ...dayCount(daysSince ?? atLeast!, locale),
        onHand: int(item.on_hand, locale),
      }),
    );
  }
  if (!judgeable) return result(null, noHistoryWhy);
  if (rate !== null && rate.per_day === 0) {
    return result("SLOW", tr("why.slowNoSale", dayCount(rate.over_days, locale)));
  }
  if (cover !== null && cover > STOCK.slow_cover_days) {
    return result(
      "SLOW",
      tr("why.slowCover", {
        cover: int(Math.round(cover), locale),
        rate: dec2(rate!.per_day, locale),
        limit: int(STOCK.slow_cover_days, locale),
      }),
    );
  }
  return result(
    null,
    cover !== null
      ? tr("why.selling", { cover: int(Math.round(cover), locale) })
      : tr("why.noRate"),
  );
}

export interface RankedItem {
  item: StockItem;
  assessment: StockAssessment;
}

/**
 * Pure: flagged items, most cash tied up first. Cash is compared only
 * within one currency — the currency most flagged items hold comes first,
 * the rest after, never converted (rule 1). Items whose cash is unknown
 * follow the known ones, by value at price.
 */
export function rankSlow(items: readonly RankedItem[]): RankedItem[] {
  const flagged = items.filter((r) => r.assessment.flag !== null);
  const counts = new Map<string, number>();
  for (const r of flagged) {
    const c = r.item.currency ?? "";
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const order = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const rank = new Map(order.map(([c], i) => [c, i]));
  return [...flagged].sort((a, b) => {
    const ca = rank.get(a.item.currency ?? "") ?? 0;
    const cb = rank.get(b.item.currency ?? "") ?? 0;
    if (ca !== cb) return ca - cb;
    const ka = a.assessment.cash_tied_minor;
    const kb = b.assessment.cash_tied_minor;
    if (ka !== null && kb !== null && ka !== kb) return kb - ka;
    if (ka !== null && kb === null) return -1;
    if (ka === null && kb !== null) return 1;
    const pa = a.item.value_at_price ?? -1;
    const pb = b.item.value_at_price ?? -1;
    if (pa !== pb) return pb - pa;
    return a.item.name < b.item.name ? -1 : 1;
  });
}
