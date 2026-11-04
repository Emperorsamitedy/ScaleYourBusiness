// Compared with similar businesses — idea 44, I-44.3. Pure: a few of the
// owner's own numbers set beside one named, dated Eurostat cell each. No
// database, no network, no model, no clock.
//
// Three rules hold everything here:
//
//   · A benchmark is a reference, not a fact about the business. Nothing
//     here makes a Field, a finding or a proposal. I-44a: only a LARGE,
//     like-for-like margin gap (./gap, a stated threshold) may reach the
//     report and a proposal, through ./gap and ./gap-read (fence.test.ts).
//   · Say exactly what it is. Eurostat's figures are ratios of totals over
//     every enterprise in the cell, not a median and not "typical". Each
//     line names its cell and year, and the one definition gap that
//     matters most.
//   · A line is worked out only when the owner's own inputs exist. A gap
//     names the question that fills it; a missing Eurostat cell falls back
//     (the next size class that holds the headcount, then every size, then
//     the parent code) and says which.
//
// The three lines:
//   operating margin        (revenue − cost of sales − per-sale costs −
//                           running costs − staff pay) ÷ revenue, against
//                           GOR_PC. Before the owner's own pay (unless it is
//                           on the costs list), interest, depreciation and
//                           tax; a loan repayment is left out and named.
//   turnover per person     monthly revenue × 12 ÷ the headcount (owner
//                           included), against NETTUR_EMP_TEUR converted to
//                           the revenue's currency at that year's average.
//   staff cost per employee staff pay × 12 ÷ employees on the team list,
//                           against AVG_EXPN_SAL_BEN_TEUR (personnel costs
//                           per employee; LC_EMP_TEUR is per person
//                           employed, owners included, so it isn't used).
//
// Each reads "above", "below" or "about the same" (within ±15 % of
// Eurostat's figure, the boundary included). No grade, no score, no advice.

import type { Basis } from "../../components/report/basis";
import { moneyText, num } from "../../components/sheet/num";
import type { CostLine, CountFact, MoneyFact, OfferLine } from "../cash/model";
import { enumCode } from "../core/enum-value";
import { minorUnitExponent } from "../core/money";
import type { SizeBand } from "../core/size-features";
import type { MappedType, SizePick } from "./map";
import {
  ALL_SIZES,
  costTreatment,
  insideGrossMargin,
  geoFor,
  parentGroup,
  sizeClassesFor,
  sizeWords,
  typeEntry,
} from "./map";
import type { PurchasesKey } from "./purchases";
import { purchasesLine } from "./purchases";
import type { BenchSource, BenchValue, Metric, Snapshot } from "./snapshot";
import { SNAPSHOT, cellIndex, eurRate, isValue } from "./snapshot";

export const BENCH = {
  /** "About the same" when within this share of Eurostat's figure, either side, inclusive. */
  same_band: 0.15,
  months_a_year: 12,
} as const;

/** Where each missing input is asked (/intake?ask=<question id>). */
export const BENCH_ASK = {
  type: "/intake?ask=1.2",
  country: "/intake?ask=1.1b",
  team_size: "/intake?ask=1.6",
  revenue: "/intake?ask=4.1a",
  offers: "/intake?ask=3.1",
  gross_margin: "/intake?ask=5.3a",
  costs: "/intake?ask=5.1",
  orders: "/intake?ask=4.1b",
  staff: "/intake?ask=9.2",
} as const;

export interface Need {
  what: string;
  href: string;
}

/** One person or role from 9.2: how they're engaged and what they cost a month. */
export interface StaffLine {
  key: string;
  engagement: string | null;
  cost: MoneyFact | null;
}

/** Everything the comparison reads, each figure with its basis. */
export interface BenchInputs {
  as_of: string;
  /** identity.business_type's value (an EnumValue or a code), or null unanswered. */
  business_type: unknown;
  /** legal.country as the owner typed it, and its ISO alpha-2 code if it could be read. */
  country: { raw: string; iso: string | null } | null;
  /** identity.team_size: persons, the owner included. */
  team_size: CountFact | null;
  size_band: SizeBand | null;
  /** revenue.monthly_revenue: measured if a connector superseded it, else stated. */
  revenue: MoneyFact | null;
  /** revenue.order_count_monthly. */
  orders_month: CountFact | null;
  /** costs.gross_margin (5.3a), percent. */
  gross_margin: CountFact | null;
  offers: OfferLine[];
  costs: CostLine[];
  /** 9.2's rows; null when the team list was never given. */
  staff: StaffLine[] | null;
}

export type Reading = "above" | "below" | "about the same";

/** One figure the owner's side rests on. */
export interface OwnInput {
  label: string;
  value: string;
  basis: Basis;
  source: string;
}

/** The Eurostat cell a line was compared with. */
export interface CellUsed {
  geo: string;
  nace: string;
  size: string;
  year: number;
  /** "all online and mail-order shops with up to 9 people in Ireland, 2024, Eurostat". */
  words: string;
  /** Set when the first cell tried had no figure: what was missing, and what this is instead. */
  fallback: string | null;
  /** Eurostat's flag beside the figure, in words ("estimated"), when there is one. */
  flag: string | null;
}

export type LineKey = "operating_margin" | "turnover_per_person" | "staff_cost_per_employee";

interface LineBase {
  /** I-44b: the purchases share is its own line, built in ./purchases. */
  key: LineKey | PurchasesKey;
  title: string;
  /** The one definition gap that matters most, in a sentence. */
  gap_note: string;
}

export interface ComparedLine extends LineBase {
  status: "compared";
  unit: "percent" | "money";
  /** The owner's figure: percent, or integer minor units in `currency`. */
  own: number;
  bench: number;
  currency: string | null;
  own_words: string;
  bench_words: string;
  reading: Reading;
  /** "4.2 points below" / "€4,200 (12%) above". */
  gap_words: string;
  /** The owner's arithmetic, spelled out with the numbers (rule 6). */
  formula: string;
  /** The field keys the owner's figure rests on (rule 6). */
  derived_from: string[];
  inputs: OwnInput[];
  /** Costs not counted, each with why. */
  left_out: string[];
  /** Questions that would make the owner's figure fuller, though it stands without them. */
  needs: Need[];
  cell: CellUsed;
  /** "Converted at 381.85 HUF to the euro, 2024's average (Eurostat, ert_bil_eur_a)." */
  conversion: string | null;
}

export interface MissingLine extends LineBase {
  status: "missing";
  why: string;
  needs: Need[];
}

/** Nothing to compare: no Eurostat figure, no employees, no rate. */
export interface RefusedLine extends LineBase {
  status: "refused";
  why: string;
}

export type BenchLine = ComparedLine | MissingLine | RefusedLine;

export interface BenchHead {
  /** "online and mail-order shops" */
  group: string;
  nace: string;
  covers: string;
  geo: string;
  country: string;
  /** The first size class tried, or TOTAL. */
  size: string;
  size_words: string;
  /** Why this size: from the headcount, the band, or unknown. */
  size_via: SizePick["via"];
}

export type BenchResult =
  | { status: "no_type"; why: string; needs: Need[] }
  | { status: "unmapped"; type_code: string; why: string }
  | { status: "no_country"; why: string; needs: Need[] }
  | { status: "outside_eu"; country: string; why: string }
  | {
      status: "ready";
      as_of: string;
      head: BenchHead;
      lines: BenchLine[];
      source: BenchSource;
      /** "These are totals across every business in the group, not a typical business." */
      caveat: string;
    };

export const CAVEAT =
  "These are totals across every business in the group, not a typical business.";

/* ── reading ── */

/** Pure: "above" / "below" / "about the same", within ±15 % of |bench|, the boundary included. */
export function readingOf(own: number, bench: number, band: number = BENCH.same_band): Reading {
  const tolerance = Math.abs(bench) * band;
  const diff = own - bench;
  // A hair of float noise must not tip a value sitting exactly on the boundary.
  if (Math.abs(diff) <= tolerance + 1e-9 * Math.max(1, Math.abs(bench))) return "about the same";
  return diff > 0 ? "above" : "below";
}

const pts = (n: number) => `${num(Math.abs(n), 1)} point${Math.abs(n) === 1 ? "" : "s"}`;
const pctText = (n: number) => `${num(n, 1)}%`;
const money = (minor: number, currency: string) => moneyText(Math.round(minor), currency);
/** Whole major units, for figures a year: "€22,800". */
const wholeMoney = (minor: number, currency: string) => {
  const unit = 10 ** minorUnitExponent(currency);
  return moneyText(Math.round(minor / unit) * unit, currency);
};

function gapWords(line: {
  unit: "percent" | "money";
  own: number;
  bench: number;
  currency: string | null;
  reading: Reading;
}): string {
  const diff = line.own - line.bench;
  const side = diff >= 0 ? "above" : "below";
  if (line.unit === "percent") {
    return line.reading === "about the same"
      ? `about the same: ${pts(diff)} ${side}`
      : `${pts(diff)} ${side}`;
  }
  const share = line.bench === 0 ? null : Math.round((Math.abs(diff) / Math.abs(line.bench)) * 100);
  const amount = wholeMoney(Math.abs(diff), line.currency ?? "EUR");
  const body = share === null ? amount : `${amount} (${share}%)`;
  return line.reading === "about the same" ? `about the same: ${body} ${side}` : `${body} ${side}`;
}

/* ── the Eurostat side ── */

interface Pick {
  value: BenchValue;
  cell: CellUsed;
}

/**
 * Pure: the size classes Eurostat publishes anything for at this country
 * and code, in the order given. A class it never publishes (today `2-9`
 * and `0_1`, everywhere) isn't a group to name, so it is passed over in
 * silence rather than reported missing on every line.
 */
export function publishedSizes(
  s: Snapshot,
  geo: string,
  nace: string,
  sizes: readonly string[],
): string[] {
  const at = cellIndex(s);
  return sizes.filter((size) => at(geo, nace, size) !== null);
}

/** Said when a line falls back to every size: Eurostat's ratio is of the sector's totals. */
export const EVERY_SIZE_NOTE =
  " Eurostat works that out from the whole sector's totals, so the biggest firms weigh most in it; read it loosely against a business your size.";

/**
 * Pure: the first cell with a figure for `metric`. Tried in order: each
 * size class that holds the headcount (narrowest first, and only those
 * Eurostat publishes for the code), then every size, at the type's own
 * code; then the same at its parent. Says what was missing when the first
 * cell tried wasn't the one used.
 */
export function pickCell(
  s: Snapshot,
  geo: string,
  type: MappedType,
  sizes: readonly string[],
  metric: Metric,
): Pick | null {
  const at = cellIndex(s);
  const country = s.geos[geo] ?? geo;
  const groupOf = (nace: string) => (nace === type.nace ? type.group : parentGroup(nace));
  const describe = (nace: string, size: string) =>
    `${groupOf(nace)} ${sizeWords(size)} in ${country}`;
  const order: { nace: string; size: string }[] = [];
  for (const nace of [type.nace, ...(type.parent ? [type.parent] : [])]) {
    for (const size of [...publishedSizes(s, geo, nace, sizes), ALL_SIZES.code]) {
      if (!order.some((o) => o.nace === nace && o.size === size)) order.push({ nace, size });
    }
  }
  const first = order[0]!;
  let firstWhy: string | null = null;
  for (const o of order) {
    const f = at(geo, o.nace, o.size)?.values[metric];
    if (isValue(f)) {
      const fallback =
        o === first
          ? null
          : `Eurostat ${firstWhy ?? "doesn't publish this"} for ${describe(first.nace, first.size)}, so this is ${describe(o.nace, o.size)}.` +
            (o.size === ALL_SIZES.code && first.size !== ALL_SIZES.code ? EVERY_SIZE_NOTE : "");
      return {
        value: f,
        cell: {
          geo,
          nace: o.nace,
          size: o.size,
          year: f.year,
          words: `all ${describe(o.nace, o.size)}, ${f.year}, Eurostat`,
          fallback,
          flag: f.flag ? (s.flags[f.flag] ?? f.flag) : null,
        },
      };
    }
    if (o === first) {
      firstWhy =
        f && "missing" in f ? `keeps this confidential (${f.year})` : "doesn't publish this";
    }
  }
  return null;
}

/** Pure: thousands of euro as integer minor units of `currency` at `year`'s average rate. */
export function teurToMinor(
  s: Snapshot,
  teur: number,
  currency: string,
  year: number,
): { minor: number; rate: number } | null {
  const rate = eurRate(s, currency, year);
  if (rate === null) return null;
  const minor = Math.round(teur * 1000 * rate * 10 ** minorUnitExponent(currency));
  return { minor, rate };
}

function conversionWords(currency: string, rate: number, year: number): string | null {
  return currency === "EUR"
    ? null
    : `Converted from euros at ${num(rate, rate < 10 ? 4 : 2)} ${currency} to the euro, ${year}'s average (Eurostat, ert_bil_eur_a).`;
}

/* ── the owner's side ── */

const isEmployee = (s: StaffLine) => enumCode(s.engagement) === "employee";
const MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, annual: 12 };

function moneyInput(label: string, f: MoneyFact, value?: string): OwnInput {
  return {
    label,
    value: value ?? money(f.amount_minor, f.currency),
    basis: f.basis,
    source: f.source,
  };
}

/** Staff pay a month: the costs list's salaries, else the team list's employees, else unknown. */
function staffPay(
  x: BenchInputs,
  currency: string,
):
  | { minor: number; from: string[]; inputs: OwnInput[]; source: "costs" | "team" | "none" }
  | { needs: Need[]; why: string } {
  const salaries = x.costs.filter((c) => costTreatment(enumCode(c.category)) === "staff");
  if (salaries.length > 0) return { minor: 0, from: [], inputs: [], source: "costs" }; // counted with the running costs
  if (x.staff !== null) {
    const employees = x.staff.filter(isEmployee);
    const unpriced = employees.filter((e) => !e.cost || e.cost.currency !== currency);
    if (unpriced.length > 0) {
      return {
        why: `${unpriced.length === 1 ? "One employee" : `${unpriced.length} employees`} on your team list ${unpriced.length === 1 ? "has" : "have"} no monthly cost in ${currency}, and staff pay is too big a part of a margin to leave out.`,
        needs: [{ what: "what each employee costs a month", href: BENCH_ASK.staff }],
      };
    }
    const minor = employees.reduce((n, e) => n + e.cost!.amount_minor, 0);
    return {
      minor,
      from: employees.map((e) => `${e.key}.cost_monthly`),
      inputs:
        employees.length > 0
          ? [
              {
                label: `Staff pay, ${employees.length} on your team list`,
                value: money(minor, currency),
                basis: employees[0]!.cost!.basis,
                source: "your team list",
              },
            ]
          : [],
      source: employees.length > 0 ? "team" : "none",
    };
  }
  if (x.team_size && x.team_size.value <= 1)
    return { minor: 0, from: [], inputs: [], source: "none" };
  return {
    why: "I don't know whether anyone besides you is paid, and staff pay is too big a part of a margin to leave out.",
    needs: [
      { what: "who works in the business, and what each costs a month", href: BENCH_ASK.staff },
    ],
  };
}

/** Pure: the operating margin, or what it needs. */
export function ownMargin(x: BenchInputs):
  | {
      pct: number;
      formula: string;
      derived_from: string[];
      inputs: OwnInput[];
      left_out: string[];
      needs: Need[];
    }
  | { needs: Need[]; why: string } {
  const r = x.revenue;
  if (!r)
    return {
      why: "It needs your monthly revenue.",
      needs: [{ what: "your monthly revenue", href: BENCH_ASK.revenue }],
    };
  if (r.amount_minor <= 0)
    return { why: "Your monthly revenue is zero, so there's no margin to work out.", needs: [] };
  const cur = r.currency;
  const same = (m: MoneyFact | null): m is MoneyFact => m !== null && m.currency === cur;
  const derived = ["revenue.monthly_revenue"];
  const inputs: OwnInput[] = [moneyInput("Revenue a month", r)];
  const leftOut: string[] = [];
  const needs: Need[] = [];

  // Cost of sales: the offers' own costs to deliver at their volumes, else the stated gross margin.
  const sold = x.offers.filter((o) => same(o.price) && o.volume_month && o.volume_month.value > 0);
  const costed = sold.length > 0 && sold.every((o) => same(o.cost));
  let costShare: number;
  let units: number | null = null;
  let fromGrossMargin = false;
  if (costed) {
    const sales = sold.reduce((n, o) => n + o.price!.amount_minor * o.volume_month!.value, 0);
    const deliver = sold.reduce((n, o) => n + o.cost!.amount_minor * o.volume_month!.value, 0);
    costShare = deliver / sales;
    units = sold.reduce((n, o) => n + o.volume_month!.value, 0);
    for (const o of sold)
      derived.push(`${o.key}.price`, `${o.key}.cost_to_deliver`, `${o.key}.volume_period`);
    inputs.push({
      label: "Cost of sales",
      value: `${pctText(costShare * 100)} of sales`,
      basis: "DERIVED",
      source: `what your ${sold.length === 1 ? "offer costs" : `${sold.length} offers cost`} to deliver, at your prices and monthly volumes`,
    });
  } else if (x.gross_margin && x.gross_margin.value >= 0 && x.gross_margin.value <= 100) {
    fromGrossMargin = true;
    costShare = 1 - x.gross_margin.value / 100;
    derived.push("costs.gross_margin");
    inputs.push({
      label: "Cost of sales",
      value: `${pctText(costShare * 100)} of sales`,
      basis: x.gross_margin.basis,
      source: `100% less your gross margin of ${pctText(x.gross_margin.value)}`,
    });
  } else {
    return {
      why: "It needs what your sales cost you: each offer's cost to deliver with how many you sell a month, or your gross margin.",
      needs: [
        { what: "what each offer costs you to deliver", href: BENCH_ASK.offers },
        { what: "your gross margin", href: BENCH_ASK.gross_margin },
      ],
    };
  }
  const costOfSales = r.amount_minor * costShare;

  // Review 2026-10-30: a stated gross margin already took these off; never twice.
  const alreadyIn = (c: CostLine): boolean => {
    if (!fromGrossMargin || !insideGrossMargin(enumCode(c.category))) return false;
    leftOut.push(`${c.label}: already inside the gross margin you gave.`);
    return true;
  };
  // Review 2026-10-30: a salaries line that can't be counted refuses the margin,
  // as an unpriced employee does: staff pay is too big a part to leave out.
  const staffMissed: string[] = [];
  const missed = (c: CostLine) => {
    if (costTreatment(enumCode(c.category)) === "staff") staffMissed.push(c.label);
  };

  // Per-sale costs from 5.2: per piece × units sold, per order × orders.
  let perSale = 0;
  for (const c of x.costs) {
    const cadence = enumCode(c.cadence);
    if (cadence !== "per_unit" && cadence !== "per_job") continue;
    if (alreadyIn(c)) continue;
    const amount = c.amount;
    if (!amount || amount.currency !== cur) {
      leftOut.push(
        `${c.label}: ${amount ? `it's in ${amount.currency}, not ${cur}` : "it has no amount"}.`,
      );
      missed(c);
      continue;
    }
    const count = cadence === "per_unit" ? units : (x.orders_month?.value ?? null);
    if (count === null) {
      missed(c);
      leftOut.push(
        cadence === "per_unit"
          ? `${c.label}: it's per piece, and your offers list doesn't say how many you sell a month.`
          : `${c.label}: it's per order, and I don't know how many orders you take a month.`,
      );
      needs.push(
        cadence === "per_unit"
          ? { what: "roughly how many of each offer you sell a month", href: BENCH_ASK.offers }
          : { what: "roughly how many orders you take a month", href: BENCH_ASK.orders },
      );
      continue;
    }
    perSale += amount.amount_minor * count;
    derived.push(`${c.key}.amount`, `${c.key}.cadence`);
    if (cadence === "per_job") derived.push("revenue.order_count_monthly");
  }

  // Running costs: everything dated on 5.1 and 5.2, monthly; loan repayments left out by name.
  let running = 0;
  for (const c of x.costs) {
    const cadence = enumCode(c.cadence);
    if (cadence === "per_unit" || cadence === "per_job") continue;
    if (alreadyIn(c)) continue;
    if (costTreatment(enumCode(c.category)) === "financing") {
      leftOut.push(
        `${c.label}: a loan repayment, and Eurostat's rate is before interest and doesn't count the loan itself.`,
      );
      continue;
    }
    if (!c.amount) {
      leftOut.push(`${c.label}: it has no amount.`);
      needs.push({ what: `the amount of ${c.label}`, href: BENCH_ASK.costs });
      missed(c);
      continue;
    }
    if (c.amount.currency !== cur) {
      leftOut.push(`${c.label}: it's in ${c.amount.currency}, and I don't convert your own costs.`);
      missed(c);
      continue;
    }
    const months = cadence === null ? undefined : MONTHS[cadence];
    if (months === undefined) {
      leftOut.push(`${c.label}: it has no frequency, so I can't make it a month.`);
      needs.push({ what: `how often you pay ${c.label}`, href: BENCH_ASK.costs });
      missed(c);
      continue;
    }
    running += c.amount.amount_minor / months;
    derived.push(`${c.key}.amount`, `${c.key}.cadence`);
  }

  if (staffMissed.length > 0) {
    const one = staffMissed.length === 1;
    return {
      why: `${one ? `The pay line ${staffMissed[0]!}` : `${staffMissed.length} pay lines`} on your costs list ${one ? "has" : "have"} no monthly amount in ${cur} I can count, and staff pay is too big a part of a margin to leave out.`,
      needs: [
        { what: `what you pay in salaries, in ${cur}, and how often`, href: BENCH_ASK.costs },
      ],
    };
  }
  const staff = staffPay(x, cur);
  if ("needs" in staff) return { why: staff.why, needs: staff.needs };
  derived.push(...staff.from);

  if (perSale > 0)
    inputs.push({
      label: "Per-sale costs a month",
      value: wholeMoney(perSale, cur),
      basis: "DERIVED",
      source: "your per-piece and per-order costs, at your volumes",
    });
  if (running > 0)
    inputs.push({
      label: "Running costs a month",
      value: wholeMoney(running, cur),
      basis: "DERIVED",
      source: `your costs list, made monthly${staff.source === "costs" ? ", staff pay included" : ""}`,
    });
  inputs.push(...staff.inputs);

  const surplus = r.amount_minor - costOfSales - perSale - running - staff.minor;
  const pct = Math.round((surplus / r.amount_minor) * 1000) / 10;
  const parts = [
    `${wholeMoney(r.amount_minor, cur)} revenue`,
    `${wholeMoney(costOfSales, cur)} cost of sales`,
    ...(perSale > 0 ? [`${wholeMoney(perSale, cur)} per-sale costs`] : []),
    ...(running > 0 ? [`${wholeMoney(running, cur)} running costs`] : []),
    ...(staff.minor > 0 ? [`${wholeMoney(staff.minor, cur)} staff pay`] : []),
  ];
  return {
    pct,
    formula: `(${parts.join(" − ")}) ÷ ${wholeMoney(r.amount_minor, cur)} × 100 = ${pctText(pct)}`,
    derived_from: [...new Set(derived)],
    inputs,
    left_out: leftOut,
    needs: dedupe(needs),
  };
}

function dedupe(needs: Need[]): Need[] {
  const seen = new Set<string>();
  return needs.filter((n) => {
    const k = `${n.href} ${n.what}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ── the lines ── */

const GAP_NOTE: Record<LineKey, string> = {
  operating_margin:
    "Eurostat's rate is before the pay of owners who aren't on a payroll, and before interest, depreciation and tax. If your costs list includes pay for yourself, yours reads lower than theirs would.",
  turnover_per_person:
    "Eurostat's turnover leaves out VAT. If your revenue figure includes VAT, yours reads higher than theirs would.",
  staff_cost_per_employee:
    "Eurostat's figure includes the employer's social contributions, and counts a part-timer as one person. If your staff costs are the pay alone, yours reads lower than theirs would.",
};

const TITLE: Record<LineKey, string> = {
  operating_margin: "Operating margin",
  turnover_per_person: "Turnover a year per person",
  staff_cost_per_employee: "Staff cost a year per employee",
};

function noCell(key: LineKey, head: BenchHead): RefusedLine {
  return {
    key,
    title: TITLE[key],
    gap_note: GAP_NOTE[key],
    status: "refused",
    why: `Eurostat publishes no figure for this for ${head.group} in ${head.country}, at any size, or for the wider group.`,
  };
}

function marginLine(
  x: BenchInputs,
  s: Snapshot,
  type: MappedType,
  head: BenchHead,
  sizes: string[],
): BenchLine {
  const key = "operating_margin";
  const own = ownMargin(x);
  if ("why" in own)
    return {
      key,
      title: TITLE[key],
      gap_note: GAP_NOTE[key],
      status: "missing",
      why: own.why,
      needs: own.needs,
    };
  const pick = pickCell(s, head.geo, type, sizes, "GOR_PC");
  if (!pick) return noCell(key, head);
  const reading = readingOf(own.pct, pick.value.value);
  const base = {
    unit: "percent" as const,
    own: own.pct,
    bench: pick.value.value,
    currency: null,
    reading,
  };
  return {
    key,
    title: TITLE[key],
    gap_note: GAP_NOTE[key],
    status: "compared",
    ...base,
    own_words: pctText(own.pct),
    bench_words: pctText(pick.value.value),
    gap_words: gapWords(base),
    formula: own.formula,
    derived_from: own.derived_from,
    inputs: own.inputs,
    left_out: own.left_out,
    needs: own.needs,
    cell: pick.cell,
    conversion: null,
  };
}

function turnoverLine(
  x: BenchInputs,
  s: Snapshot,
  type: MappedType,
  head: BenchHead,
  sizes: string[],
): BenchLine {
  const key = "turnover_per_person";
  const needs: Need[] = [];
  if (!x.revenue) needs.push({ what: "your monthly revenue", href: BENCH_ASK.revenue });
  if (!x.team_size || x.team_size.value < 1)
    needs.push({
      what: "how many people work in the business, you included",
      href: BENCH_ASK.team_size,
    });
  if (needs.length > 0 || !x.revenue || !x.team_size) {
    return {
      key,
      title: TITLE[key],
      gap_note: GAP_NOTE[key],
      status: "missing",
      why: "It needs your monthly revenue and how many people work in the business.",
      needs,
    };
  }
  const r = x.revenue;
  const persons = x.team_size.value;
  const own = (r.amount_minor * BENCH.months_a_year) / persons;
  const pick = pickCell(s, head.geo, type, sizes, "NETTUR_EMP_TEUR");
  if (!pick) return noCell(key, head);
  const conv = teurToMinor(s, pick.value.value, r.currency, pick.cell.year);
  if (!conv) {
    return {
      key,
      title: TITLE[key],
      gap_note: GAP_NOTE[key],
      status: "refused",
      why: `I have no euro rate for ${r.currency} in ${pick.cell.year}, so I can't set Eurostat's figure in your currency.`,
    };
  }
  const reading = readingOf(own, conv.minor);
  const base = {
    unit: "money" as const,
    own: Math.round(own),
    bench: conv.minor,
    currency: r.currency,
    reading,
  };
  return {
    key,
    title: TITLE[key],
    gap_note: GAP_NOTE[key],
    status: "compared",
    ...base,
    own_words: wholeMoney(own, r.currency),
    bench_words: wholeMoney(conv.minor, r.currency),
    gap_words: gapWords(base),
    formula: `${money(r.amount_minor, r.currency)} a month × 12 ÷ ${num(persons)} ${persons === 1 ? "person" : "people"} = ${wholeMoney(own, r.currency)}`,
    derived_from: ["revenue.monthly_revenue", "identity.team_size"],
    inputs: [
      moneyInput("Revenue a month", r),
      {
        label: "People working in the business, you included",
        value: num(persons),
        basis: x.team_size.basis,
        source: x.team_size.source,
      },
    ],
    left_out: [],
    needs: [],
    cell: pick.cell,
    conversion: conversionWords(r.currency, conv.rate, pick.cell.year),
  };
}

function staffLine(
  x: BenchInputs,
  s: Snapshot,
  type: MappedType,
  head: BenchHead,
  sizes: string[],
): BenchLine {
  const key = "staff_cost_per_employee";
  const common = { key, title: TITLE[key], gap_note: GAP_NOTE[key] } as const;
  if (x.staff === null) {
    return {
      ...common,
      status: "missing",
      why: "It needs your team list: who works in the business, and what each employee costs a month.",
      needs: [{ what: "who works in the business", href: BENCH_ASK.staff }],
    };
  }
  const employees = x.staff.filter(isEmployee);
  if (employees.length === 0)
    return {
      ...common,
      status: "refused",
      why: "Your team list has no employees, so there's no staff cost to compare.",
    };
  const cur = x.revenue?.currency ?? employees.find((e) => e.cost)?.cost?.currency ?? null;
  let monthly: number | null = null;
  let inputs: OwnInput[] = [];
  let from: string[] = [];
  if (cur !== null && employees.every((e) => e.cost && e.cost.currency === cur)) {
    monthly = employees.reduce((n, e) => n + e.cost!.amount_minor, 0);
    from = employees.map((e) => `${e.key}.cost_monthly`);
    inputs = [
      {
        label: "Staff pay a month",
        value: money(monthly, cur),
        basis: employees[0]!.cost!.basis,
        source: "your team list",
      },
    ];
  } else if (cur !== null) {
    const salaries = x.costs.filter(
      (c) =>
        costTreatment(enumCode(c.category)) === "staff" &&
        c.amount?.currency === cur &&
        MONTHS[enumCode(c.cadence) ?? ""] !== undefined,
    );
    if (salaries.length > 0) {
      monthly = salaries.reduce(
        (n, c) => n + c.amount!.amount_minor / MONTHS[enumCode(c.cadence)!]!,
        0,
      );
      from = salaries.flatMap((c) => [`${c.key}.amount`, `${c.key}.cadence`]);
      inputs = [
        {
          label: "Staff pay a month",
          value: money(monthly, cur),
          basis: salaries[0]!.amount!.basis,
          source: "the salaries on your costs list",
        },
      ];
    }
  }
  if (monthly === null || cur === null || monthly <= 0) {
    return {
      ...common,
      status: "missing",
      why: "It needs what your employees cost a month.",
      needs: [{ what: "what each employee costs a month", href: BENCH_ASK.staff }],
    };
  }
  const own = (monthly * BENCH.months_a_year) / employees.length;
  const pick = pickCell(s, head.geo, type, sizes, "AVG_EXPN_SAL_BEN_TEUR");
  if (!pick) return noCell(key, head);
  const conv = teurToMinor(s, pick.value.value, cur, pick.cell.year);
  if (!conv)
    return {
      ...common,
      status: "refused",
      why: `I have no euro rate for ${cur} in ${pick.cell.year}, so I can't set Eurostat's figure in your currency.`,
    };
  const reading = readingOf(own, conv.minor);
  const base = {
    unit: "money" as const,
    own: Math.round(own),
    bench: conv.minor,
    currency: cur,
    reading,
  };
  return {
    ...common,
    status: "compared",
    ...base,
    own_words: wholeMoney(own, cur),
    bench_words: wholeMoney(conv.minor, cur),
    gap_words: gapWords(base),
    formula: `${money(monthly, cur)} a month × 12 ÷ ${num(employees.length)} ${employees.length === 1 ? "employee" : "employees"} = ${wholeMoney(own, cur)}`,
    derived_from: [...from, "operations.staff"],
    inputs: [
      ...inputs,
      {
        label: "Employees on your team list",
        value: num(employees.length),
        basis: "STATED",
        source: "your team list, each person marked employee counted once",
      },
    ],
    left_out: [],
    needs: [],
    cell: pick.cell,
    conversion: conversionWords(cur, conv.rate, pick.cell.year),
  };
}

/** Pure: the comparison for one business, from its inputs and the snapshot. */
export function compareWithSimilar(x: BenchInputs, s: Snapshot = SNAPSHOT): BenchResult {
  const code = enumCode(x.business_type);
  if (code === null) {
    return {
      status: "no_type",
      why: "I don't know what kind of business this is yet.",
      needs: [{ what: "what type of business this is", href: BENCH_ASK.type }],
    };
  }
  const entry = typeEntry(code);
  if (entry === null)
    return {
      status: "unmapped",
      type_code: code,
      why: "I have no Eurostat group for this kind of business.",
    };
  if (entry.nace === null) return { status: "unmapped", type_code: code, why: entry.why };
  if (!x.country) {
    return {
      status: "no_country",
      why: "I don't know which country the business is in.",
      needs: [{ what: "which country the business operates in", href: BENCH_ASK.country }],
    };
  }
  const geo = geoFor(x.country.iso);
  if (geo.status === "unknown") {
    return {
      status: "no_country",
      why: `I can't tell which country "${x.country.raw}" is.`,
      needs: [{ what: "which country the business operates in", href: BENCH_ASK.country }],
    };
  }
  if (geo.status === "outside") {
    return {
      status: "outside_eu",
      country: x.country.raw,
      why: `Eurostat's figures cover the 27 EU countries, and ${x.country.raw} isn't one of them.`,
    };
  }
  const size = sizeClassesFor(x.team_size?.value ?? null, x.size_band);
  const first = publishedSizes(s, geo.geo, entry.nace, size.codes)[0] ?? ALL_SIZES.code;
  const head: BenchHead = {
    group: entry.group,
    nace: entry.nace,
    covers: entry.covers,
    geo: geo.geo,
    country: s.geos[geo.geo] ?? geo.geo,
    size: first,
    size_words: sizeWords(first),
    size_via: size.via,
  };
  return {
    status: "ready",
    as_of: x.as_of,
    head,
    lines: [
      marginLine(x, s, entry, head, size.codes),
      purchasesLine(x, s, entry, head, size.codes),
      turnoverLine(x, s, entry, head, size.codes),
      staffLine(x, s, entry, head, size.codes),
    ],
    source: s.source,
    caveat: CAVEAT,
  };
}
