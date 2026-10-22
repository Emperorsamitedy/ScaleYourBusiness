// The simulated scenario a "Propose this" carries — feature 36. Pure.
//
// A proposal made from the simulator goes through its kind's normal
// generation path (lib/crm/segment-proposals, lib/ads/proposals,
// lib/content/plan): the same gates, the same queue, nothing executed
// (rule 12). The only difference is its ScenarioBlock: the low and high
// profit of the simulation become the downside and upside the queue draws
// as its range, each input becomes an assumption with its source, and the
// whole simulation is kept beside it (`simulation`) so the trust layer can
// later ask whether what happened landed inside what was predicted.

import type { Basis } from "../../components/report/basis";
import type { Assumption, ScenarioBlock, ScenarioOutcome } from "../diagnosis/recommendations";
import type { MeasureKey, OptionResult, Range, SimOption } from "./model";
import { MEASURES, SIM, valueText } from "./model";

/** What a proposal keeps of the simulation it was made from (data-model §10, ScenarioBlock). */
export interface SimulationRecord {
  version: 1;
  /** The day the inputs were read. */
  as_of: string;
  horizon_days: number;
  option: SimOption;
  title: string;
  currency: string;
  /** The ranges that were worked out; a missing measure is absent, never zero. */
  measures: Partial<Record<MeasureKey, Range>>;
  /** The rate the cross-check compares with what happened. */
  key_rate: OptionResult["key_rate"];
  inputs: { label: string; value: string | null; basis: Basis | null; source: string }[];
  /** Inputs that were missing, with what would fill them. */
  missing: string[];
}

/** Pure: the record kept on the proposal. */
export function simulationRecord(result: OptionResult, asOf: string): SimulationRecord {
  const measures: Partial<Record<MeasureKey, Range>> = {};
  for (const m of MEASURES) {
    const c = result.measures[m];
    if (c.status === "range") measures[m] = { low: c.range.low, high: c.range.high };
  }
  return {
    version: 1,
    as_of: asOf,
    horizon_days: SIM.horizon_days,
    option: result.option,
    title: result.title,
    currency: result.currency,
    measures,
    key_rate: result.key_rate,
    inputs: result.inputs.map((i) => ({
      label: i.label,
      value: i.range ? valueText(i.range, i.unit, result.currency) : null,
      basis: i.basis,
      source: i.source,
    })),
    missing: result.inputs
      .filter((i) => i.range === null)
      .map((i) => `${i.label}: ${i.needs ?? "not known"}`),
  };
}

const outcome = (
  c: ScenarioOutcome["case"],
  statement: string,
  amount: number | null,
  currency: string,
  formula: string | null,
): ScenarioOutcome => ({
  case: c,
  statement,
  profit_delta_monthly: amount === null ? null : { amount_minor: amount, currency },
  formula,
});

/**
 * Pure: the path's own scenario with the simulation laid over it. The
 * path's assumptions stay (its evidence); the simulation's inputs come
 * first, each marked with its source. Missing inputs are named in the
 * statements, never turned into assumptions — an assumption nobody
 * measured reads as ASSUMED, and a gap is not an assumption.
 */
export function withSimulation(
  base: ScenarioBlock,
  result: OptionResult,
  asOf: string,
): ScenarioBlock & { simulation: SimulationRecord } {
  const record = simulationRecord(result, asOf);
  const cur = result.currency;
  const profit = result.measures.profit;
  const revenue = result.measures.revenue;
  const worst = result.measures.worst;
  const fmt = (r: Range) => valueText(r, "money", cur);
  const one = (v: number) => valueText({ low: v, high: v }, "money", cur, true);
  const missing = record.missing.length > 0 ? ` Not worked out: ${record.missing.join("; ")}.` : "";
  const span = `over ${SIM.horizon_days} days`;

  const inputs: Assumption[] = result.inputs
    .filter((i) => i.range !== null)
    .map((i) => ({
      statement: `${i.label}: ${valueText(i.range!, i.unit, cur)}`,
      value: null,
      source_field: null,
      measured: `${i.basis ?? "NOT RECORDED"} · ${i.source}`,
      sensitivity: "medium" as const,
    }));
  const projection: Assumption[] = result.assumptions.map((a) => ({
    statement: `${a.statement} (${a.source})`,
    value: null,
    source_field: null,
    sensitivity: "high" as const,
  }));

  const base_case =
    profit.status === "range"
      ? outcome(
          "base",
          `Simulated ${span}: profit ${fmt(profit.range)}${revenue.status === "range" ? ` on revenue of ${fmt(revenue.range)}` : ""}.${missing}`,
          null,
          cur,
          profit.formula,
        )
      : outcome(
          "base",
          revenue.status === "range"
            ? `Simulated ${span}: revenue ${fmt(revenue.range)}; profit not worked out.${missing}`
            : `Simulated ${span}, but the result can't be sized yet.${missing}`,
          null,
          cur,
          revenue.status === "range" ? revenue.formula : null,
        );
  const downside_case =
    profit.status === "range"
      ? outcome(
          "downside",
          `The low end: ${one(profit.range.low)}. Worst case: ${result.worst_words}`,
          profit.range.low,
          cur,
          worst.status === "range" ? worst.formula : profit.formula,
        )
      : outcome("downside", `Worst case: ${result.worst_words}`, null, cur, null);
  const upside_case =
    profit.status === "range"
      ? outcome(
          "upside",
          `The high end: ${one(profit.range.high)}.`,
          profit.range.high,
          cur,
          profit.formula,
        )
      : base.upside_case;

  return {
    ...base,
    assumptions: [...inputs, ...projection, ...base.assumptions],
    base_case,
    downside_case,
    upside_case,
    simulation: record,
  };
}

/** What a generation path is handed when the owner proposes from the simulator. */
export interface SimulationAttachment {
  /** Recomputed on the server from fresh inputs — never the browser's numbers. */
  result: OptionResult;
  as_of: string;
}

/** Pure: the path's scenario, with the simulation laid over it when there is one. */
export function attachSimulation(base: ScenarioBlock, sim?: SimulationAttachment): ScenarioBlock {
  return sim ? withSimulation(base, sim.result, sim.as_of) : base;
}
