// Intake wire contract — shared between route handlers and the client.

export interface IntakeOption {
  code: string;
  label: string;
}

export interface IntakeQuestion {
  id: string;
  priority: "core" | "important" | "deep" | "optional";
  cost: number;
  prompt: string;
  help: string | null;
  input_type:
    | "text"
    | "long_text"
    | "number"
    | "money"
    | "boolean"
    | "date"
    | "single_select"
    | "multi_select"
    | "entity_list"
    | "file";
  options: IntakeOption[];
  allow_unknown: boolean;
  /** For money controls: the account's reporting currency. */
  currency: string;
  /** For entity_list: which entity schema (offer, supplier, …). */
  entity_schema: string | null;
  /** For entity_list: the row sub-fields (P0-68). */
  entity_fields?: EntityField[];
  /** The field this question writes (the bank's writes_to). */
  writes_to: string;
  /** The profile section (area) the bank files this question under. */
  section: string;
  /** 1-based position within its area: earlier answers and skips there, plus one. */
  area_position: number;
  /**
   * A connector measurement already on record for this question's
   * writes_to field (or a field beneath it) — null when there is none.
   * Never invented: only a current, value-bearing, measured record.
   */
  already_read: RecordFact | null;
  /**
   * True when `already_read` sits beneath this question's writes_to rather than
   * on it: a connection measured part of what the question asks, and the
   * question is still open for the rest.
   */
  missing_piece: boolean;
  /**
   * The bank's own `unlocks` list for this question: each follow-up it
   * leads to, and whether that follow-up applies to this business yet.
   * Empty when the bank names none.
   */
  unlocks: IntakeUnlock[];
}

/** One follow-up a question unlocks (bank `unlocks`), as the intake shows it. */
export interface IntakeUnlock {
  id: string;
  section: string;
  prompt: string;
  /** Its condition holds on the record now (or it has none). */
  open: boolean;
}

export interface IntakeChip {
  question_id: string;
  prompt: string;
  /** Human display of what was recorded. */
  display: string;
  /** The mono provenance line, e.g. "1.4 · owner · stated". */
  provenance: string;
  /** solid = recorded fact, hollow = gap. */
  dot: "solid" | "hollow";
  /** Per-row lines for entity chips — expands on click (P0-70). */
  detail?: string[];
}

/** One sub-field of an entity row (P0-68/69). */
export interface EntityField {
  key: string;
  prompt: string;
  input_type: IntakeQuestion["input_type"];
  options: IntakeOption[];
  priority: "core" | "important" | "deep" | "optional";
  currency: string;
}

export interface IntakeProgress {
  core_done: number;
  core_total: number;
  /** 0..1 for the hairline fill. */
  fraction: number;
}

/** An open validation finding, surfaced to the intake UI (P0-82). */
export interface IntakeFinding {
  id: string;
  rule_id: string;
  kind: "gap" | "contradiction" | "implausible" | "stale";
  /** Both statements, factual — the panel supplies the tone. */
  message: string;
  /** Questions whose answers are involved; their chips take the ember. */
  question_ids: string[];
}

/**
 * One area of the intake — a bank section — and where it stands (computed
 * by lib/intake/areas.ts from the bank's ConditionExpr data, never from
 * per-question code):
 *   not_started  applicable questions open, none responded or skipped
 *   in_progress  questions open (or skipped) and some responded, or it is
 *                the area being asked right now
 *   blocked      nothing to ask there now, and some question there waits
 *                on a fact another area records; `needs` names that area
 *   completed    nothing to ask and nothing waiting: every applicable
 *                question there has a response
 * A section with no applicable question and nothing waiting on an
 * unrecorded fact does not apply to this business and is left out.
 */
export interface IntakeArea {
  section: string;
  status: "completed" | "in_progress" | "not_started" | "blocked";
  needs: string | null;
  /** Applicable questions with a response (answered, inferred, or an explicit unknown). */
  answered: number;
  /** Applicable questions with no response and not skipped. */
  open: number;
  /** Applicable questions skipped — distinct from open and from unknown (rule 5). */
  skipped: number;
  /**
   * One bar per applicable question in bank order (lib/intake/areas.ts
   * areaBars): the owner's answer, a connector measurement, a derivation,
   * the question being asked now, open, an explicit unknown, or a skip.
   */
  bars: AreaBar[];
}

export type AreaBar = "owner" | "measured" | "derived" | "current" | "open" | "unknown" | "skipped";

/**
 * The live reading card: one derived figure, computed by lib/economics on
 * the current records (never a snapshot), with the formula it came from.
 */
export interface LiveReading {
  /** What the figure is, in words: "Blended margin". */
  label: string;
  /** Percentage points, 0–100 scale. */
  value_pct: number;
  /** The formula, as lib/economics wrote it (rule 6). */
  formula: string;
  /** How many recorded facts it rests on. */
  inputs: number;
  /** The owner's own stated figure for the same thing, when on record. */
  stated_pct: number | null;
}

/** The record card: the facts of the area being asked, newest first. */
export interface AreaRecord {
  section: string;
  /** Value-bearing facts and recorded gaps in that area (capped). */
  facts: RecordFact[];
  /** Value-bearing facts in that area, uncapped. */
  fact_count: number;
}

/**
 * One current fact on the record, as the intake's record sheet shows it.
 * Read from the same current field_records the fact sheet snapshots, and
 * humanised with the fact sheet's own repr() — the raw value travels too,
 * so the browser prints money through components/sheet/num.ts.
 */
export interface RecordFact {
  key: string;
  /** For an entity fact ("offers.<id>.price"): the entity's own name, when known. */
  entity: string | null;
  /** The field part of the key, without any entity prefix. */
  field: string;
  /** The stored value, untouched (money stays integer minor units + currency). */
  value: unknown;
  /** The fact sheet's humanised text of the value; null for a gap. */
  text: string | null;
  status: string;
  /** "connector" for a measurement, else the source's own kind. */
  source_kind: string;
  /** Owner-facing provider name ("Shopify") for a measurement; null otherwise. */
  provider: string | null;
  note: string | null;
  confidence: number;
  observed_at: string;
  recorded_at: string;
  /** The formula, for a derived fact (rule 6). */
  method: string | null;
  /** The applicable bank question that writes this key — what a change reopens. */
  question_id: string | null;
  /**
   * L-3a: the fact's label in the person's language, from the bank's
   * overlay (lib/bank/fact-words) — absent or null in English, where the
   * screen names the fact by its key as it always has.
   */
  label?: string | null;
  /** L-3a: a coded value's option label in the person's language; null when it isn't a code. */
  value_words?: string | null;
}

export interface IntakeRecord {
  /** Value-bearing facts (answered or inferred). */
  fact_count: number;
  /** Where the facts came from, by source kind (and provider, for measurements). */
  sources: { kind: string; provider: string | null; count: number }[];
  /** Explicit "I don't know" answers on record — gaps, not facts (rule 5). */
  not_known: number;
  /** Skipped questions on record — distinct from unknown (rule 5). */
  skipped: number;
  /** Facts and recorded gaps, newest first (capped; the fact sheet has the rest). */
  facts: RecordFact[];
  /** How many rows `facts` left out. */
  more: number;
  /** Facts computed from other facts (not measurements), newest first. */
  derived: RecordFact[];
}

export interface IntakeState {
  profile_id: string;
  /** identity.legal_name when it holds a value; null otherwise. */
  business_name: string | null;
  /** One entry per area that applies to this business, in profile-section order. */
  areas: IntakeArea[];
  /** The record as it stands, for the record sheet. */
  record: IntakeRecord;
  done: boolean;
  question: IntakeQuestion | null;
  on_deck: string | null;
  progress: IntakeProgress;
  /** Open findings — contradictions drive the reconcile panel (§4.5). */
  findings: IntakeFinding[];
  /** Report readiness: lib/scorer completeness overall, 0..1, on the current records. */
  readiness: number;
  /** One derived figure that moves as answers land; null when none can be computed. */
  live_reading: LiveReading | null;
  /** The current area's facts, for the record card; null when nothing is being asked. */
  area_record: AreaRecord | null;
  /** Populated when done: the closing readout. */
  readout: { answered: number; gaps: number; completeness: number } | null;
}

/** Response of the reconcile endpoint (P0-83). */
export interface ReconcileResponse {
  /** Question ids returned to the centre by "Let me fix one". */
  reopened: string[];
  state: IntakeState;
}

export type AnswerAction =
  | { kind: "value"; wire: unknown; estimate?: boolean }
  | { kind: "unknown" }
  | { kind: "skip" }
  /** P0-75: return an answered question to the centre; reason is recorded. */
  | { kind: "reopen"; reason: string };

export interface AnswerResponse {
  chip: IntakeChip;
  state: IntakeState;
}
