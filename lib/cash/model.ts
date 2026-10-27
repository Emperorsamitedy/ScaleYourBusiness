// The 13-week cash forecast — Phase 5 Session B (P5-07), under rules 25 and
// 26. Pure: no database, no model, no clock, no network. lib/cash/load.ts
// reads the inputs; this file only does arithmetic on them.
//
// It starts from the cash the owner says the business has today (5.3e) and
// walks thirteen 7-day weeks forward from today:
//
//   money in    the business's OWN sales a week, as a range, read from one
//               measured daily series (one source, one currency):
//                 with a year of history (lib/seasons' bar: 50 of the last
//                 52 weeks complete), each week is the same week last year
//                 × how the last 8 weeks compare with the same 8 a year
//                 before (the middle half of those 8 ratios);
//                 with less, every week is the middle half (25th–75th
//                 percentile) of the last 13 complete weeks.
//               A sale reaches the bank after the payout delay of the
//               provider the owner named (4.2b, lib/cash/payout.ts): the
//               cautious end takes the slow end of the delay, the hopeful
//               end the fast one. Sales of the last few days that haven't
//               been paid out yet arrive in the first week.
//   money out   fixed costs by their stated frequency (5.1, and any 5.2 row
//               with a monthly, quarterly or yearly cadence) on dated days;
//               per-sale costs (offers' cost to deliver, 5.2 per unit and
//               per order) as a share of each week's sales; debt repayments
//               (5.1 rows in loan_payments) on their own line. 5.3c is a
//               total owed, not a repayment: with debt and no repayment
//               listed, none is counted and the screen says so.
//
// Rule 25: every forecast states its history window and sources, is a
// low–high range, and names what is ASSUMED. Under 8 complete weeks of
// history it refuses, saying how many there are, what it can and can't say
// and from when it will. Nothing is ever filled from industry averages.
//
// Rule 1: integer minor units in ONE currency — the stated cash's. A cost,
// offer or series in another currency is left out by name, never converted.
//
// Rule 26: this models money; it never moves any. Nothing here, or anywhere
// in lib/cash, pays, transfers, invoices or collects (lib/cash/fence.test.ts).

import type { Basis } from "../../components/report/basis";
import { moneyText, num } from "../../components/sheet/num";
import { shortDate } from "../charts/model";
import { enumCode } from "../core/enum-value";
import { SEASONS, addDays, quantile } from "../seasons/forecast";
import { CASH_ASK } from "./keys";
import type { PayoutChoice } from "./payout";
import { PAYOUT_SOURCE, PAYOUT_UNKNOWN, dayRange, payoutFor } from "./payout";

/** The pinned windows and bars — one place, boundary-tested (model.test.ts). */
export const CASH = {
  /** Thirteen 7-day weeks from today: a quarter. */
  horizon_weeks: 13,
  /** The recent window the flat pattern is read over, in weeks. */
  recent_weeks: 13,
  /** Rule 25's minimum: complete weeks of the recent window before any forecast. */
  min_weeks: 8,
  /** With a year: the recent weeks compared with the same weeks a year before… */
  growth_weeks: 8,
  /** …of which at least this many must be measured in full on both sides. */
  min_growth_weeks: 6,
  /** A week whose sales run at or under this multiple of normal is quiet (= SEASONS.quiet_index). */
  quiet_index: SEASONS.quiet_index,
  /** Weeks in a month, for monthly figures (52 ÷ 12). */
  weeks_per_month: 52 / 12,
} as const;

const HORIZON_DAYS = CASH.horizon_weeks * 7;
const YEAR_DAYS = 364;

/* ── the inputs ── */

export interface MoneyFact {
  amount_minor: number;
  currency: string;
  basis: Basis;
  /** Where it came from, in words. */
  source: string;
  /** The day it was true (observed_at), when known. */
  on: string | null;
}

export interface CountFact {
  value: number;
  basis: Basis;
  source: string;
}

/** A stated answer: a value, "I don't know" (rule 5), or not given yet. */
export type Answer<T> =
  { status: "known"; fact: T } | { status: "unknown" } | { status: "missing" };

export interface CostLine {
  /** "costs.<id>". */
  key: string;
  label: string;
  /** Bank cost_category code, e.g. "rent", "loan_payments". */
  category: string | null;
  /** 5.1 (fixed) or 5.2 (rises with sales). */
  list: "fixed" | "variable";
  amount: MoneyFact | null;
  /** Bank cost_cadence code: monthly | quarterly | annual | per_unit | per_job. */
  cadence: string | null;
}

export interface OfferLine {
  key: string;
  name: string;
  price: MoneyFact | null;
  cost: MoneyFact | null;
  /** Units a month (3.1 volume_period). */
  volume_month: CountFact | null;
}

/** One measured daily money series of one source: day → integer minor units. */
export interface DailySeries {
  /** Owner-facing source name: "Shopify", "Stripe". */
  source: string;
  /** Connector provider id, for the payout fallback. */
  provider: string;
  /** "revenue", "booking revenue". */
  noun: string;
  currency: string;
  values: ReadonlyMap<string, number>;
}

/** The same source's daily count of orders (or appointments), when measured. */
export interface CountSeries {
  noun: string;
  values: ReadonlyMap<string, number>;
}

export interface CashInputs {
  /** The owner's date; the series is read up to the day before. */
  today: string;
  cash: Answer<MoneyFact>;
  buffer: Answer<MoneyFact>;
  debt: Answer<MoneyFact>;
  revenue: DailySeries | null;
  volume: CountSeries | null;
  /** 4.1b, orders a month, when no count series is measured. */
  orders_month: CountFact | null;
  payout: { provider: string | null; methods: readonly string[] | null };
  costs: readonly CostLine[];
  offers: readonly OfferLine[];
  /** What to connect when nothing is measured, in the owner's words. */
  connect: string;
  /** Measured sales in other currencies than the cash's: left out, never converted. */
  other_currencies: readonly string[];
}

/** Scenario adjustments (lib/cash/scenarios.ts). Arrays are per forecast week. */
export interface Adjust {
  /** Multiplies the week's sales at both ends (a slow month). */
  sales_factor?: readonly number[];
  /** Extra money out, in integer minor units, at both ends (a hire, a big order's costs). */
  extra_out?: readonly number[];
  /** Extra money in, paid in full that week (a big order). */
  extra_in?: readonly number[];
  /** A net change a week as a range: low to the cautious end, high to the hopeful (a price change). */
  extra_net?: readonly Range[];
}

/* ── the result ── */

export interface Range {
  low: number;
  high: number;
}

export interface Need {
  what: string;
  href: string;
}

export interface DueItem {
  key: string;
  label: string;
  amount_minor: number;
  cadence: "monthly" | "quarterly" | "annual";
  /** A debt repayment (5.1 loan_payments). */
  debt: boolean;
  /** An undated yearly cost, a twelfth set aside. */
  set_aside: boolean;
  /** The day it is counted. */
  on: string;
}

export interface CashWeek {
  index: number;
  start: string;
  end: string;
  /** Sales made in the week, before the payout delay. */
  sales: Range;
  /** What reaches the bank in the week. */
  money_in: Range;
  due: DueItem[];
  /** Fixed costs due, debt excluded. */
  fixed_out: number;
  debt_out: number;
  /** Per-sale costs: the cautious end with the cautious sales. */
  variable_out: Range;
  /** Scenario adjustments, net. Zero for the plain forecast. */
  extra: Range;
  net: Range;
  /** The balance at the end of the week. */
  balance: Range;
  /** Season mode: the same week last year against the year's normal week. */
  last_year: { value: number; index: number } | null;
}

export interface Pattern {
  kind: "season" | "recent";
  /** Complete weeks of the recent window. */
  recent_complete: number;
  /** The middle half of the recent complete weeks, and their median. */
  recent: Range;
  median_week: number;
  /** Season mode only. */
  growth: Range | null;
  normal_week: number | null;
  /** Season mode: weeks last year wasn't measured in full, so the recent range stands in. */
  fallback_weeks: number[];
  /** The history window read. */
  from: string;
  to: string;
  covered_days: number;
}

export interface VariableCosts {
  /** Per-sale costs as a share of sales. */
  ratio: number;
  /** The arithmetic, line by line. */
  lines: string[];
  basis: Basis;
}

export interface SourceLine {
  label: string;
  value: string;
  basis: Basis | null;
  source: string;
}

export interface CashLine {
  amount_minor: number;
  kind: "buffer" | "zero";
  fact: MoneyFact | null;
}

export interface CashReady {
  status: "ready";
  today: string;
  currency: string;
  start: MoneyFact;
  line: CashLine;
  weeks: CashWeek[];
  pattern: Pattern;
  payout: PayoutChoice;
  variable: VariableCosts;
  /** Fixed costs a month on average, debt excluded (a yearly cost as a twelfth). */
  fixed_monthly: number;
  debt_monthly: number;
  series: { source: string; noun: string };
  sources: SourceLine[];
  /** What is ASSUMED, by name (rule 25). */
  assumptions: string[];
  /** What was left out, and why. */
  left_out: string[];
  /** What would fill a gap. */
  needs: Need[];
  /** The week with the lowest cautious-end balance. */
  lowest: { index: number; balance: Range };
  /** The balance at the end of week 13. */
  end: Range;
}

export interface CashRefusal {
  status: "refused";
  reason: "no_history" | "too_little" | "no_cash" | "currency";
  headline: string;
  /** How much history there is, when there is any. */
  history: {
    source: string;
    noun: string;
    first_day: string;
    last_day: string;
    covered_days: number;
    complete_weeks: number;
    needed_weeks: number;
  } | null;
  /** When the forecast will be ready if syncs keep running; null when it waits on the owner. */
  ready_on: string | null;
  can: string[];
  cannot: string[];
  needs: Need[];
}

export type CashForecast = CashReady | CashRefusal;

/* ── small helpers ── */

const plural = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;
const money = (minor: number, currency: string) => moneyText(Math.round(minor), currency);
/** Whole major units: "€6,400". */
export function wholeMoney(minor: number, currency: string): string {
  return moneyText(Math.round(minor), currency).replace(/\.\d+$/, "");
}
const pct = (x: number) => `${num(x * 100, 1)}%`;

/** The sum of seven days from `from`, or null when any day wasn't measured. */
export function blockSum(values: ReadonlyMap<string, number>, from: string): number | null {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const v = values.get(addDays(from, i));
    if (v === undefined) return null;
    total += v;
  }
  return total;
}

/** The start of recent block j (j = 0 is the seven days before today). */
const blockFrom = (today: string, j: number) => addDays(today, -7 * (j + 1));

/** Every 1st of a month in [from, from + days). */
function firsts(from: string, days: number): string[] {
  const out: string[] = [];
  const end = addDays(from, days - 1);
  let d = `${from.slice(0, 7)}-01`;
  if (d < from) d = nextMonth(d);
  while (d <= end) {
    out.push(d);
    d = nextMonth(d);
  }
  return out;
}

function nextMonth(first: string): string {
  const y = Number(first.slice(0, 4));
  const m = Number(first.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

const daysFrom = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The month a quarterly cost is counted in, when no date is stated: the quarter's first. */
const QUARTER_MONTHS: ReadonlySet<string> = new Set(["01", "04", "07", "10"]);

/** Cadences that are dated (fixed by frequency), and those that ride on sales. */
const DATED: ReadonlySet<string> = new Set(["monthly", "quarterly", "annual"]);
/** A cost category that is a debt repayment. */
const DEBT_CATEGORY = "loan_payments";

/* ── the pattern of money in ── */

interface History {
  first_day: string;
  last_day: string;
  covered_days: number;
  recent: number[];
}

function readHistory(series: DailySeries, today: string): History | null {
  const yesterday = addDays(today, -1);
  const days = [...series.values.keys()].filter((d) => d <= yesterday).sort();
  if (days.length === 0) return null;
  const recent: number[] = [];
  for (let j = 0; j < CASH.recent_weeks; j++) {
    const v = blockSum(series.values, blockFrom(today, j));
    if (v !== null) recent.push(v);
  }
  return {
    first_day: days[0]!,
    last_day: days.at(-1)!,
    covered_days: days.length,
    recent,
  };
}

function salesPattern(
  series: DailySeries,
  today: string,
  history: History,
): { pattern: Pattern; weekly: Range[]; lastYear: (CashWeek["last_year"] | null)[] } {
  const recentRange: Range = {
    low: quantile(history.recent, 0.25),
    high: quantile(history.recent, 0.75),
  };
  const median = quantile(history.recent, 0.5);

  // A year? lib/seasons' bar, read on the same 7-day blocks.
  const year: number[] = [];
  for (let j = 0; j < SEASONS.year_weeks; j++) {
    const v = blockSum(series.values, blockFrom(today, j));
    if (v !== null) year.push(v);
  }
  const ratios: number[] = [];
  for (let j = 0; j < CASH.growth_weeks; j++) {
    const from = blockFrom(today, j);
    const now = blockSum(series.values, from);
    const before = blockSum(series.values, addDays(from, -YEAR_DAYS));
    if (now !== null && before !== null && before > 0) ratios.push(now / before);
  }
  const normal = year.length > 0 ? quantile(year, 0.5) : 0;
  const seasonal =
    year.length >= SEASONS.min_weeks && ratios.length >= CASH.min_growth_weeks && normal > 0;
  const from = seasonal
    ? blockFrom(today, SEASONS.year_weeks - 1)
    : blockFrom(today, CASH.recent_weeks - 1);
  const window = {
    from: from < history.first_day ? history.first_day : from,
    to: addDays(today, -1) < history.last_day ? addDays(today, -1) : history.last_day,
  };

  const weekly: Range[] = [];
  const lastYear: (CashWeek["last_year"] | null)[] = [];
  const fallback: number[] = [];
  const growth = seasonal ? { low: quantile(ratios, 0.25), high: quantile(ratios, 0.75) } : null;
  for (let k = 0; k < CASH.horizon_weeks; k++) {
    const ly = growth ? blockSum(series.values, addDays(today, 7 * k - YEAR_DAYS)) : null;
    if (growth && ly !== null) {
      weekly.push({ low: ly * growth.low, high: ly * growth.high });
      lastYear.push({ value: ly, index: ly / normal });
    } else {
      if (growth) fallback.push(k);
      weekly.push({ ...recentRange });
      lastYear.push(null);
    }
  }
  return {
    pattern: {
      kind: seasonal ? "season" : "recent",
      recent_complete: history.recent.length,
      recent: recentRange,
      median_week: median,
      growth,
      normal_week: seasonal ? normal : null,
      fallback_weeks: fallback,
      from: window.from,
      to: window.to,
      covered_days: history.covered_days,
    },
    weekly,
    lastYear,
  };
}

/* ── per-sale costs ── */

function variableCosts(
  inputs: CashInputs,
  currency: string,
  pattern: Pattern,
  leftOut: string[],
  needs: Need[],
): VariableCosts {
  const lines: string[] = [];
  const same = (m: MoneyFact | null): m is MoneyFact => m !== null && m.currency === currency;
  const bases: Basis[] = [];

  // Units: the offers' stated volumes, at their stated prices.
  let units = 0;
  let salesAtStated = 0;
  let deliver = 0;
  const noCost: string[] = [];
  for (const o of inputs.offers) {
    if (!same(o.price) || !o.volume_month) continue;
    units += o.volume_month.value;
    salesAtStated += o.price.amount_minor * o.volume_month.value;
    if (same(o.cost)) deliver += o.cost.amount_minor * o.volume_month.value;
    else noCost.push(o.name);
    bases.push(o.volume_month.basis);
  }
  const perUnit = inputs.costs.filter((c) => same(c.amount) && enumCode(c.cadence) === "per_unit");
  const perJob = inputs.costs.filter((c) => same(c.amount) && enumCode(c.cadence) === "per_job");
  const perUnitEach = perUnit.reduce((s, c) => s + c.amount!.amount_minor, 0);
  const perJobEach = perJob.reduce((s, c) => s + c.amount!.amount_minor, 0);

  let unitRatio = 0;
  if (salesAtStated > 0) {
    const perUnitMonth = perUnitEach * units;
    unitRatio = (deliver + perUnitMonth) / salesAtStated;
    if (deliver > 0 || perUnitMonth > 0) {
      lines.push(
        `Per piece: (${money(deliver, currency)} to deliver your offers${perUnit.length > 0 ? ` + ${money(perUnitEach, currency)} × ${num(units)} pieces` : ""}) ÷ ${money(salesAtStated, currency)} of sales a month at your stated prices and volumes = ${pct(unitRatio)} of each sale`,
      );
    }
    if (noCost.length > 0) {
      leftOut.push(
        `What ${noCost.join(", ")} cost${noCost.length === 1 ? "s" : ""} you to deliver isn't on your offers list, so it isn't counted.`,
      );
      needs.push({ what: "what each offer costs you to deliver", href: CASH_ASK.offers });
    }
  } else if (perUnit.length > 0 || inputs.offers.some((o) => same(o.cost))) {
    leftOut.push(
      "Your per-piece costs aren't counted: your offers list doesn't say how many of each you sell a month.",
    );
    needs.push({ what: "roughly how many of each offer you sell a month", href: CASH_ASK.offers });
  }

  let jobRatio = 0;
  if (perJob.length > 0) {
    // Orders per unit of sales: measured beside the same series, else stated.
    let ordersPerMinor: number | null = null;
    let how = "";
    if (inputs.volume && inputs.revenue) {
      let orders = 0;
      let sales = 0;
      for (let j = 0; j < CASH.recent_weeks; j++) {
        const from = blockFrom(inputs.today, j);
        const o = blockSum(inputs.volume.values, from);
        const s = blockSum(inputs.revenue.values, from);
        if (o === null || s === null) continue;
        orders += o;
        sales += s;
      }
      if (orders > 0 && sales > 0) {
        ordersPerMinor = orders / sales;
        how = `${num(orders)} ${inputs.volume.noun} on ${money(sales, currency)} of measured sales`;
        bases.push("OBSERVED");
      }
    }
    if (ordersPerMinor === null && inputs.orders_month && pattern.median_week > 0) {
      const monthSales = pattern.median_week * CASH.weeks_per_month;
      ordersPerMinor = inputs.orders_month.value / monthSales;
      how = `${num(inputs.orders_month.value)} orders a month, as you told me, on about ${money(monthSales, currency)} of sales a month`;
      bases.push(inputs.orders_month.basis);
    }
    if (ordersPerMinor === null) {
      leftOut.push(
        "Your per-order costs aren't counted: I don't know how many orders you take a week.",
      );
      needs.push({ what: "roughly how many orders you take a month", href: CASH_ASK.orders });
    } else {
      jobRatio = perJobEach * ordersPerMinor;
      lines.push(
        `Per order: ${money(perJobEach, currency)} × (${how}) = ${pct(jobRatio)} of each sale`,
      );
    }
  }
  for (const c of [...perUnit, ...perJob]) bases.push(c.amount!.basis);
  const ratio = unitRatio + jobRatio;
  if (lines.length === 0) lines.push("No per-sale cost is stated, so none is counted.");
  else lines.push(`Together: ${pct(ratio)} of each week's sales, paid in the week of the sale.`);
  return { ratio, lines, basis: bases.length > 0 ? "DERIVED" : "STATED" };
}

/* ── dated costs ── */

function datedCosts(
  inputs: CashInputs,
  currency: string,
  leftOut: string[],
): { due: DueItem[]; fixedMonthly: number; debtMonthly: number; cadences: Set<string> } {
  const due: DueItem[] = [];
  const cadences = new Set<string>();
  let fixedMonthly = 0;
  let debtMonthly = 0;
  const days = firsts(inputs.today, HORIZON_DAYS);
  for (const c of inputs.costs) {
    const cadence = enumCode(c.cadence);
    if (cadence !== null && !DATED.has(cadence)) continue; // per-sale: variableCosts
    if (!c.amount) {
      leftOut.push(`${c.label} has no amount, so it isn't counted.`);
      continue;
    }
    if (c.amount.currency !== currency) {
      leftOut.push(
        `${c.label} is in ${c.amount.currency} and your cash is in ${currency}; I don't convert between currencies, so it isn't counted.`,
      );
      continue;
    }
    if (cadence === null) {
      leftOut.push(`${c.label} has no frequency, so I can't place it in a week.`);
      continue;
    }
    cadences.add(cadence);
    const debt = enumCode(c.category) === DEBT_CATEGORY;
    const a = c.amount.amount_minor;
    const monthly = cadence === "monthly" ? a : cadence === "quarterly" ? a / 3 : a / 12;
    if (debt) debtMonthly += monthly;
    else fixedMonthly += monthly;
    for (const on of days) {
      if (cadence === "quarterly" && !QUARTER_MONTHS.has(on.slice(5, 7))) continue;
      due.push({
        key: c.key,
        label: c.label,
        amount_minor: cadence === "annual" ? Math.round(a / 12) : a,
        cadence: cadence as DueItem["cadence"],
        debt,
        set_aside: cadence === "annual",
        on,
      });
    }
  }
  return { due, fixedMonthly, debtMonthly, cadences };
}

/* ── the forecast ── */

/** Pure: arrivals a week, for weekly sales and a payout delay in days. */
export function arrivals(
  weekly: readonly number[],
  past: (day: number) => number,
  delay: number,
): number[] {
  const out = new Array<number>(weekly.length).fill(0);
  const land = (t: number, amount: number) => {
    const at = t + delay;
    if (at < 0 || at >= weekly.length * 7) return;
    out[Math.floor(at / 7)]! += amount;
  };
  for (let t = -delay; t < 0; t++) land(t, past(t));
  for (let t = 0; t < weekly.length * 7; t++) land(t, weekly[Math.floor(t / 7)]! / 7);
  return out.map((v) => Math.round(v));
}

function refusalCan(inputs: CashInputs, currency: string | null): string[] {
  const can: string[] = [];
  if (currency) {
    const left: string[] = [];
    const { fixedMonthly, debtMonthly } = datedCosts(inputs, currency, left);
    if (fixedMonthly + debtMonthly > 0) {
      can.push(
        `Add up what goes out on the dates you gave: about ${wholeMoney(fixedMonthly + debtMonthly, currency)} a month in fixed costs${debtMonthly > 0 ? " and repayments" : ""}.`,
      );
    }
  }
  can.push(
    "Keep reading your sales every night, so the forecast is ready as soon as there's enough.",
  );
  return can;
}

const CANNOT_BORROW =
  "Borrow a sales pattern from other businesses like yours. An industry average isn't your history, so I don't present one as yours.";

/** Pure: the 13-week forecast, or an honest refusal (rule 25). */
export function forecastCash(inputs: CashInputs, adjust: Adjust = {}): CashForecast {
  const today = inputs.today;
  const series = inputs.revenue;
  const cashCurrency = inputs.cash.status === "known" ? inputs.cash.fact.currency : null;

  if (series === null) {
    return {
      status: "refused",
      reason: "no_history",
      headline: "I need your own sales history to forecast your cash, and nothing is measured yet.",
      history: null,
      ready_on: null,
      can: refusalCan(inputs, cashCurrency),
      cannot: [
        "Say what comes in week by week: a forecast of money in needs your own measured sales.",
        CANNOT_BORROW,
      ],
      needs: [{ what: `${inputs.connect}`, href: CASH_ASK.connect }],
    };
  }

  const history = readHistory(series, today);
  if (history === null || history.recent.length < CASH.min_weeks) {
    const complete = history?.recent.length ?? 0;
    const stale = history !== null && daysFrom(history.last_day, today) > 14;
    return {
      status: "refused",
      reason: "too_little",
      headline: stale
        ? `Only ${plural(complete, "complete week")} of the last ${CASH.recent_weeks} were measured (the last measured day is ${shortDate(history!.last_day)}): a cash forecast needs ${CASH.min_weeks}.`
        : `I have ${plural(complete, "complete week")} of your ${series.noun}; a 13-week cash forecast needs ${CASH.min_weeks}.`,
      history: history
        ? {
            source: series.source,
            noun: series.noun,
            first_day: history.first_day,
            last_day: history.last_day,
            covered_days: history.covered_days,
            complete_weeks: complete,
            needed_weeks: CASH.min_weeks,
          }
        : null,
      ready_on: addDays(today, 7 * (CASH.min_weeks - complete)),
      can: refusalCan(inputs, cashCurrency),
      cannot: [
        `Say what comes in over the next 13 weeks: ${plural(complete, "week")} is too few to know what a normal week is.`,
        CANNOT_BORROW,
      ],
      needs: [],
    };
  }

  if (inputs.cash.status !== "known") {
    return {
      status: "refused",
      reason: "no_cash",
      headline:
        inputs.cash.status === "unknown"
          ? "You told me you don't know how much cash the business has today, so there's no starting point for a forecast yet."
          : "I need roughly how much cash the business has today to start the forecast from.",
      history: {
        source: series.source,
        noun: series.noun,
        first_day: history.first_day,
        last_day: history.last_day,
        covered_days: history.covered_days,
        complete_weeks: history.recent.length,
        needed_weeks: CASH.min_weeks,
      },
      ready_on: null,
      can: [
        `Read your ${series.noun}: ${plural(history.recent.length, "complete week")} of the last ${CASH.recent_weeks}, enough to forecast money in.`,
        ...refusalCan(inputs, series.currency).slice(0, 1),
      ],
      cannot: ["Say when money gets tight without knowing where it starts."],
      needs: [{ what: "roughly how much cash the business has today", href: CASH_ASK.cash }],
    };
  }

  const start = inputs.cash.fact;
  const currency = start.currency;
  if (series.currency !== currency) {
    return {
      status: "refused",
      reason: "currency",
      headline: `Your cash is in ${currency} and your measured ${series.noun} in ${series.currency}. I never convert between currencies, so I can't forecast one from the other.`,
      history: null,
      ready_on: null,
      can: refusalCan(inputs, currency),
      cannot: [
        `Add ${series.currency} sales to ${currency} cash without an exchange rate nobody gave me.`,
      ],
      needs: [{ what: `your cash today in ${series.currency}`, href: CASH_ASK.cash }],
    };
  }

  const leftOut: string[] = [];
  const needs: Need[] = [];
  const { pattern, weekly, lastYear } = salesPattern(series, today, history);
  const payout = payoutFor({
    provider: inputs.payout.provider,
    methods: inputs.payout.methods,
    series_provider: series.provider,
  });
  if (payout.days === PAYOUT_UNKNOWN) {
    needs.push({ what: "which payment provider pays your sales out", href: CASH_ASK.provider });
  }
  const variable = variableCosts(inputs, currency, pattern, leftOut, needs);
  const { due, fixedMonthly, debtMonthly, cadences } = datedCosts(inputs, currency, leftOut);

  const factor = (k: number) => adjust.sales_factor?.[k] ?? 1;
  const salesLow = weekly.map((w, k) => w.low * factor(k));
  const salesHigh = weekly.map((w, k) => w.high * factor(k));
  const past = (t: number) => series.values.get(addDays(today, t)) ?? 0;
  const inLow = arrivals(salesLow, past, payout.days.high);
  const inHigh = arrivals(salesHigh, past, payout.days.low);

  const weeks: CashWeek[] = [];
  let low = start.amount_minor;
  let high = start.amount_minor;
  for (let k = 0; k < CASH.horizon_weeks; k++) {
    const wStart = addDays(today, 7 * k);
    const wEnd = addDays(wStart, 6);
    const dueNow = due.filter((d) => d.on >= wStart && d.on <= wEnd);
    const fixedOut = dueNow.filter((d) => !d.debt).reduce((s, d) => s + d.amount_minor, 0);
    const debtOut = dueNow.filter((d) => d.debt).reduce((s, d) => s + d.amount_minor, 0);
    const varLow = Math.round(salesLow[k]! * variable.ratio);
    const varHigh = Math.round(salesHigh[k]! * variable.ratio);
    const extraFixed = (adjust.extra_in?.[k] ?? 0) - (adjust.extra_out?.[k] ?? 0);
    const extra: Range = {
      low: extraFixed + (adjust.extra_net?.[k]?.low ?? 0),
      high: extraFixed + (adjust.extra_net?.[k]?.high ?? 0),
    };
    const net: Range = {
      low: inLow[k]! - fixedOut - debtOut - varLow + extra.low,
      high: inHigh[k]! - fixedOut - debtOut - varHigh + extra.high,
    };
    low += net.low;
    high += net.high;
    weeks.push({
      index: k,
      start: wStart,
      end: wEnd,
      sales: { low: Math.round(salesLow[k]!), high: Math.round(salesHigh[k]!) },
      money_in: { low: inLow[k]!, high: inHigh[k]! },
      due: dueNow,
      fixed_out: fixedOut,
      debt_out: debtOut,
      variable_out: { low: varLow, high: varHigh },
      extra,
      net,
      // The two ends can cross when per-sale costs outrun their sales; keep them ordered.
      balance: { low: Math.min(low, high), high: Math.max(low, high) },
      last_year: lastYear[k] ?? null,
    });
  }

  // The line: the stated buffer, else zero (an empty account is a fact, not an assumption).
  const buffer = inputs.buffer;
  const line: CashLine =
    buffer.status === "known" && buffer.fact.currency === currency
      ? { amount_minor: buffer.fact.amount_minor, kind: "buffer", fact: buffer.fact }
      : { amount_minor: 0, kind: "zero", fact: null };
  if (buffer.status === "known" && buffer.fact.currency !== currency) {
    leftOut.push(
      `Your buffer is in ${buffer.fact.currency} and your cash in ${currency}, so I draw the line at zero instead of converting.`,
    );
  }
  if (buffer.status === "missing") {
    needs.push({ what: "the least you'd want in the account at any time", href: CASH_ASK.buffer });
  }

  const debt = inputs.debt;
  if (debt.status === "known" && debt.fact.amount_minor > 0 && debtMonthly === 0) {
    leftOut.push(
      `You carry ${wholeMoney(debt.fact.amount_minor, debt.fact.currency)} of debt, but no repayment is on your costs list, so none is counted. A repayment listed under loan payments would be.`,
    );
    needs.push({ what: "what you repay on your debt, and how often", href: CASH_ASK.costs });
  }
  for (const c of inputs.other_currencies) {
    leftOut.push(
      `Your ${series.noun} in ${c} is left out: money in two currencies is never added together.`,
    );
  }

  const assumptions: string[] = [
    pattern.kind === "season"
      ? `Each week runs like the same week last year, scaled by how your last ${CASH.growth_weeks} weeks compare with the same weeks a year before (${times(pattern.growth!.low)}–${times(pattern.growth!.high)}).${pattern.fallback_weeks.length > 0 ? ` ${plural(pattern.fallback_weeks.length, "week")} last year weren't measured in full; those use your recent weeks instead.` : ""}`
      : `The coming weeks run like your last ${plural(pattern.recent_complete, "complete week")}: the middle half of them, ${wholeMoney(pattern.recent.low, currency)}–${wholeMoney(pattern.recent.high, currency)} a week. With under a year of history no season is known, so none is applied.`,
    payout.days.high === 0
      ? "Sales are money in the same day."
      : `A sale reaches your account ${dayRange(payout.days)} after it is made (${payout.why}). The cautious end takes the slow end.`,
    "Sales are spread evenly over the days of their week.",
  ];
  if (cadences.has("monthly")) assumptions.push("Monthly costs go out on the 1st of each month.");
  if (cadences.has("quarterly")) {
    assumptions.push(
      "Quarterly costs go out on the 1st of January, April, July and October: you haven't told me their dates.",
    );
  }
  if (cadences.has("annual")) {
    assumptions.push(
      "A yearly cost with no due date is set aside a twelfth at a time on each 1st, rather than guessed into one week.",
    );
  }
  if (variable.ratio > 0) assumptions.push("Per-sale costs are paid in the week of the sale.");
  assumptions.push(
    "Nothing else changes: no cost, payment or one-off beyond what you listed. Tax counts only where it is on your costs list.",
  );

  const sources: SourceLine[] = [
    {
      label: "Cash today",
      value: wholeMoney(start.amount_minor, currency),
      basis: start.basis,
      source: start.on ? `${start.source}, on ${shortDate(start.on)}` : start.source,
    },
    {
      label: "Money in",
      value: `${series.source} ${series.noun}, ${plural(pattern.covered_days, "measured day")} to ${shortDate(history.last_day)}`,
      basis: "OBSERVED",
      source:
        pattern.kind === "season"
          ? `the last year, read from ${shortDate(pattern.from)}`
          : `the last ${CASH.recent_weeks} weeks, read from ${shortDate(pattern.from)}`,
    },
    {
      label: "Payout timing",
      value: dayRange(payout.days),
      basis:
        payout.days.high === 0 && payout.code === null && inputs.payout.methods
          ? "STATED"
          : "ASSUMED",
      source: payout.days.high === 0 && payout.code === null ? payout.why : PAYOUT_SOURCE,
    },
    {
      label: "Fixed costs",
      value: `about ${wholeMoney(fixedMonthly, currency)} a month`,
      basis: fixedMonthly > 0 ? "STATED" : null,
      source:
        fixedMonthly > 0
          ? `${plural(new Set(due.filter((d) => !d.debt).map((d) => d.key)).size, "cost")} from your costs list, by the frequency you gave`
          : "no fixed cost with an amount and a frequency is listed",
    },
    {
      label: "Per-sale costs",
      value: pct(variable.ratio),
      basis: variable.ratio > 0 ? variable.basis : null,
      source: variable.lines.join(" "),
    },
    {
      label: "Debt repayments",
      value:
        debtMonthly > 0 ? `about ${wholeMoney(debtMonthly, currency)} a month` : "none counted",
      basis: debtMonthly > 0 ? "STATED" : null,
      source:
        debtMonthly > 0
          ? "loan payments on your costs list"
          : debt.status === "known"
            ? `debt stated: ${wholeMoney(debt.fact.amount_minor, debt.fact.currency)}, no repayment listed`
            : "no repayment listed",
    },
    {
      label: "The line",
      value: wholeMoney(line.amount_minor, currency),
      basis: line.fact?.basis ?? null,
      source:
        line.kind === "buffer"
          ? `the least you want in the account, as you told me`
          : buffer.status === "unknown"
            ? "you don't know the least you'd want in the account, so the line is an empty account"
            : "no buffer stated, so the line is an empty account",
    },
  ];

  let lowest = weeks[0]!;
  for (const w of weeks) if (w.balance.low < lowest.balance.low) lowest = w;

  return {
    status: "ready",
    today,
    currency,
    start,
    line,
    weeks,
    pattern,
    payout,
    variable,
    fixed_monthly: Math.round(fixedMonthly),
    debt_monthly: Math.round(debtMonthly),
    series: { source: series.source, noun: series.noun },
    sources,
    assumptions,
    left_out: leftOut,
    needs,
    lowest: { index: lowest.index, balance: lowest.balance },
    end: weeks.at(-1)!.balance,
  };
}

/** "1.08×", two decimals: growth ratios sit close to 1. */
export function times(x: number): string {
  return `${(Math.round(x * 100) / 100).toFixed(2)}×`;
}
