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

export interface IntakeState {
  profile_id: string;
  done: boolean;
  question: IntakeQuestion | null;
  on_deck: string | null;
  progress: IntakeProgress;
  /** Open findings — contradictions drive the reconcile panel (§4.5). */
  findings: IntakeFinding[];
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
