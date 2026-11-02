// Basis — the named class that replaces every confidence percentage on
// the report and the fact sheet (ux-spec §2, "The number grammar": "Basis
// is a named class defined by what produced the fact … Never an
// AI-generated percentage").
//
// The class is read from what produced the fact, never from a model:
//
//   OBSERVED   read from where the numbers live — a connected account
//              (source kind "connector", which displaySourceKind() in
//              lib/connectors/measured.ts also returns for a connector
//              aggregate stored as an inferred field), an uploaded
//              document, or a public page the research read.
//   DERIVED    computed from other facts: source kind "inferred", which
//              createField() only allows with derived_from + a method
//              (rule 6).
//   ESTIMATED  the owner gave it and marked it as an estimate.
//   STATED     the owner gave an exact answer. DEVIATION from the brief's
//              four classes (OBSERVED / DERIVED / ESTIMATED / ASSUMED): an
//              owner's precise answer is none of those — calling it
//              ESTIMATED would misreport what they said, and calling it
//              OBSERVED would claim a measurement nobody made.
//   ASSUMED    an input nobody supplied: a system default, or a forecast
//              assumption with no source field.
//
// A fact with no value (unknown, skipped, unasked, not_applicable) has no
// basis — it is a gap, and rule 5 keeps it distinct; callers print its
// status instead.

//
// L-3a: the words below (meanings, gap words, source words, "newer …")
// come from the "sheet" catalogue through an optional translator, English
// by default — so English is byte-for-byte what it was.

import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";

const EN = () => englishTr("sheet");

export const BASES = ["OBSERVED", "DERIVED", "ESTIMATED", "STATED", "ASSUMED"] as const;
export type Basis = (typeof BASES)[number];

/** One-line meaning of each class, for the legend printed on every sheet. */
export const BASIS_MEANING: Record<Basis, string> = {
  OBSERVED: "read from a connected account, a document or a public page",
  DERIVED: "worked out from other facts, with the formula shown",
  ESTIMATED: "your own estimate",
  STATED: "an exact answer you gave",
  ASSUMED: "an input to a forecast that nobody measured or stated",
};

/** A basis class's name in the person's language ("OBSERVED", "BEOBACHTET"). */
export const basisName = (b: Basis, tr: Tr = EN()): string => tr(`basis.${b}`);

/** A basis class's one-line meaning in the person's language. */
export const basisMeaning = (b: Basis, tr: Tr = EN()): string => tr(`basisMeaning.${b}`);

/**
 * Confidence an estimated owner answer is written with — data-model §8.1
 * "Owner input, estimated: 0.55", set by lib/intake/service.ts (the
 * "estimate" toggle) and lib/parser/parse.ts (CONFIDENCE_ESTIMATED, a
 * hedged answer). Repeated here rather than imported because both modules
 * pull in the database and the model client. Read only as a marker of
 * which path wrote the fact — no confidence is ever shown. Safe as a
 * marker because §8.1's later adjustments (staleness, contradiction) are
 * not implemented anywhere; if they land, the writers must record the
 * estimate in the note instead and this fallback goes.
 */
export const ESTIMATED_CONFIDENCE = 0.55;

const VALUE_BEARING = new Set(["answered", "inferred"]);

export interface BasisInput {
  status: string;
  source_kind: string;
  /** The field's note. Estimates carry one ("owner marked as estimate", or the owner's hedge words). */
  note?: string | null;
  /** Only a marker of which writer produced the fact; see ESTIMATED_CONFIDENCE. */
  confidence?: number;
}

function isEstimate(f: BasisInput): boolean {
  if (typeof f.note === "string" && /estimat/i.test(f.note)) return true;
  return typeof f.confidence === "number" && f.confidence <= ESTIMATED_CONFIDENCE + 1e-9;
}

/** The basis class of one fact, or null when the fact holds no value. */
export function basisOf(f: BasisInput): Basis | null {
  if (!VALUE_BEARING.has(f.status)) return null;
  switch (f.source_kind) {
    case "connector":
    case "document":
    case "web_research":
      return "OBSERVED";
    case "inferred":
      return "DERIVED";
    case "system_default":
      return "ASSUMED";
    case "owner_input":
    case "conversation":
      return isEstimate(f) ? "ESTIMATED" : "STATED";
    default:
      return null;
  }
}

/** The prefix a connector series carries in derived_from (lib/connectors/measured.ts). */
const CONNECTOR_SERIES = "connector:";

/**
 * The basis of one input key of a derivation: a connector series is
 * OBSERVED by construction; a profile key is looked up.
 */
export function basisOfKey(
  key: string,
  facts: Record<string, BasisInput | undefined>,
): Basis | null {
  if (key.startsWith(CONNECTOR_SERIES)) return "OBSERVED";
  const f = facts[key];
  return f ? basisOf(f) : null;
}

/**
 * "2 STATED · 1 ESTIMATED" — what a derivation rests on, in the fixed
 * class order. Inputs with no recorded basis are counted as "not recorded"
 * rather than dropped.
 */
export function basisMix(bases: readonly (Basis | null)[]): string {
  const parts: string[] = [];
  for (const b of BASES) {
    const n = bases.filter((x) => x === b).length;
    if (n > 0) parts.push(`${n} ${b}`);
  }
  const missing = bases.filter((x) => x === null).length;
  if (missing > 0) parts.push(`${missing} not recorded`);
  return parts.join(" · ");
}

const GAP_STATUSES = new Set(["unknown", "skipped", "unasked", "not_applicable"]);

/** Owner-facing words for a gap's status, for the basis column of a fact with no value. */
export function gapWord(status: string, tr: Tr = EN()): string {
  if (GAP_STATUSES.has(status)) return tr(`gap.${status}`);
  return status.replace(/_/g, " ").toUpperCase();
}

/** Owner-facing words for a source kind — the "source" half of the mono line. */
export const SOURCE_LABEL: Record<string, string> = {
  owner_input: "you told me",
  conversation: "from our conversation",
  inferred: "computed",
  web_research: "researched",
  benchmark: "benchmark",
  connector: "measured",
  document: "from a document",
  system_default: "default",
};

export const sourceLabel = (kind: string, tr: Tr = EN()): string =>
  SOURCE_LABEL[kind] !== undefined ? tr(`source.${kind}`) : kind.replace(/_/g, " ");

/** What replaced a superseded value, as a kind: "superseded by a newer measurement". */
export function newerKind(
  kind: string | undefined,
): "measurement" | "reading" | "calculation" | "answer" | "record" {
  switch (kind) {
    case "connector":
      return "measurement";
    case "document":
    case "web_research":
      return "reading";
    case "inferred":
      return "calculation";
    case "owner_input":
    case "conversation":
      return "answer";
    default:
      return "record";
  }
}

/** What replaced a superseded value, in a word: "superseded by a newer measurement". */
export const newerWord = (kind: string | undefined): string => newerKind(kind);

/**
 * The source kind of whatever replaced `list[i]`: superseded lists run
 * newest first, so its successor is the entry before it, and the newest
 * one's successor is the current fact.
 */
export function successorKind(
  list: readonly { source_kind: string }[],
  i: number,
  currentKind: string | undefined,
): string | undefined {
  return i === 0 ? currentKind : list[i - 1]?.source_kind;
}
