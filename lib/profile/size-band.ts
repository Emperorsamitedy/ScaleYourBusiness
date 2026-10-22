// The business's size band — question 1.6a in the owner's own words, or,
// until they give it, a band inferred from the headcount (1.6).
//
// The inference is a Field like any other derived fact (rule 6): status
// "inferred", derived_from identity.team_size, and the formula below. It
// is computed on read and never written, for one reason: a stored
// inferred record counts as a response, so the intake would never ask
// 1.6a, and the band would never be the owner's own words. Not writing it
// also means it can never overwrite what the owner said (rule 3): the
// stated band, when there is one, is simply what is read.
//
// Pure: callers hand in the two current records; nothing here touches the
// database, so the menu, the fact sheet and the tests share one function.

import type { EnumValue } from "../core/enum-value";
import type { Field } from "../core/field";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { SizeBand } from "../core/size-features";
import { isSizeBand } from "../core/size-features";

export const SIZE_BAND_KEY = "identity.size_band";
export const TEAM_SIZE_KEY = "identity.team_size";

/**
 * Headcount bands at the EU SME boundaries (Commission Recommendation
 * 2003/361/EC: under 10 is a micro enterprise, under 50 a small one).
 * Our names are the owner's words, not the EU's: "medium" here is the
 * EU's "small", and "large" is the EU's medium and up.
 */
export const SIZE_BAND_METHOD =
  "EU SME headcount bands on team size: 1 → solo, 2–9 → small, 10–49 → medium, 50+ → large";

/** Pure: the formula. Null for a headcount that names nobody. */
export function bandForTeamSize(teamSize: number): SizeBand | null {
  if (!Number.isFinite(teamSize) || teamSize < 1) return null;
  if (teamSize < 2) return "solo";
  if (teamSize < 10) return "small";
  if (teamSize < 50) return "medium";
  return "large";
}

/** The parts of a current record this needs — a Field, or a stored row. */
export interface BandInputRecord {
  status: string;
  value: unknown;
  confidence: number | string;
  observed_at: string;
}

/**
 * "stated": the owner answered 1.6a, and their record is the fact.
 * "inferred": derived from 1.6, carried as the Field it would be.
 */
export type ResolvedSizeBand =
  { band: SizeBand; via: "stated" } | { band: SizeBand; via: "inferred"; field: Field<EnumValue> };

const codeOf = (v: unknown): string | null =>
  typeof v === "string"
    ? v
    : typeof v === "object" && v !== null && typeof (v as { code?: unknown }).code === "string"
      ? (v as { code: string }).code
      : null;

const toIso = (t: string): string => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
};

/**
 * The band to use, or null when there is none to use.
 *
 *   · The owner's answer wins, always.
 *   · An explicit "I don't know" on the band stays a gap (rule 5): no
 *     inference papers over it, so nothing is hidden.
 *   · Otherwise (never asked, or skipped), an answered headcount gives an
 *     inferred band; confidence min(inputs) × 0.9 (§8.1).
 *   · No headcount, or none that names anybody: null, which shows everything.
 */
export function resolveSizeBand(
  stated: BandInputRecord | null | undefined,
  teamSize: BandInputRecord | null | undefined,
  now: Date = new Date(),
): ResolvedSizeBand | null {
  if (stated?.status === "answered") {
    const code = codeOf(stated.value);
    return code !== null && isSizeBand(code) ? { band: code, via: "stated" } : null;
  }
  if (stated?.status === "unknown") return null;
  if (teamSize?.status !== "answered" || typeof teamSize.value !== "number") return null;
  const band = bandForTeamSize(teamSize.value);
  if (band === null) return null;
  return {
    band,
    via: "inferred",
    field: createField<EnumValue>({
      id: fieldId(SIZE_BAND_KEY),
      value: { code: band },
      status: "inferred",
      confidence: Math.round(Number(teamSize.confidence) * 0.9 * 1000) / 1000,
      source: {
        kind: "inferred",
        derived_from: [fieldId(TEAM_SIZE_KEY)],
        method: SIZE_BAND_METHOD,
      },
      observed_at: isoDateTime(toIso(teamSize.observed_at)),
      recorded_at: isoDateTime(now.toISOString()),
      note: null,
    }),
  };
}
