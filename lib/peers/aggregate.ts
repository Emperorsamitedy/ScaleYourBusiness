// The peer aggregate — architecture-v2 hard rule 4, invariant I4. Pure.
//
// A ratio of totals over a cohort (Σ numerators ÷ Σ denominators, the way
// Eurostat states its own figures), served only when BOTH hold:
//   · at least PEER_K distinct businesses contribute, and
//   · no single business holds more than PEER_MAX_SHARE of the numerator's
//     total or of the denominator's total.
// Otherwise the result is exactly { shown: false } — no number, no
// rounding, no bucket, no count, nothing that narrows down who is in it.

export const PEER_K = 7;

/**
 * The multi-market spec §A.7: a cohort is country-scoped, so it has exactly
 * one currency by construction. Two currencies in one cohort is a bug, not
 * an edge case — it fails loudly here, at build time, never averaged.
 */
export class CohortCurrencyError extends Error {
  constructor(currencies: readonly string[]) {
    super(
      `a cohort was built with ${currencies.length} currencies (${currencies.join(", ")}) — a cohort has exactly one`,
    );
    this.name = "CohortCurrencyError";
  }
}
export const PEER_MAX_SHARE = 0.25;

export interface Contribution {
  /** Any stable id for the business; rows sharing one are one business. */
  business: string;
  numerator: number;
  denominator: number;
  /** The currency of a money numerator; every row of one cohort shares it (§A.7). */
  currency?: string;
}

export type PeerAggregate = { shown: true; value: number; businesses: number } | { shown: false };

const SUPPRESSED: PeerAggregate = Object.freeze({ shown: false });

/** §A.7: the cohort's one currency, or null for a cohort of counts. Throws on two. */
export function cohortCurrency(rows: readonly Contribution[]): string | null {
  const seen = [
    ...new Set(rows.map((r) => r.currency).filter((c): c is string => c !== undefined)),
  ];
  if (seen.length > 1) throw new CohortCurrencyError(seen.sort());
  return seen[0] ?? null;
}

export function peerAggregate(rows: readonly Contribution[]): PeerAggregate {
  cohortCurrency(rows);
  // One business is one business, however many rows it arrives as.
  const merged = new Map<string, { numerator: number; denominator: number }>();
  for (const r of rows) {
    if (!Number.isFinite(r.numerator) || !Number.isFinite(r.denominator)) continue;
    const held = merged.get(r.business) ?? { numerator: 0, denominator: 0 };
    held.numerator += r.numerator;
    held.denominator += r.denominator;
    merged.set(r.business, held);
  }
  if (merged.size < PEER_K) return { ...SUPPRESSED };

  let numerator = 0;
  let denominator = 0;
  for (const m of merged.values()) {
    numerator += m.numerator;
    denominator += m.denominator;
  }
  if (numerator <= 0 || denominator <= 0) return { ...SUPPRESSED };

  for (const m of merged.values()) {
    if (m.numerator / numerator > PEER_MAX_SHARE) return { ...SUPPRESSED };
    if (m.denominator / denominator > PEER_MAX_SHARE) return { ...SUPPRESSED };
  }
  return { shown: true, value: numerator / denominator, businesses: merged.size };
}
