// The peer cohort — the v1 build spec §5 (P7-60..62). Pure.
//
// A cohort is NACE × geography × revenue band × calendar month
// (specs/peer-cohorts-v1.json). It widens in one deterministic order —
// NACE 4 → 3 → 2, then country → region, then band → every band — and
// every served benchmark records which widenings were applied.
//
// `distribution` is the floor (§5.2), and nothing else in the app computes
// an aggregate over other businesses: at least 7 businesses, and no single
// business above 25 % of the cohort's revenue or of the metric's own
// numerator or denominator. Below either, the answer is exactly
// { shown: false } — no number, no rounding, no bucket, no count.
//
// What it serves is a distribution, never an average (§5.3): p25, p50,
// p75 over the members' own values, and the reader's percentile among them.
// Values are integers — minor units for money, basis points for a share —
// and the quartiles come out of one exact integer division.

import cohortsFile from "../../specs/peer-cohorts-v1.json";
import { scaleMinorBy } from "../core/money";

const SPEC = cohortsFile as {
  floor: { min_businesses: number; max_share: number };
  period: { min_days: number };
  nace: { business_types: Record<string, string | null> };
  regions: Record<string, string[] | string>;
  revenue_bands: { bands: { id: string; from: number; to: number | null }[] };
};

export const COHORT_K = SPEC.floor.min_businesses;
export const COHORT_MAX_SHARE = SPEC.floor.max_share;
export const MIN_DAYS_IN_MONTH = SPEC.period.min_days;

// ── The metrics (§5.3) ───────────────────────────────────────────────────

/**
 * §5.3's table. `measured: false` is a metric SYB has no measured source for
 * yet: it is shown as "not measured yet", never filled from what an owner
 * said. A money metric pools only businesses in the reader's currency (D44).
 */
export const PEER_METRICS = {
  average_order_value: { unit: "money", measured: true },
  revenue_per_employee: { unit: "money", measured: true },
  ad_spend_share: { unit: "bp", measured: true },
  no_show_rate: { unit: "bp", measured: true },
  gross_margin: { unit: "bp", measured: false },
  repeat_customer_rate: { unit: "bp", measured: false },
  cac_payback: { unit: "weeks", measured: false },
  busiest_hours: { unit: "hours", measured: false },
  stock_turns: { unit: "turns", measured: false },
} as const;

export type PeerMetric = keyof typeof PEER_METRICS;
export const MEASURED_METRICS = (Object.keys(PEER_METRICS) as PeerMetric[]).filter(
  (m) => PEER_METRICS[m].measured,
);

// ── Members ──────────────────────────────────────────────────────────────

export interface MemberValue {
  /** Minor units (money) or basis points (a share). */
  value: number;
  /** What the value is made of, for the dominance check. */
  numerator: number;
  denominator: number;
  /** A money value's currency (its numerator's too); null for a share of counts. */
  currency: string | null;
}

/** One business's month, as the pool read it: measured values only. */
export interface Member {
  business: string;
  nace: string | null;
  country: string | null;
  band: string | null;
  /** The month's revenue in euro cents, for the band and the revenue-share check only. */
  revenue_eur_minor: number;
  values: Partial<Record<PeerMetric, MemberValue>>;
}

// ── Cohort dimensions ────────────────────────────────────────────────────

export type NaceLevel = 4 | 3 | 2 | 1;

/** The finest NACE code SYB reads for a business type, or null. */
export function naceOfType(type: string | null): string | null {
  return type === null ? null : (SPEC.nace.business_types[type] ?? null);
}

/** "56.30" → 4, "56.3" → 3, "56" → 2, "F" → 1 (a section letter). */
export function naceLevel(code: string): NaceLevel {
  if (/^\d{2}\.\d{2}$/.test(code)) return 4;
  if (/^\d{2}\.\d$/.test(code)) return 3;
  if (/^\d{2}$/.test(code)) return 2;
  if (/^[A-U]$/.test(code)) return 1;
  throw new Error(`not a NACE code: ${code}`);
}

/** The code at a coarser level: "56.30" at 3 is "56.3", at 2 "56". Null when finer than the code. */
export function naceAt(code: string, level: NaceLevel): string | null {
  const own = naceLevel(code);
  if (level > own) return null;
  if (own === 1) return level === 1 ? code : null;
  if (level === 1) return null;
  if (level === own) return code;
  return level === 3 ? code.slice(0, 4) : code.slice(0, 2);
}

export interface Region {
  id: string;
  countries: string[];
}

export function regionOf(country: string): Region | null {
  for (const [id, list] of Object.entries(SPEC.regions)) {
    if (id === "about" || !Array.isArray(list)) continue;
    if (list.includes(country)) return { id, countries: [...list] };
  }
  return null;
}

export const BAND_IDS = SPEC.revenue_bands.bands.map((b) => b.id);

/** A year's revenue in euro cents → its band. */
export function bandOf(yearEurMinor: number): string {
  for (const b of SPEC.revenue_bands.bands) {
    if (yearEurMinor >= b.from && (b.to === null || yearEurMinor < b.to)) return b.id;
  }
  return BAND_IDS[0]!;
}

export interface CohortSpec {
  /** The NACE code at the level used. */
  nace: string;
  nace_level: NaceLevel;
  geography:
    { kind: "country"; code: string } | { kind: "region"; id: string; countries: string[] };
  /** A band id, or "any" once the band is widened away. */
  band: string;
}

export type Widening = "nace_3" | "nace_2" | "region" | "any_band";

/**
 * The deterministic widening ladder for a reader (§5.1): NACE first (as far
 * as 2-digit), then country → region, then the band. Each rung lists the
 * widenings applied to reach it.
 */
export function cohortLadder(reader: {
  nace: string;
  country: string;
  band: string;
}): { spec: CohortSpec; widened: Widening[] }[] {
  const out: { spec: CohortSpec; widened: Widening[] }[] = [];
  const start = naceLevel(reader.nace);
  const floor: NaceLevel = start === 1 ? 1 : 2;
  const widened: Widening[] = [];
  let level: NaceLevel = start;
  const country = { kind: "country" as const, code: reader.country };
  for (;;) {
    out.push({
      spec: {
        nace: naceAt(reader.nace, level)!,
        nace_level: level,
        geography: country,
        band: reader.band,
      },
      widened: [...widened],
    });
    if (level <= floor) break;
    level = (level - 1) as NaceLevel;
    widened.push(level === 3 ? "nace_3" : "nace_2");
  }
  const nace = naceAt(reader.nace, level)!;
  const region = regionOf(reader.country);
  let geography: CohortSpec["geography"] = country;
  if (region && region.countries.length > 1) {
    widened.push("region");
    geography = { kind: "region", id: region.id, countries: region.countries };
    out.push({
      spec: { nace, nace_level: level, geography, band: reader.band },
      widened: [...widened],
    });
  }
  // A reader with no band known starts at every band; there is nothing left to widen.
  if (reader.band !== "any") {
    widened.push("any_band");
    out.push({ spec: { nace, nace_level: level, geography, band: "any" }, widened: [...widened] });
  }
  return out;
}

// ── Precision (D90) ──────────────────────────────────────────────────────

/**
 * The floor protects privacy, not precision: at seven businesses the median
 * is one of them. Below this many, a served comparison is a rough guide.
 */
export const PRECISION_FAIR_FROM = 20;

export type PrecisionReason = "few_businesses" | "wide_industry" | "wide_area" | "any_size";
export interface Precision {
  level: "fair" | "rough";
  reasons: PrecisionReason[];
}

/**
 * Pure: how far a served comparison can be leaned on. A 3-digit NACE
 * widening stays fair (a close neighbour); widening to the 2-digit
 * division, to a region, or to every size makes it rough, as does a small
 * cohort. Rough is said in words beside the figure, never hidden.
 */
export function precisionOf(businesses: number, widened: readonly Widening[]): Precision {
  const reasons: PrecisionReason[] = [];
  if (businesses < PRECISION_FAIR_FROM) reasons.push("few_businesses");
  if (widened.includes("nace_2")) reasons.push("wide_industry");
  if (widened.includes("region")) reasons.push("wide_area");
  if (widened.includes("any_band")) reasons.push("any_size");
  return { level: reasons.length > 0 ? "rough" : "fair", reasons };
}

/** Pure: is this member inside this cohort? */
export function inCohort(m: Member, spec: CohortSpec): boolean {
  if (m.nace === null || m.country === null || m.band === null) return false;
  if (naceAt(m.nace, spec.nace_level) !== spec.nace) return false;
  const inPlace =
    spec.geography.kind === "country"
      ? m.country === spec.geography.code
      : spec.geography.countries.includes(m.country);
  if (!inPlace) return false;
  return spec.band === "any" || m.band === spec.band;
}

// ── The floor and the distribution (§5.2, §5.3) ──────────────────────────

export type Distribution =
  | {
      shown: true;
      p25: number;
      p50: number;
      p75: number;
      businesses: number;
      currency: string | null;
      /** The reader's own percentile among the members, when the reader's value is given. */
      own_percentile: number | null;
    }
  | { shown: false };

const SUPPRESSED = Object.freeze({ shown: false as const });

function dominated(parts: readonly number[]): boolean {
  let total = 0;
  for (const p of parts) total += p;
  // Nothing to hold a share of (no one missed an appointment): no one dominates.
  if (total <= 0) return false;
  // part / total > max share, in integers: part × 100 > total × share × 100
  const shareHundredths = Math.round(COHORT_MAX_SHARE * 100); // not money: the 25 % floor
  return parts.some((p) => p * 100 > total * shareHundredths);
}

/** The quartile at k ∈ {1,2,3} of sorted integers: linear between ranks, one exact division. */
function quartile(sorted: readonly number[], k: 1 | 2 | 3): number {
  const pos = (sorted.length - 1) * k; // rank × 4
  const i = Math.floor(pos / 4);
  const q = pos % 4;
  if (q === 0) return sorted[i]!;
  return scaleMinorBy(sorted[i]! * (4 - q) + sorted[i + 1]! * q, 1, 4);
}

/**
 * The query layer's floor. Members are already in the cohort; the reader is
 * never among them. A money metric keeps only the reader's currency.
 */
export function distribution(
  members: readonly Member[],
  metric: PeerMetric,
  readerCurrency: string | null,
  /** The reader's own value (same unit), for their percentile; it never joins the members. */
  own: number | null = null,
): Distribution {
  if (!PEER_METRICS[metric].measured) return { ...SUPPRESSED };
  const money = PEER_METRICS[metric].unit === "money";
  const rows: { m: Member; v: MemberValue }[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    const v = m.values[metric];
    if (!v || seen.has(m.business)) continue;
    if (money && (readerCurrency === null || v.currency !== readerCurrency)) continue;
    seen.add(m.business);
    rows.push({ m, v });
  }
  if (rows.length < COHORT_K) return { ...SUPPRESSED };
  // §5.2: no single business above 25 % of the cohort's revenue…
  if (dominated(rows.map((r) => r.m.revenue_eur_minor))) return { ...SUPPRESSED };
  // …nor of the metric's own numerator or denominator, where those add up.
  // Parts add up only in one currency (or as counts); across currencies the
  // revenue check above, in euro for weighting only, is the one that holds.
  const currencies = new Set(rows.map((r) => r.v.currency));
  if (currencies.size === 1) {
    if (dominated(rows.map((r) => r.v.numerator))) return { ...SUPPRESSED };
    if (dominated(rows.map((r) => r.v.denominator))) return { ...SUPPRESSED };
  }

  const sorted = rows.map((r) => r.v.value).sort((a, b) => a - b);
  return {
    shown: true,
    p25: quartile(sorted, 1),
    p50: quartile(sorted, 2),
    p75: quartile(sorted, 3),
    businesses: rows.length,
    currency: money ? readerCurrency : null,
    // The members' values stay here: only the quartiles and a percentile leave.
    own_percentile: own === null ? null : percentileOf(sorted, own),
  };
}

/** The reader's percentile among the cohort's values: below, plus half of equal, as a whole %. */
export function percentileOf(sorted: readonly number[], own: number): number {
  let below = 0;
  let equal = 0;
  for (const v of sorted) {
    if (v < own) below++;
    else if (v === own) equal++;
  }
  return scaleMinorBy(below * 2 + equal, 100, sorted.length * 2);
}
