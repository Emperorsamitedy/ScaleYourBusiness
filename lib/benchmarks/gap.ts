// A large benchmark gap — I-44a (decided 2026-11-03, owner: "both"). Pure:
// no database, network, model or clock.
//
// Until I-44a a benchmark only showed, on /benchmarks. The owner decided a
// LARGE gap may also appear in the diagnosis report as a finding and may
// prompt a proposal. What counts as large is decided here, in code, by a
// stated threshold — never by a model — and only for a comparison that is
// like for like. Everything else stays on the screen and nowhere else.
//
// THE THRESHOLD. Only the operating margin (a ratio: no currency is
// converted to compare it), only when its reading is "below" (outside the
// screen's own ±15 % band), and only when the business's margin is at
// least LARGE_GAP.margin_points percentage points under Eurostat's figure:
//
//     Eurostat's GOR_PC − the business's operating margin ≥ 10 points
//
// Eurostat publishes one ratio of totals per cell, not a range, so the
// "lower range" is that figure less the stated amount. 10 points is a tenth
// of every sale; a gap that size isn't arithmetic noise or a definition
// gap (the owner's own pay on the costs list is the usual one, and the
// finding names it). 20 points or more reads HIGH, 10 to 20 MEDIUM.
//
// LIKE FOR LIKE, or nothing:
//   · the cell is the business's own country and its type's own NACE code:
//     no parent-code fallback, and never the EU27_2020 aggregate (I-44b is
//     still undecided);
//   · the size is the class the headcount picked, or the every-size cell
//     the screen falls back to, whose note the finding carries;
//   · every money input is in the revenue's currency: an offer, cost or pay
//     line in another currency (which the margin leaves out) means no gap;
//   · every input is measured, stated, estimated by the owner, or worked
//     out from those: an ASSUMED input means no gap.
//
// The turnover and staff-cost lines never make a gap: both convert
// Eurostat's euros into the business's currency, and both mix price
// levels in a way a margin doesn't.

import type { Basis } from "../../components/report/basis";
import type { DiagnosisFinding, Severity } from "../diagnosis/findings";
import { num } from "../../components/sheet/num";
import { dayMonthYear } from "../i18n/format";
import type { BenchInputs, BenchResult, CellUsed, ComparedLine } from "./compare";
import { CAVEAT } from "./compare";
import { ALL_SIZES } from "./map";

export const LARGE_GAP = {
  /** The margin must sit at least this many percentage points under Eurostat's figure. */
  margin_points: 10,
  /** From this many points under, the finding reads HIGH; below it, MEDIUM. */
  high_points: 20,
} as const;

/** The finding's confidence: its weakest input's, by basis (rule 2, data-model §8.1). */
export const GAP_CONFIDENCE: Readonly<Record<Exclude<Basis, "ASSUMED">, number>> = {
  OBSERVED: 0.8,
  STATED: 0.7,
  DERIVED: 0.6,
  ESTIMATED: 0.5,
};

/** The one aggregate a gap never compares against (I-44b). */
export const EU_AGGREGATE = "EU27_2020";

export interface LargeGap {
  line: "operating_margin";
  /** The business's operating margin, %. */
  own_pct: number;
  /** Eurostat's gross operating rate for the cell, %. */
  bench_pct: number;
  /** bench − own, in percentage points; ≥ LARGE_GAP.margin_points. */
  points: number;
  threshold_points: number;
  severity: Extract<Severity, "high" | "medium">;
  confidence: number;
  group: string;
  country: string;
  cell: CellUsed;
  source: { dataset: string; updated: string; retrieved: string; doi: string };
  formula: string;
  derived_from: string[];
  inputs: { label: string; basis: Basis }[];
  left_out: string[];
  gap_note: string;
}

/** Pure: every money input the margin could read, in the revenue's currency or not. */
function oneCurrency(x: BenchInputs): boolean {
  const cur = x.revenue?.currency;
  if (!cur) return false;
  const money = [
    ...x.offers.flatMap((o) => [o.price, o.cost]),
    ...x.costs.map((c) => c.amount),
    ...(x.staff ?? []).map((s) => s.cost),
  ];
  return money.every((m) => m === null || m.currency === cur);
}

/**
 * Pure: the large margin gap, or null. Null for anything not like for like
 * or under the threshold, so a caller never has to know why.
 */
export function largeGap(result: BenchResult, x: BenchInputs): LargeGap | null {
  if (result.status !== "ready") return null;
  const line = result.lines.find(
    (l): l is ComparedLine => l.key === "operating_margin" && l.status === "compared",
  );
  if (!line || line.reading !== "below") return null;
  const { cell } = line;
  if (cell.geo !== result.head.geo || cell.geo === EU_AGGREGATE) return null;
  if (cell.nace !== result.head.nace) return null;
  if (cell.size !== result.head.size && cell.size !== ALL_SIZES.code) return null;
  if (!oneCurrency(x)) return null;
  if (line.inputs.some((i) => i.basis === "ASSUMED")) return null;
  const points = Math.round((line.bench - line.own) * 10) / 10;
  if (points < LARGE_GAP.margin_points) return null;
  const confidence = Math.min(
    ...line.inputs.map((i) => GAP_CONFIDENCE[i.basis as Exclude<Basis, "ASSUMED">]),
  );
  return {
    line: "operating_margin",
    own_pct: line.own,
    bench_pct: line.bench,
    points,
    threshold_points: LARGE_GAP.margin_points,
    severity: points >= LARGE_GAP.high_points ? "high" : "medium",
    confidence,
    group: result.head.group,
    country: result.head.country,
    cell,
    source: {
      dataset: result.source.dataset,
      updated: result.source.updated,
      retrieved: result.source.retrieved,
      doi: result.source.doi,
    },
    formula: line.formula,
    derived_from: line.derived_from,
    inputs: line.inputs.map((i) => ({ label: i.label, basis: i.basis })),
    left_out: line.left_out,
    gap_note: line.gap_note,
  };
}

const pct = (n: number) => `${num(n, 1)}%`;
const pts = (n: number) => `${num(n, 1)} points`;

/** Pure: "Source: Eurostat, sbs_sc_ovw, updated 30 Sep 2026, retrieved 29 Oct 2026." */
export function gapSource(g: LargeGap): string {
  return `Source: Eurostat, ${g.source.dataset}, updated ${dayMonthYear(g.source.updated, "en")}, retrieved ${dayMonthYear(g.source.retrieved, "en")}.`;
}

/** Pure: the sentences a finding and a proposal share — both figures, the cell, its basis. */
export function gapBasis(g: LargeGap): string {
  const flag = g.cell.flag ? ` (Eurostat marks it ${g.cell.flag})` : "";
  return [
    `Yours works out at ${pct(g.own_pct)}: ${g.formula}.`,
    `Eurostat's figure for ${g.cell.words} is ${pct(g.bench_pct)}${flag}.`,
    ...(g.cell.fallback ? [g.cell.fallback.trim()] : []),
    g.gap_note,
    CAVEAT,
    gapSource(g),
  ].join(" ");
}

/** The finding's evidence key when none of the margin's own keys is in the snapshot. */
const REVENUE_KEY = "revenue.monthly_revenue";

/**
 * Pure: the report finding for a large gap — `kind: "benchmark"`, area
 * finance, citing only the snapshot's own keys the margin rests on (P1-24:
 * a finding with no evidence is no finding, so this returns null).
 */
export function gapFinding(g: LargeGap, factKeys: ReadonlySet<string>): DiagnosisFinding | null {
  const evidence = g.derived_from.filter((k) => factKeys.has(k));
  if (!evidence.includes(REVENUE_KEY)) return null;
  return {
    area: "finance",
    title: `Your operating margin is ${pts(g.points)} below Eurostat's figure for ${g.group} in ${g.country}`,
    detail: gapBasis(g),
    evidence,
    severity: g.severity,
    confidence: g.confidence,
    kind: "benchmark",
  };
}
