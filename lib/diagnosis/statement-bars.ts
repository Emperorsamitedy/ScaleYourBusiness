// /statement's money as bars — the figures the page already prints, shaped
// for components/charts/Viz HBars. Pure. One zero-based scale per currency,
// never across currencies (rule 1); a bar's length is the unsigned amount,
// and the printed figure keeps its sign.

import type { Money } from "../core/money";
import type { HeadlineCounter } from "../ledger/counter";

export interface WorthRow {
  key: "verified" | "losses" | "fee" | "net";
  /** Null where the statement has no figure in this currency. */
  money: Money | null;
  value: number;
  tone: "ok" | "alarm" | "hollow" | "ink";
}

export interface WorthBlock {
  currency: string;
  rows: WorthRow[];
  max: number;
}

/**
 * Verified, the losses inside it, the fee and what is left after it, per
 * currency. The fee and after-fee rows exist only when a fee was charged,
 * as the page prints them; a currency with nothing to draw is left out.
 */
export function worthBars(
  worth: Pick<HeadlineCounter, "verified" | "losses" | "fee" | "net_of_fee">,
): WorthBlock[] {
  const charged = worth.fee.length > 0;
  const lists = [worth.verified, worth.losses, worth.fee, ...(charged ? [worth.net_of_fee] : [])];
  const of = (list: readonly Money[], currency: string) =>
    list.find((m) => m.currency === currency) ?? null;
  const size = (m: Money | null) => Math.abs(m?.amount_minor ?? 0);
  return [...new Set(lists.flat().map((m) => m.currency))]
    .sort((a, b) => a.localeCompare(b))
    .map((currency) => {
      const verified = of(worth.verified, currency);
      const losses = of(worth.losses, currency);
      const fee = of(worth.fee, currency);
      const net = of(worth.net_of_fee, currency);
      const rows: WorthRow[] = [
        {
          key: "verified",
          money: verified,
          value: size(verified),
          tone: (verified?.amount_minor ?? 0) < 0 ? "alarm" : "ok",
        },
        { key: "losses", money: losses, value: size(losses), tone: "alarm" },
      ];
      if (fee) rows.push({ key: "fee", money: fee, value: size(fee), tone: "hollow" });
      if (charged) {
        rows.push({
          key: "net",
          money: net,
          value: size(net),
          tone: (net?.amount_minor ?? 0) < 0 ? "alarm" : "ink",
        });
      }
      return { currency, rows, max: Math.max(...rows.map((r) => r.value)) };
    })
    .filter((b) => b.max > 0);
}

export interface LeakRange {
  key: string;
  currency: string;
  low_minor: number;
  high_minor: number;
}

export interface LeakBlock {
  currency: string;
  /** In the order given. `low` is the sure end, `value` the far end. */
  rows: { key: string; low: number; value: number }[];
  max: number;
}

/**
 * The leaks' low–high ranges, per currency on one scale. Only ranges the
 * page may show are passed in. A range that crosses zero is left out: a
 * zero-based bar would hide its losing end, and the list beneath prints it.
 */
export function leakBars(ranges: readonly LeakRange[]): LeakBlock[] {
  const by = new Map<string, LeakBlock["rows"]>();
  for (const r of ranges) {
    if (Math.min(r.low_minor, r.high_minor) < 0) continue;
    const low = Math.min(r.low_minor, r.high_minor);
    const value = Math.max(r.low_minor, r.high_minor);
    by.set(r.currency, [...(by.get(r.currency) ?? []), { key: r.key, low, value }]);
  }
  return [...by]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, rows]) => ({ currency, rows, max: Math.max(...rows.map((r) => r.value)) }))
    .filter((b) => b.max > 0);
}
