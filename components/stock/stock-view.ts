// The stock screen's words — feature 34 (slow stock) and P5-05 (what runs out). Pure, so they are tested
// without a browser (stock-view.test.ts).
//
// L-3b: the fixed words (status words, flags, units, "at cost") are the
// "stock" catalogue through an optional translator, English by default;
// figures in the reader's locale.
//
// L-4b: the sentences built from the counts (the headline, stated against
// measured, the stock-out headline) are the "stockWords" catalogue through
// optional words, English by default; the screen passes useTr("stockWords").

import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type {
  CoverItemView,
  StockItemView,
  StockOptionView,
  StockView,
} from "../../app/api/stock/route";
import { moneyText, num } from "../sheet/num";

/** The screen's words and the reader's locale: the "stock" catalogue. */
export interface StockWords {
  tr: Tr;
  locale: AppLocale;
}
const ENGLISH = (): StockWords => ({ tr: englishTr("stock"), locale: "en" });
/** The sentences' words: the "stockWords" catalogue (lib/stock/words). */
const SENTENCES = (): StockWords => ({ tr: englishTr("stockWords"), locale: "en" });

/** A count inside a sentence: "1234" in English, as it always read; grouped elsewhere. */
const count = (n: number, locale: AppLocale) => (locale === "en" ? String(n) : num(n, 0, locale));

const FLAG_KEY: Record<string, string> = {
  STUCK: "stuck",
  SLOW: "slow",
  "ACT NOW": "actNow",
  "RUNNING LOW": "runningLow",
  "IN RANGE": "inRange",
  "SOLD OUT": "soldOut",
  "NO SALES": "noSales",
  "TOO EARLY": "tooEarly",
};

/** A flag's word in the reader's language ("STUCK", "ACT NOW"); an unknown code as it came. */
export function flagWord(flag: string, tr: Tr = ENGLISH().tr): string {
  const key = FLAG_KEY[flag];
  return key ? tr(`flag.${key}`) : flag;
}

/** The flag in running text: "stuck", "act now". */
export function flagLower(flag: string, w: StockWords = ENGLISH()): string {
  return flagWord(flag, w.tr).toLocaleLowerCase(intlTag(w.locale));
}

/** The screen's one display line: the cash tied up, as a sentence. */
export function headline(view: StockView, w: StockWords = SENTENCES()): string {
  const { tr, locale } = w;
  const slow = view.slow ?? [];
  const read = (view.sources ?? []).some((s) => s.as_of !== null);
  if (!read) return tr("view.notRead");
  if (slow.length === 0) return tr("view.allSelling");
  const t = (view.totals ?? [])[0];
  const n = { count: slow.length, n: count(slow.length, locale) };
  if (!t || t.cash_tied_minor === 0) return tr("view.notSelling", n);
  return tr("view.tiedUp", { ...n, amount: moneyText(t.cash_tied_minor, t.currency, locale) });
}

/** The flag's tint: STUCK is an alarm, SLOW a drift — the word carries the meaning. */
export function flagClass(flag: StockItemView["flag"]): "alarm" | "drift" {
  return flag === "STUCK" ? "alarm" : "drift";
}

/** What has happened to a proposal, in one or two words. */
export function statusWord(
  p: { status: string },
  tr: Tr = ENGLISH().tr,
): { word: string; tone: string } {
  switch (p.status) {
    case "pending":
      return { word: tr("view.waiting"), tone: "ok" };
    case "blocked":
      return { word: tr("view.blocked"), tone: "alarm" };
    case "approved":
      return { word: tr("view.approved"), tone: "ok" };
    case "executed":
      return { word: tr("view.done"), tone: "ok" };
    case "rejected":
      return { word: tr("view.declined"), tone: "none" };
    case "expired":
      return { word: tr("view.expired"), tone: "none" };
    default:
      return { word: p.status.replace(/_/g, " "), tone: "none" };
  }
}

/** What has happened to an option's proposal, in one or two words. */
export function proposalWord(
  o: StockOptionView,
  tr: Tr = ENGLISH().tr,
): { word: string; tone: string } | null {
  if (o.unavailable !== null) return { word: tr("view.cant"), tone: "none" };
  return o.proposal ? statusWord(o.proposal, tr) : null;
}

/** Days of cover as the table prints it. */
export function coverText(item: StockItemView, w: StockWords = ENGLISH()): string {
  if (item.days_of_cover !== null) return num(item.days_of_cover, 0, w.locale);
  return item.on_hand > 0 ? w.tr("view.noSales") : "—";
}

/** Days since the last sale as the table prints it. */
export function quietText(item: StockItemView, locale: AppLocale = "en"): string {
  if (item.days_since_sale !== null) return num(item.days_since_sale, 0, locale);
  if (item.no_sale_for_at_least !== null) return `${num(item.no_sale_for_at_least, 0, locale)}+`;
  return "—";
}

/** The money a column prints, or a dash with no guess behind it. */
export function cashText(
  minor: number | null,
  currency: string | null,
  w: StockWords = ENGLISH(),
): string {
  return minor === null || currency === null
    ? w.tr("view.unknown")
    : moneyText(minor, currency, w.locale);
}

/** Rule 11: what the owner said dead stock was worth, against what's measured. */
export function statedVsMeasured(view: StockView, w: StockWords = SENTENCES()): string | null {
  const { tr, locale } = w;
  const stated = view.stated_dead_stock;
  if (!stated) return null;
  const said = moneyText(stated.amount_minor, stated.currency, locale);
  const t = (view.totals ?? []).find((x) => x.currency === stated.currency);
  if (!t) return tr("view.svmOtherCurrency", { stated: said, currency: stated.currency });
  return tr("view.svm", {
    stated: said,
    measured: moneyText(t.cash_tied_minor, t.currency, locale),
    diff: moneyText(Math.abs(t.cash_tied_minor - stated.amount_minor), t.currency, locale),
    direction: t.cash_tied_minor >= stated.amount_minor ? "more" : "less",
  });
}

/* ── P5-05: what runs out, and when ── */

/** The screen's display line: the soonest stock-out when there is one, else the slow-stock line. */
export function stockHeadline(view: StockView, w: StockWords = SENTENCES()): string {
  const first = (view.cover?.items ?? []).find((i) => i.warning !== null);
  // The server words the head on its own (warning_head); the split is only for an older reply.
  if (first?.warning) return first.warning_head ?? `${first.warning.split(";")[0]}.`;
  return headline(view, w);
}

/** The cover flag's tint; the word carries the meaning, the tint only repeats it. */
export function coverFlagClass(flag: CoverItemView["flag"]): "alarm" | "drift" | "ok" | "low" {
  switch (flag) {
    case "ACT NOW":
      return "alarm";
    case "RUNNING LOW":
      return "drift";
    case "IN RANGE":
      return "ok";
    default:
      return "low";
  }
}

/** "+23 · chance ±40" / "−12 · down" — window A against window B (P5-01). */
export function vsPriorText(item: CoverItemView, w: StockWords = ENGLISH()): string {
  const { tr, locale } = w;
  const v = item.vs_prior;
  if (!v) return "—";
  if (v.change === 0 && v.band === 0) return tr("view.noneSold");
  const sign = v.change > 0 ? "+" : v.change < 0 ? "−" : "±";
  const word =
    v.direction === "flat"
      ? tr("view.same")
      : v.direction === "up"
        ? tr("view.up")
        : tr("view.down");
  return `${sign}${num(Math.abs(v.change), 0, locale)} · ${word}`;
}

/** "10 d · Midland Clay Supplies" / "14 d · ASSUMED". */
export function leadText(item: CoverItemView, w: StockWords = ENGLISH()): string {
  const { tr, locale } = w;
  const days = num(item.lead.days, 0, locale);
  return item.lead.basis === "stated"
    ? tr("view.lead", { days, supplier: item.lead.supplier ?? tr("view.yourSupplier") })
    : tr("view.lead", { days, supplier: tr("view.assumed") });
}

/* ── the bars beside the figures (ux-spec §2.1 "Small visuals") ── */

const DAY_MS = 86_400_000;
const daysFrom = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

export interface CoverBar {
  /** Shares (0–1) of the longest stretch in the table: the soon end of the cover… */
  low: number;
  /** …its late end (null with no upper bound)… */
  high: number | null;
  /** …and the delivery time, on the same scale. */
  lead: number;
  tone: "drift" | "ink";
}

/** The cover scale ends at this many of the longest delivery time; longer cover fills the bar. */
export const COVER_SCALE_LEADS = 4;

/**
 * Pure: each item's days of cover against its delivery time, on one scale —
 * the longest cover or delivery time shown, capped at COVER_SCALE_LEADS
 * delivery times. The days are read back from the
 * run-out dates the row carries; an item without them has no bar. The tone
 * is the row's own flag, so the bar can only repeat the word beside it.
 */
export function coverBars(
  items: readonly CoverItemView[],
  today: string | undefined,
): (CoverBar | null)[] {
  if (!today) return items.map(() => null);
  const days = items.map((i) =>
    i.runs_out
      ? {
          low: Math.max(0, daysFrom(today, i.runs_out.earliest)),
          high: i.runs_out.latest === null ? null : Math.max(0, daysFrom(today, i.runs_out.latest)),
        }
      : null,
  );
  const top = Math.max(
    0,
    ...items.flatMap((item, k) => {
      const d = days[k];
      return d ? [d.low, d.high ?? 0, item.lead.days] : [];
    }),
  );
  if (top <= 0) return items.map(() => null);
  const longestLead = Math.max(0, ...items.map((i) => i.lead.days));
  // A shelf of slow stock would squeeze every at-risk bar to a sliver.
  const scale = longestLead > 0 ? Math.min(top, longestLead * COVER_SCALE_LEADS) : top;
  const on = (d: number) => Math.min(1, d / scale);
  return items.map((item, k) => {
    const d = days[k];
    if (!d) return null;
    return {
      low: on(d.low),
      high: d.high === null ? null : on(d.high),
      lead: on(Math.max(0, item.lead.days)),
      tone: item.flag === "ACT NOW" || item.flag === "RUNNING LOW" ? "drift" : "ink",
    };
  });
}

export interface CashBar {
  /** 0–1 of the most cash tied up in the same currency. */
  share: number;
  /** Hollow when the value rests on the owner's stated cost. */
  tone: "ink" | "hollow";
}

/** Pure: each slow item's cash tied up against the largest in its own currency (rule 1); null where unknown. */
export function cashBars(items: readonly StockItemView[]): (CashBar | null)[] {
  const top = new Map<string, number>();
  for (const i of items) {
    if (i.cash_tied_minor === null || i.currency === null) continue;
    top.set(i.currency, Math.max(top.get(i.currency) ?? 0, i.cash_tied_minor));
  }
  return items.map((i) => {
    if (i.cash_tied_minor === null || i.currency === null) return null;
    const max = top.get(i.currency) ?? 0;
    if (max <= 0) return null;
    return {
      share: Math.max(0, i.cash_tied_minor) / max, // not money: a bar's width
      tone: i.cost_basis === "stated" ? "hollow" : "ink",
    };
  });
}

/** A reorder note's cost, in its own currency: "€2,802.80 at cost". */
export function moneyLine(
  m: { amount_minor: number; currency: string },
  w: StockWords = ENGLISH(),
): string {
  return w.tr("view.atCost", { amount: moneyText(m.amount_minor, m.currency, w.locale) });
}
