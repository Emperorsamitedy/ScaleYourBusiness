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
}

export interface IntakeProgress {
  core_done: number;
  core_total: number;
  /** 0..1 for the hairline fill. */
  fraction: number;
}

export interface IntakeState {
  profile_id: string;
  done: boolean;
  question: IntakeQuestion | null;
  on_deck: string | null;
  progress: IntakeProgress;
  /** Populated when done: the closing readout. */
  readout: { answered: number; gaps: number; completeness: number } | null;
}

export type AnswerAction =
  { kind: "value"; wire: unknown; estimate?: boolean } | { kind: "unknown" } | { kind: "skip" };

export interface AnswerResponse {
  chip: IntakeChip;
  state: IntakeState;
}
