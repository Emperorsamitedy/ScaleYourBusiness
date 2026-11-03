// Compared with similar businesses — idea 44, I-44.3. Pure: a few of the
// owner's own numbers set beside one named, dated Eurostat cell each. No
// database, no network, no model, no clock.
//
// Three rules hold everything here:
//
//   · A benchmark is a reference, not a fact about the business. Nothing
//     here makes a Field, a finding or a proposal, and nothing outside the
//     /benchmarks screen reads it (fence.test.ts).
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
//
// L-4b (TASKS-LANGUAGES.md): every sentence here is a "benchmarksWords"
// message, its figures formatted in the reader's locale with the
// business's own currency (never converted — rule 1; Eurostat's euro
// figure is set in that currency as before). The default is English, so
// every caller and test reads what it did; the route passes the request's
// words. Nothing here is stored. Owner-typed labels (a cost line's name)
// and the country as typed stay as given.

import type { Basis } from "../../components/report/basis";
import { moneyText, num } from "../../components/sheet/num";
import type { AppLocale } from "../i18n/locales";
import { intlTag } from "../i18n/locales";
import type { Words } from "../i18n/request-words";
import type { CostLine, CountFact, MoneyFact, OfferLine } from "../cash/model";
import { enumCode } from "../core/enum-value";
import { minorUnitExponent } from "../core/money";
import type { SizeBand } from "../core/size-features";
import type { MappedType, SizePick } from "./map";
import {
  ALL_SIZES,
  BENCHMARK_MAP,
  benchEnglish,
  costTreatment,
  coversWords,
  groupWords,
  insideGrossMargin,
  geoFor,
  parentGroup,
  sizeClassesFor,
  sizeWords,
  typeEntry,
  unmappedWords,
} from "./map";
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
  key: LineKey;
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

/** The caveat in English ("benchmarksWords.caveat"). */
export const CAVEAT = benchEnglish().tr("caveat");

/* ── reading ── */

/** Pure: "above" / "below" / "about the same", within ±15 % of |bench|, the boundary included. */
export function readingOf(own: number, bench: number, band: number = BENCH.same_band): Reading {
  const tolerance = Math.abs(bench) * band;
  const diff = own - bench;
  // A hair of float noise must not tip a value sitting exactly on the boundary.
  if (Math.abs(diff) <= tolerance + 1e-9 * Math.max(1, Math.abs(bench))) return "about the same";
  return diff > 0 ? "above" : "below";
}

const percentFormats = new Map<string, Intl.NumberFormat>();
/** A percent at fixed decimals: English "36.4%" as before; another language its own ("36,4 %"). */
function percentIn(n: number, decimals: number, locale: AppLocale): string {
  if (locale === "en") return `${num(n, decimals)}%`;
  const key = `${locale}|${decimals}`;
  let f = percentFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(intlTag(locale), {
      style: "percent",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    percentFormats.set(key, f);
  }
  return f.format(n / 100);
}
/** A count as the English sentences always printed it (no grouping); the language's own elsewhere. */
const countIn = (n: number, locale: AppLocale) => (locale === "en" ? String(n) : num(n, 0, locale));
/** A whole percent as English always printed it ("12%"); the language's own elsewhere. */
const wholePctIn = (n: number, locale: AppLocale) =>
  locale === "en" ? `${n}%` : percentIn(n, 0, locale);
const pctText = (n: number, w: Words) => percentIn(n, 1, w.locale);
const money = (minor: number, currency: string, w: Words) =>
  moneyText(Math.round(minor), currency, w.locale);
/** Whole major units, for figures a year: "€22,800". */
const wholeMoney = (minor: number, currency: string, w: Words) => {
  const unit = 10 ** minorUnitExponent(currency);
  return moneyText(Math.round(minor / unit) * unit, currency, w.locale);
};

function gapWords(
  line: {
    unit: "percent" | "money";
    own: number;
    bench: number;
    currency: string | null;
    reading: Reading;
  },
  w: Words,
): string {
  const { tr } = w;
  const diff = line.own - line.bench;
  const above = diff >= 0;
  let body: string;
  if (line.unit === "percent") {
    const count = Math.abs(diff);
    body = tr(above ? "gap.pointsAbove" : "gap.pointsBelow", {
      count,
      points: num(count, 1, w.locale),
    });
  } else {
    const share =
      line.bench === 0 ? null : Math.round((Math.abs(diff) / Math.abs(line.bench)) * 100);
    const amount = wholeMoney(Math.abs(diff), line.currency ?? "EUR", w);
    body =
      share === null
        ? tr(above ? "gap.moneyAbove" : "gap.moneyBelow", { amount })
        : tr(above ? "gap.moneyShareAbove" : "gap.moneyShareBelow", {
            amount,
            share: wholePctIn(share, w.locale),
          });
  }
  return line.reading === "about the same" ? tr("gap.same", { gap: body }) : body;
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

/** Said when a line falls back to every size: Eurostat's ratio is of the sector's totals (English). */
export const EVERY_SIZE_NOTE = ` ${benchEnglish().tr("cell.everySize")}`;

/** Eurostat's geo code → the ISO 3166 region Intl names (Greece is EL to Eurostat, GR to ISO). */
const ISO_OF_GEO: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(BENCHMARK_MAP.countries.eurostat_geo).map(([iso, geo]) => [geo, iso]),
);
const regionNames = new Map<string, Intl.DisplayNames>();

/** Pure: a country in the reader's language. English is the snapshot's own name, as before. */
export function countryWords(s: Snapshot, geo: string, w: Words = benchEnglish()): string {
  const english = s.geos[geo] ?? geo;
  if (w.locale === "en") return english;
  const iso = ISO_OF_GEO[geo] ?? geo;
  if (!/^[A-Z]{2}$/.test(iso)) return english;
  try {
    let names = regionNames.get(w.locale);
    if (!names) {
      names = new Intl.DisplayNames([intlTag(w.locale)], { type: "region" });
      regionNames.set(w.locale, names);
    }
    return names.of(iso) ?? english;
  } catch {
    return english;
  }
}

/** Eurostat's flags SYB words itself ("benchmarksWords.flag.<code>"); another keeps the snapshot's English. */
const FLAG_KEYS: ReadonlySet<string> = new Set(["e", "b"]);

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
  w: Words = benchEnglish(),
): Pick | null {
  const { tr } = w;
  const at = cellIndex(s);
  const country = countryWords(s, geo, w);
  const groupOf = (nace: string) =>
    groupWords(nace, nace === type.nace ? type.group : parentGroup(nace), w);
  const sizeOf = (size: string) => sizeWords(size, undefined, w);
  const order: { nace: string; size: string }[] = [];
  for (const nace of [type.nace, ...(type.parent ? [type.parent] : [])]) {
    for (const size of [...publishedSizes(s, geo, nace, sizes), ALL_SIZES.code]) {
      if (!order.some((o) => o.nace === nace && o.size === size)) order.push({ nace, size });
    }
  }
  const first = order[0]!;
  /** The year of a confidential first cell; null when it simply isn't published. */
  let secretYear: number | null = null;
  for (const o of order) {
    const f = at(geo, o.nace, o.size)?.values[metric];
    if (isValue(f)) {
      const both = {
        group: groupOf(first.nace),
        size: sizeOf(first.size),
        country,
        usedGroup: groupOf(o.nace),
        usedSize: sizeOf(o.size),
      };
      const fallback =
        o === first
          ? null
          : (secretYear === null
              ? tr("cell.unpublished", both)
              : tr("cell.confidential", { ...both, year: String(secretYear) })) +
            (o.size === ALL_SIZES.code && first.size !== ALL_SIZES.code
              ? ` ${tr("cell.everySize")}`
              : "");
      return {
        value: f,
        cell: {
          geo,
          nace: o.nace,
          size: o.size,
          year: f.year,
          words: tr("cell.words", {
            group: groupOf(o.nace),
            size: sizeOf(o.size),
            country,
            year: String(f.year),
          }),
          fallback,
          flag: f.flag
            ? FLAG_KEYS.has(f.flag)
              ? tr(`flag.${f.flag}`)
              : (s.flags[f.flag] ?? f.flag)
            : null,
        },
      };
    }
    if (o === first && f && "missing" in f) secretYear = f.year;
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

function conversionWords(currency: string, rate: number, year: number, w: Words): string | null {
  return currency === "EUR"
    ? null
    : w.tr("conversion", {
        rate: num(rate, rate < 10 ? 4 : 2, w.locale),
        currency,
        year: String(year),
        dataset: "ert_bil_eur_a",
      });
}

/* ── the owner's side ── */

const isEmployee = (s: StaffLine) => enumCode(s.engagement) === "employee";
const MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, annual: 12 };

function moneyInput(label: string, f: MoneyFact, w: Words): OwnInput {
  return {
    label,
    value: money(f.amount_minor, f.currency, w),
    basis: f.basis,
    source: f.source,
  };
}

/** Staff pay a month: the costs list's salaries, else the team list's employees, else unknown. */
function staffPay(
  x: BenchInputs,
  currency: string,
  w: Words,
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
        why: w.tr("why.unpricedEmployees", {
          count: unpriced.length,
          n: countIn(unpriced.length, w.locale),
          currency,
        }),
        needs: [{ what: w.tr("need.employeeCost"), href: BENCH_ASK.staff }],
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
                label: w.tr("input.staffTeam", {
                  count: employees.length,
                  n: countIn(employees.length, w.locale),
                }),
                value: money(minor, currency, w),
                basis: employees[0]!.cost!.basis,
                source: w.tr("input.teamList"),
              },
            ]
          : [],
      source: employees.length > 0 ? "team" : "none",
    };
  }
  if (x.team_size && x.team_size.value <= 1)
    return { minor: 0, from: [], inputs: [], source: "none" };
  return {
    why: w.tr("why.unknownStaff"),
    needs: [{ what: w.tr("need.whoAndCost"), href: BENCH_ASK.staff }],
  };
}

/** Pure: the operating margin, or what it needs. */
export function ownMargin(
  x: BenchInputs,
  w: Words = benchEnglish(),
):
  | {
      pct: number;
      formula: string;
      derived_from: string[];
      inputs: OwnInput[];
      left_out: string[];
      needs: Need[];
    }
  | { needs: Need[]; why: string } {
  const { tr } = w;
  const r = x.revenue;
  if (!r)
    return {
      why: tr("why.needsRevenue"),
      needs: [{ what: tr("need.revenue"), href: BENCH_ASK.revenue }],
    };
  if (r.amount_minor <= 0) return { why: tr("why.zeroRevenue"), needs: [] };
  const cur = r.currency;
  const same = (m: MoneyFact | null): m is MoneyFact => m !== null && m.currency === cur;
  const derived = ["revenue.monthly_revenue"];
  const inputs: OwnInput[] = [moneyInput(tr("input.revenue"), r, w)];
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
      label: tr("input.costOfSales"),
      value: tr("input.ofSales", { share: pctText(costShare * 100, w) }),
      basis: "DERIVED",
      source: tr("input.offersSource", {
        count: sold.length,
        n: countIn(sold.length, w.locale),
      }),
    });
  } else if (x.gross_margin && x.gross_margin.value >= 0 && x.gross_margin.value <= 100) {
    fromGrossMargin = true;
    costShare = 1 - x.gross_margin.value / 100;
    derived.push("costs.gross_margin");
    inputs.push({
      label: tr("input.costOfSales"),
      value: tr("input.ofSales", { share: pctText(costShare * 100, w) }),
      basis: x.gross_margin.basis,
      source: tr("input.marginSource", {
        whole: wholePctIn(100, w.locale),
        margin: pctText(x.gross_margin.value, w),
      }),
    });
  } else {
    return {
      why: tr("why.needsCostOfSales"),
      needs: [
        { what: tr("need.offerCosts"), href: BENCH_ASK.offers },
        { what: tr("need.grossMargin"), href: BENCH_ASK.gross_margin },
      ],
    };
  }
  const costOfSales = r.amount_minor * costShare;

  // Review 2026-10-30: a stated gross margin already took these off; never twice.
  const alreadyIn = (c: CostLine): boolean => {
    if (!fromGrossMargin || !insideGrossMargin(enumCode(c.category))) return false;
    leftOut.push(tr("leftOut.inGrossMargin", { label: c.label }));
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
        amount
          ? tr("leftOut.otherCurrency", { label: c.label, currency: amount.currency, own: cur })
          : tr("leftOut.noAmount", { label: c.label }),
      );
      missed(c);
      continue;
    }
    const count = cadence === "per_unit" ? units : (x.orders_month?.value ?? null);
    if (count === null) {
      missed(c);
      leftOut.push(
        tr(cadence === "per_unit" ? "leftOut.perPiece" : "leftOut.perOrder", { label: c.label }),
      );
      needs.push(
        cadence === "per_unit"
          ? { what: tr("need.offerVolumes"), href: BENCH_ASK.offers }
          : { what: tr("need.orders"), href: BENCH_ASK.orders },
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
      leftOut.push(tr("leftOut.loan", { label: c.label }));
      continue;
    }
    if (!c.amount) {
      leftOut.push(tr("leftOut.noAmount", { label: c.label }));
      needs.push({ what: tr("need.amountOf", { label: c.label }), href: BENCH_ASK.costs });
      missed(c);
      continue;
    }
    if (c.amount.currency !== cur) {
      leftOut.push(tr("leftOut.noConvert", { label: c.label, currency: c.amount.currency }));
      missed(c);
      continue;
    }
    const months = cadence === null ? undefined : MONTHS[cadence];
    if (months === undefined) {
      leftOut.push(tr("leftOut.noFrequency", { label: c.label }));
      needs.push({ what: tr("need.howOften", { label: c.label }), href: BENCH_ASK.costs });
      missed(c);
      continue;
    }
    running += c.amount.amount_minor / months;
    derived.push(`${c.key}.amount`, `${c.key}.cadence`);
  }

  if (staffMissed.length > 0) {
    return {
      why: tr("why.payLines", {
        count: staffMissed.length,
        n: countIn(staffMissed.length, w.locale),
        label: staffMissed[0]!,
        currency: cur,
      }),
      needs: [{ what: tr("need.salaries", { currency: cur }), href: BENCH_ASK.costs }],
    };
  }
  const staff = staffPay(x, cur, w);
  if ("needs" in staff) return { why: staff.why, needs: staff.needs };
  derived.push(...staff.from);

  if (perSale > 0)
    inputs.push({
      label: tr("input.perSale"),
      value: wholeMoney(perSale, cur, w),
      basis: "DERIVED",
      source: tr("input.perSaleSource"),
    });
  if (running > 0)
    inputs.push({
      label: tr("input.running"),
      value: wholeMoney(running, cur, w),
      basis: "DERIVED",
      source: tr(staff.source === "costs" ? "input.runningStaffSource" : "input.runningSource"),
    });
  inputs.push(...staff.inputs);

  const surplus = r.amount_minor - costOfSales - perSale - running - staff.minor;
  const pct = Math.round((surplus / r.amount_minor) * 1000) / 10;
  const part = (key: string, minor: number) => tr(key, { amount: wholeMoney(minor, cur, w) });
  const parts = [
    part("formula.revenue", r.amount_minor),
    part("formula.costOfSales", costOfSales),
    ...(perSale > 0 ? [part("formula.perSale", perSale)] : []),
    ...(running > 0 ? [part("formula.running", running)] : []),
    ...(staff.minor > 0 ? [part("formula.staff", staff.minor)] : []),
  ];
  return {
    pct,
    formula: tr("formula.margin", {
      parts: parts.join(" − "),
      revenue: wholeMoney(r.amount_minor, cur, w),
      hundred: num(100, 0, w.locale),
      result: pctText(pct, w),
    }),
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

/** A line's key, title and gap note ("benchmarksWords.title.<key>", "gapNote.<key>"). */
function lineBase(key: LineKey, w: Words): LineBase {
  return { key, title: w.tr(`title.${key}`), gap_note: w.tr(`gapNote.${key}`) };
}

function noCell(key: LineKey, head: BenchHead, w: Words): RefusedLine {
  return {
    ...lineBase(key, w),
    status: "refused",
    why: w.tr("why.noCell", { group: head.group, country: head.country }),
  };
}

function marginLine(
  x: BenchInputs,
  s: Snapshot,
  type: MappedType,
  head: BenchHead,
  sizes: string[],
  w: Words,
): BenchLine {
  const key = "operating_margin";
  const own = ownMargin(x, w);
  if ("why" in own)
    return {
      ...lineBase(key, w),
      status: "missing",
      why: own.why,
      needs: own.needs,
    };
  const pick = pickCell(s, head.geo, type, sizes, "GOR_PC", w);
  if (!pick) return noCell(key, head, w);
  const reading = readingOf(own.pct, pick.value.value);
  const base = {
    unit: "percent" as const,
    own: own.pct,
    bench: pick.value.value,
    currency: null,
    reading,
  };
  return {
    ...lineBase(key, w),
    status: "compared",
    ...base,
    own_words: pctText(own.pct, w),
    bench_words: pctText(pick.value.value, w),
    gap_words: gapWords(base, w),
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
  w: Words,
): BenchLine {
  const { tr } = w;
  const key = "turnover_per_person";
  const needs: Need[] = [];
  if (!x.revenue) needs.push({ what: tr("need.revenue"), href: BENCH_ASK.revenue });
  if (!x.team_size || x.team_size.value < 1)
    needs.push({ what: tr("need.teamSize"), href: BENCH_ASK.team_size });
  if (needs.length > 0 || !x.revenue || !x.team_size) {
    return {
      ...lineBase(key, w),
      status: "missing",
      why: tr("why.needsTurnover"),
      needs,
    };
  }
  const r = x.revenue;
  const persons = x.team_size.value;
  const own = (r.amount_minor * BENCH.months_a_year) / persons;
  const pick = pickCell(s, head.geo, type, sizes, "NETTUR_EMP_TEUR", w);
  if (!pick) return noCell(key, head, w);
  const conv = teurToMinor(s, pick.value.value, r.currency, pick.cell.year);
  if (!conv) {
    return {
      ...lineBase(key, w),
      status: "refused",
      why: tr("why.noRate", { currency: r.currency, year: String(pick.cell.year) }),
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
    ...lineBase(key, w),
    status: "compared",
    ...base,
    own_words: wholeMoney(own, r.currency, w),
    bench_words: wholeMoney(conv.minor, r.currency, w),
    gap_words: gapWords(base, w),
    formula: tr("formula.turnover", {
      amount: money(r.amount_minor, r.currency, w),
      months: num(BENCH.months_a_year, 0, w.locale),
      count: persons,
      persons: num(persons, 0, w.locale),
      result: wholeMoney(own, r.currency, w),
    }),
    derived_from: ["revenue.monthly_revenue", "identity.team_size"],
    inputs: [
      moneyInput(tr("input.revenue"), r, w),
      {
        label: tr("input.people"),
        value: num(persons, 0, w.locale),
        basis: x.team_size.basis,
        source: x.team_size.source,
      },
    ],
    left_out: [],
    needs: [],
    cell: pick.cell,
    conversion: conversionWords(r.currency, conv.rate, pick.cell.year, w),
  };
}

function staffLine(
  x: BenchInputs,
  s: Snapshot,
  type: MappedType,
  head: BenchHead,
  sizes: string[],
  w: Words,
): BenchLine {
  const { tr } = w;
  const key = "staff_cost_per_employee";
  const common = lineBase(key, w);
  if (x.staff === null) {
    return {
      ...common,
      status: "missing",
      why: tr("why.needsTeam"),
      needs: [{ what: tr("need.team"), href: BENCH_ASK.staff }],
    };
  }
  const employees = x.staff.filter(isEmployee);
  if (employees.length === 0)
    return {
      ...common,
      status: "refused",
      why: tr("why.noEmployees"),
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
        label: tr("input.staffMonth"),
        value: money(monthly, cur, w),
        basis: employees[0]!.cost!.basis,
        source: tr("input.teamList"),
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
          label: tr("input.staffMonth"),
          value: money(monthly, cur, w),
          basis: salaries[0]!.amount!.basis,
          source: tr("input.salariesSource"),
        },
      ];
    }
  }
  if (monthly === null || cur === null || monthly <= 0) {
    return {
      ...common,
      status: "missing",
      why: tr("why.needsStaffCost"),
      needs: [{ what: tr("need.employeeCost"), href: BENCH_ASK.staff }],
    };
  }
  const own = (monthly * BENCH.months_a_year) / employees.length;
  const pick = pickCell(s, head.geo, type, sizes, "AVG_EXPN_SAL_BEN_TEUR", w);
  if (!pick) return noCell(key, head, w);
  const conv = teurToMinor(s, pick.value.value, cur, pick.cell.year);
  if (!conv)
    return {
      ...common,
      status: "refused",
      why: tr("why.noRate", { currency: cur, year: String(pick.cell.year) }),
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
    own_words: wholeMoney(own, cur, w),
    bench_words: wholeMoney(conv.minor, cur, w),
    gap_words: gapWords(base, w),
    formula: tr("formula.staffCost", {
      amount: money(monthly, cur, w),
      months: num(BENCH.months_a_year, 0, w.locale),
      count: employees.length,
      employees: num(employees.length, 0, w.locale),
      result: wholeMoney(own, cur, w),
    }),
    derived_from: [...from, "operations.staff"],
    inputs: [
      ...inputs,
      {
        label: tr("input.employees"),
        value: num(employees.length, 0, w.locale),
        basis: "STATED",
        source: tr("input.employeesSource"),
      },
    ],
    left_out: [],
    needs: [],
    cell: pick.cell,
    conversion: conversionWords(cur, conv.rate, pick.cell.year, w),
  };
}

/** Pure: the comparison for one business, from its inputs and the snapshot, in `w`'s language. */
export function compareWithSimilar(
  x: BenchInputs,
  s: Snapshot = SNAPSHOT,
  w: Words = benchEnglish(),
): BenchResult {
  const { tr } = w;
  const code = enumCode(x.business_type);
  if (code === null) {
    return {
      status: "no_type",
      why: tr("why.noType"),
      needs: [{ what: tr("need.type"), href: BENCH_ASK.type }],
    };
  }
  const entry = typeEntry(code);
  if (entry === null)
    return {
      status: "unmapped",
      type_code: code,
      why: tr("why.noGroup"),
    };
  if (entry.nace === null)
    return { status: "unmapped", type_code: code, why: unmappedWords(code, entry.why, w) };
  if (!x.country) {
    return {
      status: "no_country",
      why: tr("why.noCountry"),
      needs: [{ what: tr("need.country"), href: BENCH_ASK.country }],
    };
  }
  const geo = geoFor(x.country.iso);
  if (geo.status === "unknown") {
    return {
      status: "no_country",
      why: tr("why.unknownCountry", { country: x.country.raw }),
      needs: [{ what: tr("need.country"), href: BENCH_ASK.country }],
    };
  }
  if (geo.status === "outside") {
    return {
      status: "outside_eu",
      country: x.country.raw,
      why: tr("why.outsideEu", {
        count: num(BENCHMARK_MAP.countries.eu27.length, 0, w.locale),
        country: x.country.raw,
      }),
    };
  }
  const size = sizeClassesFor(x.team_size?.value ?? null, x.size_band);
  const first = publishedSizes(s, geo.geo, entry.nace, size.codes)[0] ?? ALL_SIZES.code;
  const head: BenchHead = {
    group: groupWords(entry.nace, entry.group, w),
    nace: entry.nace,
    covers: coversWords(entry.nace, entry.covers, w),
    geo: geo.geo,
    country: countryWords(s, geo.geo, w),
    size: first,
    size_words: sizeWords(first, undefined, w),
    size_via: size.via,
  };
  return {
    status: "ready",
    as_of: x.as_of,
    head,
    lines: [
      marginLine(x, s, entry, head, size.codes, w),
      turnoverLine(x, s, entry, head, size.codes, w),
      staffLine(x, s, entry, head, size.codes, w),
    ],
    source: s.source,
    caveat: tr("caveat"),
  };
}
