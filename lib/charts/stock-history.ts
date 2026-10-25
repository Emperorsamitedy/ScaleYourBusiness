// Cash tied up in slow stock, over time — the /stock screen's small chart.
//
// Stock figures are SNAPSHOTS (lib/connectors/provider.ts STOCK_METRICS):
// one item's value at cost as read on one day. They are never summed
// across days; each point here is one item on one snapshot day. The chart
// exists only where there is a story to tell over time: at least two
// snapshot days. One count is a balance, already on the table above it.
//
// Pure; the loader (./load, loadStockHistory) reads the rows.

import { shortDate } from "./model";
import { rangeWhole } from "./opportunity";

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

export function buildStockHistory(
  rows: readonly SnapshotRow[],
  slow: readonly SlowItemKey[],
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
  const summary =
    `Cash tied up at cost in the ${items.length} slowest item${items.length === 1 ? "" : "s"}, ` +
    `on each stock count from ${shortDate(dates[0]!)} to ${shortDate(dates.at(-1)!)}: ` +
    items
      .map((i) => {
        const a = i.points[0]!;
        const b = i.points.at(-1)!;
        return a.date === b.date
          ? `${i.name} ${rangeWhole({ low_minor: b.cash_minor, high_minor: b.cash_minor, currency })} (one count)`
          : `${i.name} from ${rangeWhole({ low_minor: a.cash_minor, high_minor: a.cash_minor, currency })} to ${rangeWhole({ low_minor: b.cash_minor, high_minor: b.cash_minor, currency })}`;
      })
      .join("; ") +
    ". A stock, read on each count day — never added across days.";
  return { currency, dates, items, other_currency: other, summary };
}
