// The slow-stock screen's words — feature 34. Pure, so they are tested
// without a browser (stock-view.test.ts).

import type { StockItemView, StockOptionView, StockView } from "../../app/api/stock/route";
import { moneyText, num } from "../sheet/num";

/** The screen's one display line: the cash tied up, as a sentence. */
export function headline(view: StockView): string {
  const slow = view.slow ?? [];
  const read = (view.sources ?? []).some((s) => s.as_of !== null);
  if (!read) return "I haven't read your stock yet.";
  if (slow.length === 0) return "Everything you hold is selling.";
  const t = (view.totals ?? [])[0];
  const n = slow.length;
  const items = `${n} item${n === 1 ? "" : "s"} that ${n === 1 ? "isn't" : "aren't"} selling`;
  if (!t || t.cash_tied_minor === 0) return `${items[0]!.toUpperCase()}${items.slice(1)}.`;
  return `${moneyText(t.cash_tied_minor, t.currency)} is tied up in ${items}.`;
}

/** The flag's tint: STUCK is an alarm, SLOW a drift — the word carries the meaning. */
export function flagClass(flag: StockItemView["flag"]): "alarm" | "drift" {
  return flag === "STUCK" ? "alarm" : "drift";
}

/** What has happened to an option's proposal, in one or two words. */
export function proposalWord(o: StockOptionView): { word: string; tone: string } | null {
  if (o.unavailable !== null) return { word: "Can't", tone: "none" };
  const p = o.proposal;
  if (!p) return null;
  switch (p.status) {
    case "pending":
      return { word: "Waiting for you", tone: "ok" };
    case "blocked":
      return { word: "Blocked by your rule", tone: "alarm" };
    case "approved":
      return { word: "Approved", tone: "ok" };
    case "executed":
      return { word: "Done", tone: "ok" };
    case "rejected":
      return { word: "Declined", tone: "none" };
    case "expired":
      return { word: "Expired", tone: "none" };
    default:
      return { word: p.status.replace(/_/g, " "), tone: "none" };
  }
}

/** Days of cover as the table prints it. */
export function coverText(item: StockItemView): string {
  if (item.days_of_cover !== null) return num(item.days_of_cover);
  return item.on_hand > 0 ? "no sales" : "—";
}

/** Days since the last sale as the table prints it. */
export function quietText(item: StockItemView): string {
  if (item.days_since_sale !== null) return num(item.days_since_sale);
  if (item.no_sale_for_at_least !== null) return `${num(item.no_sale_for_at_least)}+`;
  return "—";
}

/** The money a column prints, or a dash with no guess behind it. */
export function cashText(minor: number | null, currency: string | null): string {
  return minor === null || currency === null ? "unknown" : moneyText(minor, currency);
}

/** Rule 11: what the owner said dead stock was worth, against what's measured. */
export function statedVsMeasured(view: StockView): string | null {
  const stated = view.stated_dead_stock;
  if (!stated) return null;
  const t = (view.totals ?? []).find((x) => x.currency === stated.currency);
  if (!t) {
    return `You estimated your dead stock at ${moneyText(stated.amount_minor, stated.currency)}; what I measured isn't in ${stated.currency}, so I don't compare them.`;
  }
  const word = t.cash_tied_minor >= stated.amount_minor ? "more" : "less";
  return `You estimated your dead stock at ${moneyText(stated.amount_minor, stated.currency)}; I measure ${moneyText(t.cash_tied_minor, t.currency)} at cost in stock that isn't selling — ${moneyText(Math.abs(t.cash_tied_minor - stated.amount_minor), t.currency)} ${word}. Your estimate stays on your fact sheet.`;
}
