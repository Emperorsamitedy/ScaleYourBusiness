// Measured facts — the Phase 2 line between "computed from other answers"
// and "read from where the numbers live".
//
// A connector aggregate (thirty days of Stripe payments summed into a
// monthly figure) is stored as an inferred Field: it IS a derivation, and
// rule 6 wants its window and method on record. But it is not an inference
// from the owner's other answers, and three consumers must treat it
// differently from one:
//
//   · the report calls it "measured", and shows it against the owner's
//     estimate (rule 11);
//   · the economics engine accepts it as an input, where it refuses to
//     build arithmetic on its own derivations;
//   · the diagnosis sees it as the strongest evidence in the profile.
//
// The marker is structural, not a flag: every derived_from entry names a
// connector series ("connector:stripe:revenue.daily"). A value derived from
// owner answers can never carry that prefix, because field keys start with
// a profile section.
//
// Pure module — no database import — so the deliberately pure economics
// engine can use it.

export const CONNECTOR_SERIES_PREFIX = "connector:";

/** "connector:stripe:revenue.daily" — the derived_from entry for one provider series. */
export function connectorSeriesId(provider: string, metric: string): string {
  return `${CONNECTOR_SERIES_PREFIX}${provider}:${metric}`;
}

interface SourceShape {
  kind?: unknown;
  connector_id?: unknown;
  derived_from?: unknown;
}

/** True when a fact's source is a connector measurement, raw or aggregated. */
export function isMeasuredSource(source: unknown): boolean {
  if (typeof source !== "object" || source === null) return false;
  const s = source as SourceShape;
  if (s.kind === "connector") return true;
  if (s.kind !== "inferred" || !Array.isArray(s.derived_from) || s.derived_from.length === 0) {
    return false;
  }
  return s.derived_from.every(
    (entry) => typeof entry === "string" && entry.startsWith(CONNECTOR_SERIES_PREFIX),
  );
}

/** The provider id a measured source names ("stripe"), or null when it isn't measured. */
export function measuredProvider(source: unknown): string | null {
  if (!isMeasuredSource(source)) return null;
  const s = source as SourceShape;
  if (s.kind === "connector") return typeof s.connector_id === "string" ? s.connector_id : null;
  const first = (s.derived_from as string[])[0] ?? "";
  const provider = first.slice(CONNECTOR_SERIES_PREFIX.length).split(":")[0];
  return provider === undefined || provider === "" ? null : provider;
}

/**
 * What to call a fact's source on screen and to the diagnosis: "connector"
 * for a measurement, otherwise the source's own kind.
 */
export function displaySourceKind(source: unknown): string {
  if (isMeasuredSource(source)) return "connector";
  if (typeof source === "object" && source !== null) {
    const kind = (source as SourceShape).kind;
    if (typeof kind === "string") return kind;
  }
  return "unknown";
}

/**
 * Rule 11's pair, as the report stores it: what the owner said, what the
 * connector measured, and the difference when the two can be compared.
 */
export interface StatedVsMeasured {
  field_key: string;
  /** Owner-facing provider name, e.g. "Stripe". */
  provider: string;
  stated: {
    /** Null when the owner said "I don't know" — still worth showing. */
    value: unknown;
    status: string;
    source_kind: string;
    observed_at: string;
    note: string | null;
  };
  measured: { value: unknown; method: string; observed_at: string };
  /** measured − stated. Null when they can't be compared: no stated value, or two currencies (rule 1). */
  delta: { amount: number; currency: string | null; pct: number | null } | null;
}
