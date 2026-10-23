// Materiality — which stated-vs-measured deltas deserve the owner's eye.
//
// Rule 11 (TASKS-PHASE2): measured beats stated, visibly. The co-founder's
// finding from customer interviews: an owner who knows their numbers from
// the top of their head sees noise when every small difference is printed
// at full weight. The fix is not to hide the comparison by business size;
// it is to show a delta prominently only when it is MATERIAL, at any size.
//
// Presentation only. The pairs come from lib/connectors/stated-vs-measured.ts
// unchanged; supersession and provenance underneath are untouched (rule 3).
// A delta that is not material is never dropped: it collapses into one
// quiet line ("4 of the 6 figures you gave me matched your accounts
// within 15%"),
// with every detail one click away.
//
// The same thresholds apply at every size (see lib/core/size-features.ts):
// the relative test already scales with the business, and a stricter bar
// for a solo owner would hide exactly the surprise they would want.
//
// Pure and client-safe: no database, no model.

import { minorUnitExponent } from "../core/money";

/** The thresholds, pinned. A delta is material when it clears BOTH. */
export const MATERIALITY = {
  /** Relative gap, as a percent of what the owner said. */
  min_relative_pct: 15,
  /**
   * Absolute money floor, in MAJOR units per currency (roughly €50 of
   * value each), converted to minor units by the ISO 4217 exponent (rule
   * 1). An unlisted currency gets the default in its own major units,
   * which can only be lower in value, so the comparison errs towards
   * showing, never hiding.
   */
  money_floor_major: {
    EUR: 50,
    USD: 50,
    GBP: 50,
    CHF: 50,
    CAD: 75,
    AUD: 75,
    HUF: 20_000,
    PLN: 200,
    CZK: 1_000,
    RON: 250,
    SEK: 500,
    NOK: 500,
    DKK: 400,
    JPY: 7_500,
  } as Readonly<Record<string, number>>,
  money_floor_major_default: 50,
  /** Absolute floor for a count, by what is counted, in a month. */
  count_floor: { orders: 5, units: 5, sessions: 100 },
  count_floor_default: 5,
  /**
   * Absolute floor for a percent field (a rate or a margin), in PERCENTAGE
   * POINTS, never the count floor: a repeat rate stated at 10 % and
   * measured at 14 % is a 4-point gap that a count floor of 5 hid
   * (review 2026-10-23, #23).
   */
  percent_floor_pp: 2,
} as const;

/** Pure: whether a field holds a percent (in points, 0–100), by its key. */
export function isPercentField(fieldKey: string): boolean {
  return /(_rate|_pct|_percent|margin)(_\d+d)?$/.test(fieldKey);
}

/** Pure: the money floor for a currency, in its minor units — an integer. */
export function moneyFloorMinor(currency: string): number {
  const major = MATERIALITY.money_floor_major[currency] ?? MATERIALITY.money_floor_major_default;
  return major * 10 ** minorUnitExponent(currency);
}

/** Pure: what a count field counts, for its floor. */
export function countFloor(fieldKey: string): number {
  const f = MATERIALITY.count_floor;
  if (/(^|\.)monthly_sessions$/.test(fieldKey)) return f.sessions;
  if (/^offers\.[^.]+\.volume_period$/.test(fieldKey)) return f.units;
  if (/order_count/.test(fieldKey)) return f.orders;
  return MATERIALITY.count_floor_default;
}

/** The parts of one stated-vs-measured pair this reads. */
export interface DeltaInput {
  field_key: string;
  stated: { value: unknown };
  measured: { value: unknown };
  delta: { amount: number; currency: string | null; pct: number | null } | null;
}

export type MaterialityReason =
  /** The owner said "I don't know": the measurement is news, never noise. */
  | "no_estimate"
  /** Two currencies, or values that can't be set side by side: never called a match. */
  | "not_comparable"
  /** Clears both the relative and the absolute threshold. */
  | "material"
  /** Within the relative threshold. */
  | "within_relative"
  /** Over it, but by less than the floor for its unit. */
  | "below_floor";

export interface Materiality {
  material: boolean;
  reason: MaterialityReason;
}

const statedMagnitude = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.abs(v);
  const m = v as { amount_minor?: unknown } | null;
  return typeof m?.amount_minor === "number" ? Math.abs(m.amount_minor) : null;
};

/**
 * Pure: whether one delta is material. The relative test is computed from
 * the raw figures (never the rounded percent), so 14.96 % is not material
 * and 15 % exactly is. A stated zero has no relative gap; any change past
 * the floor is then material.
 */
export function materialityOf(row: DeltaInput): Materiality {
  if (row.stated.value === null) return { material: true, reason: "no_estimate" };
  const d = row.delta;
  if (d === null) return { material: true, reason: "not_comparable" };
  const base = statedMagnitude(row.stated.value);
  if (base === null) return { material: true, reason: "not_comparable" };
  const gap = Math.abs(d.amount);
  if (base > 0 && gap * 100 < MATERIALITY.min_relative_pct * base) {
    return { material: false, reason: "within_relative" };
  }
  const floor =
    d.currency !== null
      ? moneyFloorMinor(d.currency)
      : isPercentField(row.field_key)
        ? MATERIALITY.percent_floor_pp
        : countFloor(row.field_key);
  if (gap < floor) return { material: false, reason: "below_floor" };
  return { material: true, reason: "material" };
}

export interface MaterialSplit<T extends DeltaInput> {
  /** Shown prominently, in their original order. */
  material: T[];
  /** Collapsed into the quiet line, one click from their detail. */
  quiet: { row: T; reason: MaterialityReason }[];
}

/** Pure: the pairs split in two; nothing is dropped. */
export function splitByMateriality<T extends DeltaInput>(rows: readonly T[]): MaterialSplit<T> {
  const out: MaterialSplit<T> = { material: [], quiet: [] };
  for (const row of rows) {
    const m = materialityOf(row);
    if (m.material) out.material.push(row);
    else out.quiet.push({ row, reason: m.reason });
  }
  return out;
}

/**
 * The quiet line, in the first person the report speaks: "4 of the 6
 * figures you gave me matched your accounts within 15%." It says "or by a small
 * amount" only when a delta was quiet because of its floor rather than
 * its percent. Null when nothing is quiet.
 */
export function quietLine(
  quiet: readonly { reason: MaterialityReason }[],
  total: number,
): string | null {
  const n = quiet.length;
  if (n === 0) return null;
  const how = quiet.every((q) => q.reason === "within_relative")
    ? `within ${MATERIALITY.min_relative_pct}%`
    : `within ${MATERIALITY.min_relative_pct}% or by a small amount`;
  if (n === 1 && total === 1) return `The figure you gave me matched your accounts ${how}.`;
  const who =
    n !== total
      ? `${n} of the ${total} figures you gave me`
      : n === 2
        ? "Both figures you gave me"
        : `All ${n} figures you gave me`;
  return `${who} matched your accounts ${how}.`;
}
