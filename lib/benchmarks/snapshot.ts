// The Eurostat snapshot, read — idea 44. specs/benchmarks-eurostat-v1.json
// is written by hand with `npm run benchmarks:fetch` (I-44.1) and committed;
// this is the only way the app reaches it. No network, no model, no
// database: a benchmark is a published reference, never a fact about the
// business (it is never a Field, and nothing here writes one).

import raw from "../../specs/benchmarks-eurostat-v1.json";

/** The figures each cell may carry. PUR_SHARE_PC is worked out from PUR_MEUR ÷ NETTUR_MEUR. */
export const METRICS = [
  "GOR_PC",
  "NETTUR_EMP_TEUR",
  "AVG_EXPN_SAL_BEN_TEUR",
  "PUR_SHARE_PC",
] as const;
export type Metric = (typeof METRICS)[number];

/** A published figure: its value as Eurostat printed it, its year, and its flag if any. */
export interface BenchValue {
  value: number;
  year: number;
  /** Eurostat's flag beside the value: "e" estimated, "b" a break in the series. */
  flag?: string;
  /** Only on a figure SYB worked out from two of Eurostat's. */
  derived_from?: string[];
}
export interface BenchSecret {
  missing: "confidential";
  year: number;
}
export type BenchFigure = BenchValue | BenchSecret;

export interface BenchCell {
  geo: string;
  nace: string;
  size: string;
  /** A metric left out was never published for the cell: missing, never zero. */
  values: Partial<Record<Metric, BenchFigure>>;
}

export interface BenchSource {
  publisher: string;
  dataset: string;
  label: string;
  doi: string;
  /** Eurostat's own last update of the dataset, YYYY-MM-DD. */
  updated: string;
  /** When the snapshot was fetched, YYYY-MM-DD. */
  retrieved: string;
  url_pattern: string;
  licence: string;
  attribution: string;
  modified: string;
}

export interface Snapshot {
  version: string;
  source: BenchSource;
  indicators: Record<string, string>;
  flags: Record<string, string>;
  geos: Record<string, string>;
  nace: Record<string, string>;
  sizes: Record<string, string>;
  fx: {
    dataset: string;
    label: string;
    updated: string;
    statinfo: string;
    unit: string;
    meaning: string;
    /** currency → year → units of the currency per euro, the year's average. */
    rates: Record<string, Record<string, number>>;
  };
  absent: string;
  coverage: string[];
  cells: BenchCell[];
}

export const SNAPSHOT = raw as unknown as Snapshot;

export function isValue(f: BenchFigure | undefined): f is BenchValue {
  return f !== undefined && "value" in f;
}

const key = (geo: string, nace: string, size: string) => `${geo}|${nace}|${size}`;

/** Pure: a lookup over a snapshot's cells. */
export function cellIndex(
  s: Snapshot,
): (geo: string, nace: string, size: string) => BenchCell | null {
  const byKey = new Map(s.cells.map((c) => [key(c.geo, c.nace, c.size), c]));
  return (geo, nace, size) => byKey.get(key(geo, nace, size)) ?? null;
}

/** Pure: units of `currency` per euro in `year`, from the snapshot; 1 for the euro; null unknown. */
export function eurRate(s: Snapshot, currency: string, year: number): number | null {
  if (currency === "EUR") return 1;
  const r = s.fx.rates[currency]?.[String(year)];
  return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : null;
}
