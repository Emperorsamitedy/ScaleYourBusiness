// The market's side of an idea check — TASKS-IDEAS.md I-03, I-21. Pure.
//
// Three Eurostat references, each a grade C base rate with its table, year
// and cell (rule 37), set BESIDE the plan and never merged into it:
//
//   survival          bd_9bd_sz_cl_r2's 1-, 3- and 5-year survival rates
//                     for the type's NACE code in the country, else its
//                     parent group, said so (specs/business-demography-v1.json)
//   operating margin  the plan's monthly profit ÷ revenue at full plan,
//                     against sbs_sc_ovw's gross operating rate
//   revenue / person  the plan's revenue × 12 ÷ the team, against
//                     sbs_sc_ovw's net turnover per person employed,
//                     converted at that year's average rate (rule 1)
//
// The survival rates are about businesses of that kind, not this idea
// (rule 36): the words say "of new businesses like this", always.

import demography from "../../specs/business-demography-v1.json";
import type { CellUsed, Reading } from "../benchmarks/compare";
import { pickCell, readingOf, teurToMinor } from "../benchmarks/compare";
import type { MappedType } from "../benchmarks/map";
import {
  benchEnglish,
  geoFor,
  groupWords,
  isMapped,
  parentGroup,
  sizeClassesFor,
  typeEntry,
} from "../benchmarks/map";
import { SNAPSHOT } from "../benchmarks/snapshot";
import { perUnit } from "../core/money";
import type { Words } from "../i18n/request-words";

type Rate = { value: number; year: number; flag?: string } | { missing: string; year?: number };
interface DemoCell {
  geo: string;
  nace: string;
  rates: Partial<Record<"y1" | "y3" | "y5", Rate>>;
}
const CELLS = (demography as unknown as { cells: DemoCell[] }).cells;
const BY_KEY = new Map(CELLS.map((c) => [`${c.geo}|${c.nace}`, c]));

export const DEMOGRAPHY_SOURCE = {
  dataset: (demography as { source: { dataset: string } }).source.dataset,
  retrieved: (demography as { source: { retrieved: string } }).source.retrieved,
};

export interface SurvivalRate {
  /** Percent, as Eurostat publishes it (not money). */
  pct: number;
  year: number;
  /** Eurostat's flag ("b": break in series), when there is one. */
  flag: string | null;
}

export type Survival =
  | {
      status: "shown";
      geo: string;
      nace: string;
      /** The group in the reader's words: "restaurants, cafés and bars". */
      group: string;
      /** True when the type's own code had no rates and its parent group's are shown. */
      parent: boolean;
      y1: SurvivalRate | null;
      y3: SurvivalRate | null;
      y5: SurvivalRate | null;
      dataset: string;
    }
  | { status: "none"; why: "unmapped" | "outside_eu" | "unpublished" };

const rateOf = (r: Rate | undefined): SurvivalRate | null =>
  r && "value" in r ? { pct: r.value, year: r.year, flag: r.flag ?? null } : null;

/** Survival rates for a business type in a country: its own code, then its parent. Never another country. */
export function survivalFor(typeCode: string, iso: string, w: Words = benchEnglish()): Survival {
  const type = typeEntry(typeCode);
  if (!isMapped(type)) return { status: "none", why: "unmapped" };
  const g = geoFor(iso);
  if (g.status !== "eu") return { status: "none", why: "outside_eu" };
  for (const nace of [type.nace, ...(type.parent ? [type.parent] : [])]) {
    const cell = BY_KEY.get(`${g.geo}|${nace}`);
    if (!cell) continue;
    const y1 = rateOf(cell.rates.y1);
    const y3 = rateOf(cell.rates.y3);
    const y5 = rateOf(cell.rates.y5);
    if (!y1 && !y3 && !y5) continue;
    return {
      status: "shown",
      geo: g.geo,
      nace,
      group: groupWords(nace, nace === type.nace ? type.group : parentGroup(nace), w),
      parent: nace !== type.nace,
      y1,
      y3,
      y5,
      dataset: DEMOGRAPHY_SOURCE.dataset,
    };
  }
  return { status: "none", why: "unpublished" };
}

export interface SectorLine {
  unit: "percent" | "money";
  /** Percent, or integer minor units of `currency`. */
  own: number;
  bench: number;
  currency: string | null;
  reading: Reading;
  cell: CellUsed;
}

/** The plan's margin and revenue per person beside Eurostat's, where both sides exist. */
export function sectorLines(args: {
  typeCode: string;
  iso: string;
  team: number;
  currency: string;
  /** At full plan; null when the customers aren't known. */
  at_plan: { revenue_minor: number; margin_bp: number | null } | null;
  w?: Words;
}): { margin: SectorLine | null; per_person: SectorLine | null } {
  const none = { margin: null, per_person: null };
  const type = typeEntry(args.typeCode);
  const g = geoFor(args.iso);
  if (!isMapped(type) || g.status !== "eu" || !args.at_plan) return none;
  const w = args.w ?? benchEnglish();
  const sizes = sizeClassesFor(args.team, null).codes;
  const mapped: MappedType = type;

  let margin: SectorLine | null = null;
  const gor = pickCell(SNAPSHOT, g.geo, mapped, sizes, "GOR_PC", w);
  if (gor && args.at_plan.margin_bp !== null) {
    const own = args.at_plan.margin_bp / 100; // not money: basis points shown as a percent
    margin = {
      unit: "percent",
      own,
      bench: gor.value.value,
      currency: null,
      reading: readingOf(own, gor.value.value),
      cell: gor.cell,
    };
  }

  let perPerson: SectorLine | null = null;
  const tpp = pickCell(SNAPSHOT, g.geo, mapped, sizes, "NETTUR_EMP_TEUR", w);
  if (tpp) {
    const bench = teurToMinor(SNAPSHOT, tpp.value.value, args.currency, tpp.cell.year);
    if (bench) {
      const own = perUnit(args.at_plan.revenue_minor * 12, args.team);
      perPerson = {
        unit: "money",
        own,
        bench: bench.minor,
        currency: args.currency,
        reading: readingOf(own, bench.minor),
        cell: tpp.cell,
      };
    }
  }
  return { margin, per_person: perPerson };
}
