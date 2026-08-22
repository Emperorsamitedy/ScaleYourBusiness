// Shared contract between QuestionCard and the per-type controls.

import type { IntakeQuestion } from "@/lib/intake/types";

/** What a control currently holds. `wire: null` means nothing recordable yet. */
export interface ControlChange {
  wire: unknown;
  estimate?: boolean;
}

export interface ControlProps {
  question: IntakeQuestion;
  /** Draft update — enables/disables "Record answer", clears inline errors. */
  onChange: (change: ControlChange) => void;
  /** Immediate submit — Enter in a field, or the single-select confirm beat. */
  onCommit: (change: ControlChange) => void;
}
