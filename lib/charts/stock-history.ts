// Cash tied up in slow stock, over time — the /stock screen's small chart.
//
// Stock figures are SNAPSHOTS (lib/connectors/provider.ts STOCK_METRICS):
// one item's value at cost as read on one day. They are never summed
// across days; each point here is one item on one snapshot day. The chart
// exists only where there is a story to tell over time: at least two
// snapshot days. One count is a balance, already on the table above it.
//
// Pure; the loader (./load, loadStockHistory) reads the rows.
//
// L-4b: the summary (the table's caption) is the "stockWords" catalogue
// through optional words, English by default; the /stock handler words it
// again in the reader's language with stockHistorySummary.

import { listSep } from "../i18n/punctuation";
import type { Words } from "../i18n/request-words";
import { englishTr } from "../i18n/tr";
import { shortDate } from "./model";
import { rangeWhole } from "./opportunity";
import { num } from "../../components/sheet/num";

/** At most this many items, most cash tied up first (the screen's own order). */
export const HISTORY_ITEMS = 6;

export interface SnapshotRow {
  connection_id: string;
  product_ref: string;
  period_date: string;
  value_minor: number;
  currency: string;
}

export interface SlowItemKey {
  connection_id: string;
  ref: string;
  name: string;
}

export interface StockHistoryItem {
  key: string;
  name: string;
  /** Oldest first: the item's value at cost on each snapshot day it was read. */
  points: { date: string; cash_minor: number }[];
}

export interface StockHistoryModel {
  currency: string;
  /** Every snapshot day any shown item was read on, oldest first. */
  dates: string[];
  items: StockHistoryItem[];
  /** Items left out because their value is in another currency. */
  other_currency: number;
  summary: string;
}

/** The chart's summary, in `w` (English by default): what each item held on the first and last count. */
export function stockHistorySummary(
  model: Pick<StockHistoryModel, "currency" | "dates" | "items">,
  w: Words = { tr: englishTr("stockWords"), locale: "en" },
): string {
  const { tr, locale } = w;
  const { currency, dates, items } = model;
  const money = (minor: number) =>
    rangeWhole({ low_minor: minor, high_minor: minor, currency }, locale);
  const each = items.map((i) => {
    const a = i.points[0]!;
    const b = i.points.at(-1)!;
    return a.date === b.date
      ? tr("history.oneCount", { name: i.name, amount: money(b.cash_minor) })
      : tr("history.change", {
          name: i.name,
          from: money(a.cash_minor),
          to: money(b.cash_minor),
        });
  });
  return tr("history.summary", {
    count: items.length,
    n: locale === "en" ? String(items.length) : num(items.length, 0, locale),
    from: shortDate(dates[0]!, locale),
    to: shortDate(dates.at(-1)!, locale),
    items: each.join(listSep(locale)),
  });
}

export function buildStockHistory(
  rows: readonly SnapshotRow[],
  slow: readonly SlowItemKey[],
  w?: Words,
): StockHistoryModel | null {
  const wanted = slow.slice(0, HISTORY_ITEMS);
  const byKey = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    if (!Number.isSafeInteger(r.value_minor)) continue;
    const k = `${r.connection_id}:${r.product_ref}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const currencyCount = new Map<string, number>();
  for (const w of wanted) {
    const c = byKey.get(`${w.connection_id}:${w.ref}`)?.at(-1)?.currency;
    if (c) currencyCount.set(c, (currencyCount.get(c) ?? 0) + 1);
  }
  const currency = [...currencyCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!currency) return null;
  let other = 0;
  const items: StockHistoryItem[] = [];
  for (const w of wanted) {
    const key = `${w.connection_id}:${w.ref}`;
    const list = byKey.get(key) ?? [];
    if (list.length === 0) continue;
    if (list.some((r) => r.currency !== currency)) {
      other += 1;
      continue;
    }
    // One value per day: the latest read of that day wins (a snapshot, not a sum).
    const perDay = new Map<string, number>();
    for (const r of list) perDay.set(r.period_date, r.value_minor);
    items.push({
      key,
      name: w.name,
      points: [...perDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, cash_minor]) => ({ date, cash_minor })),
    });
  }
  const dates = [...new Set(items.flatMap((i) => i.points.map((p) => p.date)))].sort();
  if (dates.length < 2 || items.length === 0) return null;
  const summary = stockHistorySummary({ currency, dates, items }, w);
  return { currency, dates, items, other_currency: other, summary };
}
