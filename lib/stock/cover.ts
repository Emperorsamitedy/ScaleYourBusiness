// Stock: what runs out, and when — Phase 5 Session A (P5-01, P5-02, P5-04
// and the arithmetic of P5-03). Pure: no database, no clock, no model.
//
//   sell-through  the last N days against the N before, per item: units in
//                 each window, the change, and its noise band. Under a
//                 Poisson reading of counts the difference of two windows
//                 has variance A + B, so a change inside ±2√(A + B) is
//                 chance, and says so.
//   rate          units in the last N days ÷ N, as a range: the count ± one
//                 standard deviation (√count). Never a single point (rule 25).
//   cover         stock on hand ÷ the rate, as a range: the fast end of the
//                 rate gives the low end of cover. Counted from the day the
//                 stock was read, so a count taken days ago has kept selling.
//   warning       cover's low end below the supplier's delivery time (1.4.1.3
//                 "Delivery time in days", else COVER.default_lead_days,
//                 marked ASSUMED). ACT NOW when even the high end is below.
//   season        an approaching busy stretch (lib/seasons) raises the rate
//                 for the days it covers: the stretch's index against the
//                 business's last four weeks, never below 1×, and stated.
//   reorder       sales over the delivery time at the fast end of the rate
//                 (the safety margin is the gap to the middle), rounded up to
//                 the supplier's minimum order quantity, with the arithmetic.
//
// Windows end yesterday (today is never a whole day), as in ./assess. Below
// one whole window of history it refuses, saying how much there is, what it
// can and can't say, and when it will be ready. Nothing here borrows a rate,
// a season or a lead time from anyone else's business (rule 25), and nothing
// here can place, edit or cancel an order (rule 27): the reorder is a number
// and its arithmetic, for a note the owner may approve.
//
// L-4b: every sentence here is the "stockWords" catalogue through optional
// words (./words), English by default, figures in the reader's language.
// The screen's handler passes the request's words; what is stored (reorder
// notes, the watch log, forecast claims) is built with the default.

import { money } from "../core/money";
import type { Money } from "../core/money";
import { intlTag } from "../i18n/locales";
import { rangeOf as rangeWords } from "../i18n/range";
import type { SeasonResult } from "../seasons/forecast";
import type { StockItem } from "./assess";
import { shiftDay } from "./assess";
import type { Words } from "./words";
import {
  dayCount,
  dec1,
  englishStock,
  exactMoney,
  int,
  isoDay,
  orList,
  shortDay,
  timesIn,
} from "./words";

export const COVER = {
  /** N: the recent window, and the one before it. Four whole weeks, so weekdays balance. */
  window_days: 28,
  /** The rate's range: the recent count ± this many standard deviations (√count). */
  rate_sigmas: 1,
  /** Sell-through: a change inside ± this many standard deviations of the difference is chance. */
  change_sigmas: 2,
  /** ASSUMED when no supplier's delivery time is on file for an item. */
  default_lead_days: 14,
  /** Cover past this many days is "over a year": a slow-stock question, not a stock-out one. */
  max_cover_days: 365,
  /** The recent weeks a busy stretch is set against. */
  recent_weeks: 4,
} as const;

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** "Midland Clay Supplies' " / "Nore Valley's ". */
export function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

/** "14.9" — a rate a day, one decimal. */
export function perDayText(x: number): string {
  return (Math.round(x * 10) / 10).toFixed(1);
}

/* ── P5-01: two-window sell-through ── */

export interface SalesWindow {
  from: string;
  to: string;
  units: number;
}

export type SellThrough =
  | {
      status: "ready";
      window_days: number;
      /** Window A: the last N days, ending yesterday. */
      a: SalesWindow;
      /** Window B: the N days before A. */
      b: SalesWindow;
      change: number;
      /** A against B in whole percent; null when B sold nothing. */
      change_pct: number | null;
      /** ± this many units is chance (COVER.change_sigmas × √(A + B)), rounded up. */
      band: number;
      direction: "up" | "down" | "flat";
      sentence: string;
    }
  | {
      status: "too_little";
      covered_days: number;
      needed_days: number;
      /** When two whole windows will have been measured, if syncs keep running. */
      ready_on: string | null;
      sentence: string;
    };

function unitsIn(daily: ReadonlyMap<string, number>, from: string, to: string): number {
  let units = 0;
  for (const [day, u] of daily) if (day >= from && day <= to) units += u;
  return units;
}

/** Pure: the last N days against the N before, as of `today` (windows end yesterday). */
export function sellThrough(
  item: Pick<StockItem, "sales">,
  today: string,
  n: number = COVER.window_days,
  w: Words = englishStock(),
): SellThrough {
  const { tr, locale } = w;
  const nText = int(n, locale);
  const needed = 2 * n;
  if (item.sales.kind === "file") {
    return {
      status: "too_little",
      covered_days: item.sales.window_days ?? 0,
      needed_days: needed,
      ready_on: null,
      sentence: tr("sell.fileOneWindow", { n: nText }),
    };
  }
  const s = item.sales;
  if (s.covered_days < needed) {
    const ready = shiftDay(today, needed - s.covered_days);
    return {
      status: "too_little",
      covered_days: s.covered_days,
      needed_days: needed,
      ready_on: ready,
      sentence: tr("sell.tooLittle", {
        ...dayCount(s.covered_days, locale),
        n: nText,
        needed: int(needed, locale),
        ready: isoDay(ready, locale),
      }),
    };
  }
  const end = shiftDay(today, -1);
  const aFrom = shiftDay(end, -(n - 1));
  const bTo = shiftDay(aFrom, -1);
  const bFrom = shiftDay(bTo, -(n - 1));
  const a = unitsIn(s.daily, aFrom, end);
  const b = unitsIn(s.daily, bFrom, bTo);
  const change = a - b;
  const band = Math.ceil(COVER.change_sigmas * Math.sqrt(a + b));
  const direction = change > band ? "up" : change < -band ? "down" : "flat";
  const pct = b > 0 ? Math.round((100 * change) / b) : null;
  const head = {
    a: int(a, locale),
    b: int(b, locale),
    n: nText,
    diff: int(Math.abs(change), locale),
    band: int(band, locale),
  };
  const sentence =
    a + b === 0
      ? tr("sell.nothing", { n: nText })
      : direction === "flat"
        ? tr("sell.flat", head)
        : pct === null
          ? tr("sell.moved", { ...head, direction })
          : tr("sell.movedPct", { ...head, direction, pct: signedPct(pct, locale) });
  return {
    status: "ready",
    window_days: n,
    a: { from: aFrom, to: end, units: a },
    b: { from: bFrom, to: bTo, units: b },
    change,
    change_pct: pct,
    band,
    direction,
    sentence,
  };
}

/** "+12%" / "-8%": a change in whole percent, its sign shown. */
function signedPct(pct: number, locale: Words["locale"]): string {
  if (locale === "en") return `${pct > 0 ? "+" : ""}${pct}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    maximumFractionDigits: 0,
    signDisplay: "exceptZero",
  }).format(pct / 100);
}

/* ── P5-02: the recent rate, as a range ── */

export interface RateRange {
  /** Units a day: the middle, and the range allowing for chance. */
  per_day: number;
  low: number;
  high: number;
  units: number;
  over_days: number;
  /** The days it was read over; `from` is null for a file's window. */
  from: string | null;
  to: string;
  basis: "measured" | "file";
}

export type RateResult =
  | { status: "ready"; rate: RateRange }
  | {
      status: "too_little";
      covered_days: number;
      needed_days: number;
      ready_on: string | null;
      sentence: string;
    }
  | { status: "no_sales"; over_days: number; sentence: string };

function rangeOf(units: number, over: number) {
  const sd = COVER.rate_sigmas * Math.sqrt(units);
  return {
    per_day: units / over,
    low: Math.max(0, units - sd) / over,
    high: (units + sd) / over,
  };
}

/** Pure: the item's recent daily rate of sale, as a range. */
export function recentRate(
  item: Pick<StockItem, "sales" | "as_of">,
  today: string,
  w: Words = englishStock(),
): RateResult {
  const { tr, locale } = w;
  const n = COVER.window_days;
  const nText = int(n, locale);
  if (item.sales.kind === "file") {
    const f = item.sales;
    if (f.window_days === null || f.units_in_window === null) {
      return {
        status: "too_little",
        covered_days: 0,
        needed_days: n,
        ready_on: null,
        sentence: tr("rate.fileNoColumn", { n: nText }),
      };
    }
    if (f.window_days < n) {
      return {
        status: "too_little",
        covered_days: f.window_days,
        needed_days: n,
        ready_on: null,
        sentence: tr("rate.fileShort", { ...dayCount(f.window_days, locale), n: nText }),
      };
    }
    if (f.units_in_window === 0) {
      return {
        status: "no_sales",
        over_days: f.window_days,
        sentence: tr("rate.fileNoSales", { days: int(f.window_days, locale) }),
      };
    }
    return {
      status: "ready",
      rate: {
        ...rangeOf(f.units_in_window, f.window_days),
        units: f.units_in_window,
        over_days: f.window_days,
        from: null,
        to: item.as_of,
        basis: "file",
      },
    };
  }
  const s = item.sales;
  if (s.covered_days < n) {
    const ready = shiftDay(today, n - s.covered_days);
    return {
      status: "too_little",
      covered_days: s.covered_days,
      needed_days: n,
      ready_on: ready,
      sentence: tr("rate.tooLittle", {
        ...dayCount(s.covered_days, locale),
        n: nText,
        ready: isoDay(ready, locale),
      }),
    };
  }
  const end = shiftDay(today, -1);
  const from = shiftDay(end, -(n - 1));
  const units = unitsIn(s.daily, from, end);
  if (units === 0) {
    return {
      status: "no_sales",
      over_days: n,
      sentence: tr("rate.noSales", { n: nText }),
    };
  }
  return {
    status: "ready",
    rate: { ...rangeOf(units, n), units, over_days: n, from, to: end, basis: "measured" },
  };
}

/* ── P5-04: an approaching busy stretch raises the rate for its days ── */

export interface SeasonBoost {
  /** Days from today the stretch starts (0 = under way) and ends (exclusive). */
  from_day: number;
  to_day: number;
  starts_on: string;
  ends_on: string;
  in_progress: boolean;
  /** The multiple on the item's recent rate, never below 1×. */
  multiple: { low: number; mid: number; high: number };
  /** Last year's stretch against the normal week, and the recent weeks against it. */
  stretch_index: number;
  recent_index: number | null;
  /** The season's own series, for the sources line ("revenue from Shopify"). */
  read_from: string;
  sentence: string;
}

/**
 * Pure: the first busy stretch the season forecast sees coming (or under
 * way), as a multiple on the recent rate. The stretch ran `index` × the
 * normal week last year; the last four complete weeks ran `recent` × it, so
 * the recent rate already holds `recent` and the stretch adds index ÷ recent.
 * Null when the forecast isn't ready or sees no busy stretch ahead.
 */
export function seasonBoost(
  result: SeasonResult | null,
  today: string,
  w: Words = englishStock(),
): SeasonBoost | null {
  const { tr, locale } = w;
  if (result === null || result.status !== "ready") return null;
  const next = result.upcoming.find((u) => u.run.kind === "busy");
  if (!next) return null;
  const to = daysBetween(today, next.ends_on) + 1;
  if (to <= 0) return null;
  const from = Math.max(0, daysBetween(today, next.starts_on));
  const recentWeeks = result.weeks
    .filter((w) => w.start >= shiftDay(today, -(7 * COVER.recent_weeks + 6)))
    .slice(-COVER.recent_weeks);
  const recent =
    recentWeeks.length > 0
      ? recentWeeks.reduce((s, w) => s + w.index, 0) / recentWeeks.length
      : null;
  const against = recent !== null && recent > 0 ? recent : 1;
  const run = next.run;
  const ends = [run.low / against, run.index / against, (run.high ?? run.index) / against]
    .map((x) => Math.max(1, x))
    .sort((a, b) => a - b) as [number, number, number];
  const multiple = { low: ends[0], mid: ends[1], high: ends[2] };
  const when =
    next.in_progress || next.starts_on < today
      ? tr("season.underWay", { end: shortDay(next.ends_on, locale) })
      : from === 0
        ? tr("season.startsToday", { end: shortDay(next.ends_on, locale) })
        : tr("season.startsIn", {
            ...dayCount(from, locale),
            start: shortDay(next.starts_on, locale),
          });
  const against_text =
    recent === null
      ? tr("season.againstNone")
      : tr("season.againstRecent", {
          count: recentWeeks.length,
          weeks: int(recentWeeks.length, locale),
          recent: timesIn(recent, locale),
        });
  const counted =
    multiple.mid <= 1
      ? tr("season.addsNothing")
      : tr("season.counts", { multiple: timesIn(multiple.mid, locale) });
  return {
    from_day: from,
    to_day: to,
    starts_on: next.starts_on,
    ends_on: next.ends_on,
    in_progress: next.in_progress,
    multiple,
    stretch_index: run.index,
    recent_index: recent,
    read_from: tr("season.readFrom", { noun: result.series.noun, source: result.series.source }),
    sentence: tr("season.sentence", {
      when,
      index: timesIn(run.index, locale),
      against: against_text,
      counted,
    }),
  };
}

/* ── the piecewise arithmetic ── */

interface Pace {
  per_day: number;
  boost: Pick<SeasonBoost, "from_day" | "to_day"> | null;
  multiple: number;
}

/** Units sold between day t0 and day t1 (days from the anchor), at the pace. */
export function demandBetween(t0: number, t1: number, pace: Pace): number {
  if (t1 <= t0 || pace.per_day <= 0) return 0;
  const b = pace.boost;
  if (b === null || pace.multiple === 1) return (t1 - t0) * pace.per_day;
  const inside = Math.max(0, Math.min(t1, b.to_day) - Math.max(t0, b.from_day));
  return (t1 - t0 - inside) * pace.per_day + inside * pace.per_day * pace.multiple;
}

/** Days until `onHand` is sold at the pace, capped at COVER.max_cover_days; null with no pace. */
export function coverDays(onHand: number, pace: Pace): number | null {
  if (pace.per_day <= 0) return null;
  if (onHand <= 0) return 0;
  const b = pace.boost;
  const segments: [number, number, number][] =
    b === null || pace.multiple === 1
      ? [[0, Infinity, pace.per_day]]
      : [
          [0, b.from_day, pace.per_day],
          [b.from_day, b.to_day, pace.per_day * pace.multiple],
          [b.to_day, Infinity, pace.per_day],
        ];
  let left = onHand;
  for (const [start, end, rate] of segments) {
    if (end <= start) continue;
    const can = (end - start) * rate;
    if (left <= can) return Math.min(COVER.max_cover_days, start + left / rate);
    left -= can;
  }
  return COVER.max_cover_days;
}

/* ── delivery time and minimum order, from 1.4.1.3 ── */

export interface SupplierInfo {
  id: string;
  name: string;
  /** "Delivery time in days", when answered. */
  lead_time_days: number | null;
  /** "Minimum order quantity", when answered. */
  moq: number | null;
  /** The offers the owner said this supplier supplies. */
  offer_ids: readonly string[];
  /** "Typical purchase price" (1.4.1.3), as answered: a stated price, when the owner gave one. */
  purchase_price?: Money | null;
}

export interface LeadTime {
  days: number;
  basis: "stated" | "assumed";
  supplier: { id: string; name: string } | null;
  /** The fact it came from (rule 6), when stated. */
  source_field: string | null;
  moq: number | null;
  moq_field: string | null;
  /** Where the number came from, in words. */
  why: string;
}

const usable = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;

/**
 * Pure: the item's delivery time. The owner's suppliers for the matched
 * offer, the longest stated time among them (an item can't be restocked
 * before its slowest input arrives) and that supplier's minimum order; else
 * COVER.default_lead_days, ASSUMED, saying why.
 */
export function leadTimeFor(
  item: Pick<StockItem, "offer_id">,
  suppliers: readonly SupplierInfo[],
  w: Words = englishStock(),
): LeadTime {
  const { tr, locale } = w;
  const mine = item.offer_id
    ? suppliers.filter((s) => s.offer_ids.includes(item.offer_id as string))
    : [];
  const stated = mine
    .filter((s) => usable(s.lead_time_days))
    .sort((a, b) => b.lead_time_days! - a.lead_time_days! || (a.name < b.name ? -1 : 1));
  const pick = stated[0];
  if (pick) {
    const moq = usable(pick.moq) ? Math.ceil(pick.moq) : null;
    return {
      days: pick.lead_time_days!,
      basis: "stated",
      supplier: { id: pick.id, name: pick.name },
      source_field: `suppliers.${pick.id}.lead_time_days`,
      moq,
      moq_field: moq === null ? null : `suppliers.${pick.id}.moq`,
      why:
        stated.length > 1
          ? tr("lead.longest", {
              supplier: pick.name,
              ...dayCount(pick.lead_time_days!, locale),
              suppliers: int(stated.length, locale),
            })
          : tr("lead.answer", { supplier: pick.name, ...dayCount(pick.lead_time_days!, locale) }),
    };
  }
  const reason =
    mine.length > 0
      ? tr("lead.noTimeFor", {
          suppliers: orList(
            mine.map((s) => s.name),
            locale,
          ),
        })
      : item.offer_id
        ? tr("lead.noSupplier")
        : tr("lead.unmatched");
  return {
    days: COVER.default_lead_days,
    basis: "assumed",
    supplier: null,
    source_field: null,
    moq: null,
    moq_field: null,
    why: tr("lead.assumed", { days: int(COVER.default_lead_days, locale), reason }),
  };
}

/* ── P5-03's arithmetic: how much to reorder ── */

export interface ReorderSuggestion {
  quantity: number;
  /** Units the delivery time is expected to sell, low–high. */
  lead_demand: { low: number; mid: number; high: number };
  /** The fast end over the middle, in whole units. */
  safety: number;
  before_moq: number;
  moq: number | null;
  rounded_to_moq: boolean;
  arithmetic: string;
  /** At the item's own unit cost, when the stock read carries one (rule 1). */
  cost: Money | null;
  cost_basis: "measured" | "stated" | null;
  cost_arithmetic: string | null;
}

/** Pure: sales over the delivery time + a safety margin, rounded up to the minimum order. */
export function reorderFor(
  item: Pick<StockItem, "on_hand" | "value_at_cost" | "currency" | "cost_basis">,
  rate: RateRange,
  lead: LeadTime,
  boost: SeasonBoost | null,
  w: Words = englishStock(),
): ReorderSuggestion {
  const { tr, locale } = w;
  const at = (perDay: number, m: number) =>
    demandBetween(0, lead.days, { per_day: perDay, boost, multiple: m });
  const m = boost?.multiple ?? { low: 1, mid: 1, high: 1 };
  const demand = {
    low: at(rate.low, m.low),
    mid: at(rate.per_day, m.mid),
    high: at(rate.high, m.high),
  };
  const mid = Math.ceil(demand.mid);
  const before = Math.max(1, Math.ceil(demand.high));
  const safety = before - mid;
  const moq = lead.moq;
  const rounded = moq !== null && before < moq;
  const quantity = rounded ? moq : before;
  const seasonal = boost !== null && demand.mid > rate.per_day * lead.days + 1e-9;
  const supplier = lead.supplier?.name ?? null;
  // The English possessive (possessive above): which ending the supplier's name takes.
  const named = supplier === null ? {} : { supplier, ends: supplier.endsWith("s") ? "s" : "other" };
  const moqText =
    moq === null
      ? tr("reorder.moqNone")
      : tr(`reorder.${rounded ? "moqRounded" : "moqOver"}${supplier === null ? "Unnamed" : ""}`, {
          ...named,
          moq: int(moq, locale),
        });
  const arithmetic = tr(seasonal ? "reorder.arithmeticSeason" : "reorder.arithmetic", {
    rate: dec1(rate.per_day, locale),
    high: dec1(rate.high, locale),
    ...dayCount(lead.days, locale),
    ...(seasonal ? { multiple: timesIn(m.mid, locale) } : {}),
    mid: int(mid, locale),
    safety: int(safety, locale),
    before: int(before, locale),
    moq: moqText,
  });

  let cost: Money | null = null;
  let costText: string | null = null;
  if (item.value_at_cost !== null && item.currency !== null && item.on_hand > 0) {
    const unit = Math.round(item.value_at_cost / item.on_hand);
    cost = money(unit * quantity, item.currency);
    costText = tr(item.cost_basis === "stated" ? "reorder.costStated" : "reorder.cost", {
      quantity: int(quantity, locale),
      unit: exactMoney(unit, item.currency, locale),
      total: exactMoney(cost.amount_minor, cost.currency, locale),
    });
  }
  return {
    quantity,
    lead_demand: demand,
    safety,
    before_moq: before,
    moq,
    rounded_to_moq: rounded,
    arithmetic,
    cost,
    cost_basis: cost === null ? null : item.cost_basis,
    cost_arithmetic: costText,
  };
}

/* ── P5-02: cover and the warning, per item ── */

export type CoverLevel = "before_restock" | "tight";

export interface StockWarning {
  level: CoverLevel;
  /** The worded flag: colour never carries it alone. */
  flag: "ACT NOW" | "RUNNING LOW";
  sentence: string;
  /** The sentence's first clause on its own, as a line: "Mug runs out in about 4–6 days." */
  head: string;
}

export interface CoverAssessment {
  status: "ready" | "too_little" | "no_sales";
  /**
   * None on hand. Shown as SOLD OUT, never warned or reordered: the shop
   * already shows it, a planned sell-out (a monthly drop) looks the same,
   * and SYB can't see whether more is already on order.
   */
  sold_out: boolean;
  sell_through: SellThrough;
  rate: RateRange | null;
  /** Days from today until it runs out: the fast end, the middle, the slow end (null: no upper bound). */
  cover: { low: number; mid: number; high: number | null } | null;
  runs_out: { earliest: string; latest: string | null } | null;
  lead: LeadTime;
  boost: SeasonBoost | null;
  /** Did the busy stretch change the numbers? */
  boosted: boolean;
  warning: StockWarning | null;
  reorder: ReorderSuggestion | null;
  /** Named assumptions (rule 25). */
  assumed: string[];
  /** The history window and its sources, in words (rule 25). */
  sources: string;
  /** Why it isn't judged, when it isn't. */
  why: string | null;
}

/**
 * Pure: the cover range in whole days, never collapsed to one point (rule
 * 25): rounded, and widened to the floor and ceiling when rounding would
 * make the two ends meet.
 */
export function wholeDays(c: { low: number; high: number }): [number, number] {
  const lo = Math.round(c.low);
  const hi = Math.round(c.high);
  if (lo !== hi) return [lo, hi];
  const f = Math.floor(c.low);
  const ce = Math.ceil(c.high);
  return f === ce ? [f, f + 1] : [f, ce];
}

function coverRangeText(c: { low: number; high: number | null }, w: Words): string {
  const { tr, locale } = w;
  if (c.high === null) return tr("warning.rangeOpen", dayCount(Math.round(c.low), locale));
  const [lo, hi] = wholeDays({ low: c.low, high: c.high });
  return tr("warning.rangeClosed", { low: int(lo, locale), high: int(hi, locale) });
}

/** "Midland Clay Supplies takes 10 days" / "a delivery takes 14 days (ASSUMED)". */
function leadPhrase(lead: LeadTime, w: Words): string {
  const { tr, locale } = w;
  return lead.supplier
    ? tr("lead.phraseNamed", { supplier: lead.supplier.name, ...dayCount(lead.days, locale) })
    : tr("lead.phraseAssumed", dayCount(lead.days, locale));
}

/**
 * Pure: days of cover and the stock-out warning for one item, as of
 * `today`, against its delivery time and any busy stretch ahead.
 */
export function assessCover(
  item: StockItem,
  today: string,
  lead: LeadTime,
  boost: SeasonBoost | null,
  sourceLabel: string,
  w: Words = englishStock(),
): CoverAssessment {
  const { tr, locale } = w;
  const st = sellThrough(item, today, COVER.window_days, w);
  const r = recentRate(item, today, w);
  const base = {
    sold_out: item.on_hand <= 0,
    sell_through: st,
    lead,
    boost,
    boosted: false,
    reorder: null,
    warning: null,
  };
  const leadLine = tr("lead.line", { why: lead.why });
  const onHand = int(item.on_hand, locale);
  const asOf = isoDay(item.as_of, locale);
  if (r.status !== "ready") {
    return {
      ...base,
      status: r.status,
      rate: null,
      cover: null,
      runs_out: null,
      assumed: [],
      sources: tr("cover.sourcesOnHand", { onHand, source: sourceLabel, day: asOf }),
      why: r.sentence,
    };
  }
  const rate = r.rate;
  // The count was taken `elapsed` days ago and has kept selling since.
  const elapsed = Math.max(0, daysBetween(item.as_of, today));
  const shifted = boost
    ? { from_day: boost.from_day + elapsed, to_day: boost.to_day + elapsed }
    : null;
  const m = boost?.multiple ?? { low: 1, mid: 1, high: 1 };
  const fromToday = (perDay: number, mult: number) => {
    const d = coverDays(item.on_hand, { per_day: perDay, boost: shifted, multiple: mult });
    return d === null ? null : Math.max(0, d - elapsed);
  };
  const low = fromToday(rate.high, m.high) ?? 0;
  const mid = fromToday(rate.per_day, m.mid) ?? 0;
  const high = rate.low > 0 ? fromToday(rate.low, m.low) : null;
  const plain = coverDays(item.on_hand, { per_day: rate.high, boost: null, multiple: 1 });
  const boosted = boost !== null && plain !== null && Math.max(0, plain - elapsed) - low > 0.05;
  const cover = { low, mid, high };
  const runsOut = {
    earliest: shiftDay(today, Math.floor(low)),
    latest: high === null ? null : shiftDay(today, Math.floor(high)),
  };

  const units = int(rate.units, locale);
  const assumed = [
    tr("cover.assumedPace", {
      ...dayCount(rate.over_days, locale),
      units,
      band: int(Math.round(Math.sqrt(rate.units)), locale),
    }),
  ];
  if (lead.basis === "assumed") assumed.push(tr("cover.assumedLead", { why: lead.why }));
  if (boosted) assumed.push(tr("cover.assumedSeason", { readFrom: boost!.read_from }));
  if (elapsed > 0) {
    assumed.push(tr("cover.assumedElapsed", { day: asOf, ...dayCount(elapsed, locale) }));
  }
  const window =
    rate.from === null
      ? tr("cover.windowFile", {
          units,
          days: int(rate.over_days, locale),
          to: isoDay(rate.to, locale),
        })
      : tr("cover.windowMeasured", {
          units,
          from: isoDay(rate.from, locale),
          to: isoDay(rate.to, locale),
          source: sourceLabel,
        });
  const sources = boosted
    ? tr("cover.sourcesSeason", {
        window,
        onHand,
        day: asOf,
        lead: leadLine,
        readFrom: boost!.read_from,
      })
    : tr("cover.sources", { window, onHand, day: asOf, lead: leadLine });

  let warning: StockWarning | null = null;
  if (item.on_hand > 0 && low < lead.days) {
    const before = high !== null && high < lead.days;
    const said = { name: item.name, range: coverRangeText(cover, w), lead: leadPhrase(lead, w) };
    warning = {
      level: before ? "before_restock" : "tight",
      flag: before ? "ACT NOW" : "RUNNING LOW",
      sentence: !boosted
        ? tr("warning.sentence", said)
        : boost!.from_day === 0
          ? tr("warning.sentenceInStretch", { ...said, end: shortDay(boost!.ends_on, locale) })
          : tr("warning.sentenceFromStretch", {
              ...said,
              start: shortDay(boost!.starts_on, locale),
            }),
      head: tr("warning.head", { name: said.name, range: said.range }),
    };
  }
  return {
    ...base,
    status: "ready",
    rate,
    cover,
    runs_out: runsOut,
    boosted,
    warning,
    reorder: warning ? reorderFor(item, rate, lead, boost, w) : null,
    assumed,
    sources,
    why: null,
  };
}

/** Pure: the cover column's text ("9 to 10", "365+", "sold out", "-"). */
export function coverColumn(c: CoverAssessment, w: Words = englishStock()): string {
  const { tr, locale } = w;
  if (c.sold_out) return tr("cover.colSoldOut");
  if (c.cover === null) return c.status === "no_sales" ? tr("cover.colNoSales") : "-";
  const lo = Math.round(c.cover.low);
  const max = int(COVER.max_cover_days, locale);
  if (lo >= COVER.max_cover_days) return `${max}+`;
  if (c.cover.high === null) return `${int(lo, locale)}+`;
  if (Math.round(c.cover.high) >= COVER.max_cover_days) return rangeWords(int(lo, locale), `${max}+`, locale);
  const [a, b] = wholeDays({ low: c.cover.low, high: c.cover.high });
  return rangeWords(int(a, locale), int(b, locale), locale);
}

/** Pure: the warned items, ACT NOW first, then the soonest out. */
export function rankWarnings<T extends { name: string; cover: CoverAssessment }>(
  rows: readonly T[],
): T[] {
  const order: Record<CoverLevel, number> = { before_restock: 0, tight: 1 };
  return rows
    .filter((r) => r.cover.warning !== null)
    .sort(
      (a, b) =>
        order[a.cover.warning!.level] - order[b.cover.warning!.level] ||
        (a.cover.cover?.low ?? 0) - (b.cover.cover?.low ?? 0) ||
        (a.name < b.name ? -1 : 1),
    );
}

export type CoverFlag =
  "ACT NOW" | "RUNNING LOW" | "IN RANGE" | "SOLD OUT" | "NO SALES" | "TOO EARLY";

/** Pure: the worded flag of the cover column (colour never carries it alone). */
export function coverFlag(c: CoverAssessment): CoverFlag {
  if (c.sold_out) return "SOLD OUT";
  if (c.warning) return c.warning.flag;
  if (c.status === "no_sales") return "NO SALES";
  if (c.status === "too_little") return "TOO EARLY";
  return "IN RANGE";
}
