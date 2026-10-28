// The pipeline's stages and who the pipeline exists for — Phase 5 Session D
// (P5-14, P5-17). Pure, so the menu, the screen, the services and their
// tests read the same definitions without a database.
//
// Stages are the bank's own vocabulary (`deal_stage`, bank 1.9.0), in the
// bank's order; the database enum mirrors it, and a test holds all three
// equal. The owner's words for each code live here beside them.
//
// Who sees the pipeline is data, not an if on a business type (rule 4): a
// ConditionExpr over 6.1a, evaluated by the resolver's evaluator. `neq b2c`
// means "answered, and not b2c" (lib/conditions/evaluate.ts), so b2b and
// both see it, and a business that hasn't said yet doesn't — the same
// condition the bank already asks 6.1e and 6.1f under.

import type { ConditionExpr } from "../conditions/evaluate";

export const DEAL_STAGES = ["lead", "qualified", "proposal_sent", "won", "lost"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

/** The stages a deal is still being worked in — the pipeline's columns before the close. */
export const OPEN_STAGES: readonly DealStage[] = ["lead", "qualified", "proposal_sent"];
export const CLOSED_STAGES: readonly DealStage[] = ["won", "lost"];

export const STAGE_LABELS: Readonly<Record<DealStage, string>> = {
  lead: "Lead",
  qualified: "Qualified",
  proposal_sent: "Proposal sent",
  won: "Won",
  lost: "Lost",
};

export function isDealStage(v: unknown): v is DealStage {
  return typeof v === "string" && (DEAL_STAGES as readonly string[]).includes(v);
}

export function isOpenStage(stage: DealStage): boolean {
  return OPEN_STAGES.includes(stage);
}

/** 6.1a, customers.type: b2b or both — answered, and not b2c. */
export const PIPELINE_APPLIES: ConditionExpr = {
  op: "neq",
  field: "customers.type",
  value: "b2c",
};

/** The bank question the stated win rate comes from, and where it is written. */
export const WIN_RATE_QUESTION = "6.1f";
export const WIN_RATE_KEY = "customers.win_rate";
