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

import { format, money } from "../core/money";
import type { Money } from "../core/money";
import type { SeasonResult } from "../seasons/forecast";
import { times } from "../seasons/forecast";
import type { StockItem } from "./assess";
import { shiftDay } from "./assess";

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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "14.9" — a rate a day, one decimal. */
export function perDayText(x: number): string {
  return (Math.round(x * 10) / 10).toFixed(1);
}

/** "2 Nov" — a short date, in UTC (the series' own dates). */
function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
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
): SellThrough {
  const needed = 2 * n;
  if (item.sales.kind === "file") {
    return {
      status: "too_little",
      covered_days: item.sales.window_days ?? 0,
      needed_days: needed,
      ready_on: null,
      sentence: `A stock file carries one window of units sold, so I can't set ${n} days against the ${n} before. Connect the shop and I can.`,
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
      sentence: `Only ${plural(s.covered_days, "day")} of sales measured; comparing two ${n}-day windows needs ${needed}. I can say what sold; I can't say whether it's speeding up until ${ready}.`,
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
  const head = `${a} sold in the last ${n} days against ${b} in the ${n} before`;
  const sentence =
    a + b === 0
      ? `Nothing sold in either ${n}-day window.`
      : direction === "flat"
        ? `${head}: about the same — a difference of ${Math.abs(change)} is within chance (±${band}).`
        : `${head}: ${direction} ${Math.abs(change)}${pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""}, more than chance (±${band}).`;
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
export function recentRate(item: Pick<StockItem, "sales" | "as_of">, today: string): RateResult {
  const n = COVER.window_days;
  if (item.sales.kind === "file") {
    const f = item.sales;
    if (f.window_days === null || f.units_in_window === null) {
      return {
        status: "too_little",
        covered_days: 0,
        needed_days: n,
        ready_on: null,
        sentence: `The stock file has no units-sold column, so I can't say when anything runs out. A file with units sold over ${n} days or more can.`,
      };
    }
    if (f.window_days < n) {
      return {
        status: "too_little",
        covered_days: f.window_days,
        needed_days: n,
        ready_on: null,
        sentence: `The file's units sold cover ${plural(f.window_days, "day")}; days of cover needs ${n}. A file over ${n} days or more can say when stock runs out.`,
      };
    }
    if (f.units_in_window === 0) {
      return {
        status: "no_sales",
        over_days: f.window_days,
        sentence: `No sale in the file's ${f.window_days} days: nothing to run out at.`,
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
      sentence: `Only ${plural(s.covered_days, "day")} of sales measured; days of cover needs ${n}. I can say what's on hand; I can't say when it runs out until ${ready}.`,
    };
  }
  const end = shiftDay(today, -1);
  const from = shiftDay(end, -(n - 1));
  const units = unitsIn(s.daily, from, end);
  if (units === 0) {
    return {
      status: "no_sales",
      over_days: n,
      sentence: `No sale in the last ${n} days: nothing to run out at.`,
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
export function seasonBoost(result: SeasonResult | null, today: string): SeasonBoost | null {
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
  const when = next.in_progress
    ? `is under way now, to ${shortDay(next.ends_on)}`
    : `starts ${from === 0 ? "today" : `in ${plural(from, "day")}`}, on ${shortDay(next.starts_on)}`;
  const against_text =
    recent === null
      ? "I have no complete recent week to set it against, so I count it against your normal week"
      : `your last ${plural(recentWeeks.length, "week")} ran ${times(recent)}`;
  const counted =
    multiple.mid <= 1
      ? "so your recent pace already holds it and I add nothing"
      : `so I count ${times(multiple.mid)} your recent pace for those days`;
  return {
    from_day: from,
    to_day: to,
    starts_on: next.starts_on,
    ends_on: next.ends_on,
    in_progress: next.in_progress,
    multiple,
    stretch_index: run.index,
    recent_index: recent,
    read_from: `${result.series.noun} from ${result.series.source}`,
    sentence: `Your busy stretch ${when}: last year it ran ${times(run.index)} your normal week; ${against_text}, ${counted}.`,
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
): LeadTime {
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
          ? `${pick.name} takes ${plural(pick.lead_time_days!, "day")}, the longest of the ${stated.length} suppliers you named for it`
          : `${pick.name} takes ${plural(pick.lead_time_days!, "day")}, from your answer`,
    };
  }
  const reason =
    mine.length > 0
      ? `no delivery time on file for ${mine.map((s) => s.name).join(" or ")}`
      : item.offer_id
        ? "no supplier on file for this item"
        : "this item isn't matched to one of your products, so I can't tell its supplier";
  return {
    days: COVER.default_lead_days,
    basis: "assumed",
    supplier: null,
    source_field: null,
    moq: null,
    moq_field: null,
    why: `${COVER.default_lead_days} days, ASSUMED: ${reason}`,
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
): ReorderSuggestion {
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
  const who = lead.supplier?.name ?? "the supplier";
  const seasonal = boost !== null && demand.mid > rate.per_day * lead.days + 1e-9;
  const moqText =
    moq === null
      ? "; no minimum order on file"
      : rounded
        ? `; ${who}'s minimum order is ${moq}, so ${moq}`
        : `; over ${who}'s minimum order of ${moq}`;
  const arithmetic =
    `${perDayText(rate.per_day)} a day (up to ${perDayText(rate.high)}) over ${plural(lead.days, "day")}` +
    `${seasonal ? `, with the busy stretch at ${times(m.mid)}` : ""} = ${mid}, ` +
    `+ ${safety} safety margin (the fast end of the range) = ${before}${moqText}.`;

  let cost: Money | null = null;
  let costText: string | null = null;
  if (item.value_at_cost !== null && item.currency !== null && item.on_hand > 0) {
    const unit = Math.round(item.value_at_cost / item.on_hand);
    cost = money(unit * quantity, item.currency);
    costText = `${quantity} × ${format(money(unit, item.currency))} at cost${item.cost_basis === "stated" ? " (your own cost for the product)" : ""} = ${format(cost)}`;
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

export type CoverLevel = "out" | "before_restock" | "tight";

export interface StockWarning {
  level: CoverLevel;
  /** The worded flag: colour never carries it alone. */
  flag: "ACT NOW" | "RUNNING LOW";
  sentence: string;
}

export interface CoverAssessment {
  status: "ready" | "too_little" | "no_sales";
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

function coverRangeText(c: { low: number; high: number | null }): string {
  const lo = Math.round(c.low);
  if (c.high === null) return `about ${plural(lo, "day")} or more`;
  const hi = Math.round(c.high);
  return lo === hi ? `about ${plural(lo, "day")}` : `about ${lo}–${hi} days`;
}

/** "Midland Clay Supplies takes 10 days" / "a delivery takes 14 days (ASSUMED)". */
function leadPhrase(lead: LeadTime): string {
  return lead.supplier
    ? `${lead.supplier.name} takes ${plural(lead.days, "day")}`
    : `a delivery takes ${plural(lead.days, "day")} (ASSUMED)`;
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
): CoverAssessment {
  const st = sellThrough(item, today);
  const r = recentRate(item, today);
  const base = {
    sell_through: st,
    lead,
    boost,
    boosted: false,
    reorder: null,
    warning: null,
  };
  const leadLine = `delivery time: ${lead.why}`;
  if (r.status !== "ready") {
    return {
      ...base,
      status: r.status,
      rate: null,
      cover: null,
      runs_out: null,
      assumed: [],
      sources: `${item.on_hand} on hand, read from ${sourceLabel} on ${item.as_of}`,
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

  const assumed = [
    `the coming days sell at the pace of the last ${plural(rate.over_days, "day")} (${rate.units} sold), give or take chance (±${Math.round(Math.sqrt(rate.units))})`,
  ];
  if (lead.basis === "assumed") assumed.push(`ASSUMED delivery time: ${lead.why}`);
  if (boosted) {
    assumed.push(
      `ASSUMED: this item follows your business's own season — the busy stretch is read from your ${boost!.read_from}, not from this item`,
    );
  }
  if (elapsed > 0) {
    assumed.push(
      `ASSUMED: it kept selling at that pace since the stock was read on ${item.as_of}, ${plural(elapsed, "day")} ago`,
    );
  }
  const window =
    rate.from === null
      ? `${rate.units} sold in the ${rate.over_days} days to ${rate.to}, from your stock file`
      : `${rate.units} sold ${rate.from} to ${rate.to}, measured by ${sourceLabel}`;
  const sources = `${window}; ${item.on_hand} on hand, read on ${item.as_of}; ${leadLine}${boosted ? `; the season from your ${boost!.read_from}` : ""}`;

  let warning: StockWarning | null = null;
  if (item.on_hand <= 0) {
    warning = {
      level: "out",
      flag: "ACT NOW",
      sentence: `${item.name} is sold out: it sold ${rate.units} in the last ${plural(rate.over_days, "day")}, and ${leadPhrase(lead)}.`,
    };
  } else if (low < lead.days) {
    const before = high !== null && high < lead.days;
    warning = {
      level: before ? "before_restock" : "tight",
      flag: before ? "ACT NOW" : "RUNNING LOW",
      sentence: `${item.name} runs out in ${coverRangeText(cover)}; ${leadPhrase(lead)}.${boosted ? ` That counts your busy stretch from ${shortDay(boost!.starts_on)}.` : ""}`,
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
    reorder: warning ? reorderFor(item, rate, lead, boost) : null,
    assumed,
    sources,
    why: null,
  };
}

/** Pure: the cover column's text ("9–10", "365+", "—"). */
export function coverColumn(c: CoverAssessment): string {
  if (c.cover === null) return c.status === "no_sales" ? "no sales" : "—";
  const lo = Math.round(c.cover.low);
  if (lo >= COVER.max_cover_days) return `${COVER.max_cover_days}+`;
  if (c.cover.high === null) return `${lo}+`;
  const hi = Math.round(c.cover.high);
  if (hi >= COVER.max_cover_days) return `${lo}–${COVER.max_cover_days}+`;
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
}

/** Pure: warned items first — the soonest out first — then the rest by name. */
export function rankWarnings<T extends { name: string; cover: CoverAssessment }>(
  rows: readonly T[],
): T[] {
  const order: Record<CoverLevel, number> = { out: 0, before_restock: 1, tight: 2 };
  return rows
    .filter((r) => r.cover.warning !== null)
    .sort(
      (a, b) =>
        order[a.cover.warning!.level] - order[b.cover.warning!.level] ||
        (a.cover.cover?.low ?? 0) - (b.cover.cover?.low ?? 0) ||
        (a.name < b.name ? -1 : 1),
    );
}
