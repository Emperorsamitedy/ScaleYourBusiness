// The report's shapes as GET /api/report sends them (lib/report/service.ts
// ReportView). Restated for the browser rather than imported, because the
// service module pulls in the database.

import type { BasisInput } from "./basis";
import type { MoneyLike, Severity } from "./figures";

export interface FactInfo extends BasisInput {
  value: string | null;
  status: string;
  confidence: number;
  source_kind: string;
  observed_at?: string;
  note?: string | null;
  source_detail?: string | null;
  /** L-3a: the fact's label in the reader's language (app/api/report); absent in English. */
  label?: string | null;
  /** L-3a: a coded value's option label in the reader's language; absent in English. */
  value_words?: string | null;
}
export type FactMap = Record<string, FactInfo>;

/** A superseded record — lib/profile/factsheet.ts SupersededFact. */
export interface HistoryLine {
  key: string;
  value: string | null;
  status: string;
  source_kind: string;
  source_detail: string | null;
  observed_at: string;
  recorded_at: string;
  superseded_at: string;
  note: string | null;
}
export type History = Record<string, HistoryLine[]>;

export interface Computed<T> {
  value: T;
  derived_from: string[];
  formula: string;
  confidence: number;
}
export interface OfferEco {
  offer_id: string;
  name: string;
  price: MoneyLike;
  cost_to_deliver: MoneyLike | null;
  margin_pct: Computed<number> | null;
  contribution: Computed<MoneyLike> | null;
  volume: number | null;
}
/** Rule 11 (P2-11): a connector superseded the owner's figure, and both are shown. */
export interface StatedVsMeasuredRow {
  field_key: string;
  provider: string;
  stated: {
    value: unknown;
    status: string;
    source_kind: string;
    observed_at: string;
    note: string | null;
  };
  measured: { value: unknown; method: string; observed_at: string };
  delta: { amount: number; currency: string | null; pct: number | null } | null;
}
export interface BreakEven {
  units_per_month: number;
  revenue_per_month?: MoneyLike;
}
export interface Refusal {
  what: string;
  missing: string[];
  why: string;
}
export interface Economics {
  /** Absent on reports generated before Phase 2. */
  stated_vs_measured?: StatedVsMeasuredRow[];
  currency: string;
  offers: OfferEco[];
  blended_margin_pct: Computed<number> | null;
  break_even: Computed<BreakEven> | null;
  average_order_value?: Computed<MoneyLike> | null;
  cost_per_acquisition?: Computed<MoneyLike> | null;
  return_on_ad_spend?: Computed<number> | null;
  fixed_costs_monthly: Computed<MoneyLike> | null;
  stated_vs_computed_margin: { stated_pct: number; computed_pct: number; delta_pts: number } | null;
  refusals?: Refusal[];
}
export interface Finding {
  area: string;
  title: string;
  detail: string;
  evidence: string[];
  severity: Severity;
  /** P5-13: "measured" — SYB measured it (the site audit), not the model's judgement. */
  kind?: "measured";
}
export interface Outcome {
  case: string;
  statement: string;
  profit_delta_monthly?: MoneyLike | null;
  formula: string | null;
}
export interface Rec {
  addresses: number[];
  title: string;
  rationale: string;
  effort: string;
  reversibility: { level: string; if_you_change_your_mind: string };
  sensitivity_callouts: string[];
  scenario: {
    assumptions: { statement: string; source_field: string | null; sensitivity: string }[];
    base_case: Outcome;
    downside_case: Outcome;
    upside_case: Outcome;
    breakeven_condition: string;
  };
  status: "proposed" | "accepted" | "rejected";
  rejection_reason: string | null;
}
export interface Gap {
  question_id: string;
  prompt: string;
  priority: string;
  buys: string;
  blocking: boolean;
}
export interface HoursFinding {
  signal: "opening" | "closing" | "attention" | "too_early";
  weekdays: string[];
  title: string;
  detail: string;
  arithmetic: string[];
}
export interface TradingHours {
  from: string;
  to: string;
  coverage: string;
  limit: string;
  findings: HoursFinding[];
}
export interface ReportView {
  id: string;
  generated_at: string;
  summary: string;
  completeness: number;
  unit_economics: Economics;
  findings: Finding[];
  recommendations: Rec[];
  data_gaps: Gap[];
  trading_hours?: TradingHours | null;
  fact_map: FactMap;
  /** Absent from a server older than the derivation sheet. */
  history?: History;
  prior?: { id: string; generated_at: string; unit_economics: Economics } | null;
  /** L-5: the language the model wrote the report in; absent before L-5 (English). */
  language?: string;
}
