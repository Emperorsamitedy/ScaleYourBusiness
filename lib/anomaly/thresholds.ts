// The watch's interruption thresholds, as code — P2-24.
//
// Since Session H the status screen has promised three things that would
// interrupt a watch early. One of them, the revenue drop, can now be
// checked against measured data, so it lives here as a rule with a number
// and a test, and the screen renders THIS list rather than its own copy.
// The other two are still promises: they are listed with `enforced: false`
// so the screen can say so, rather than implying a check that doesn't run.

import type { MetricKey } from "../connectors/provider";
import type { AnomalyRun, WeekOverWeek } from "./baseline";

export interface InterruptRule {
  id: string;
  metric: MetricKey;
  text: string;
  /** Week-over-week fall, as a fraction, at or beyond which the watch is interrupted. */
  drop_threshold: number;
}

export const REVENUE_WEEK_OVER_WEEK_DROP = 0.3;

export const INTERRUPT_RULES: readonly InterruptRule[] = [
  {
    id: "revenue_drop_30_wow",
    metric: "revenue.daily",
    text: "Revenue drops more than 30% week over week",
    drop_threshold: REVENUE_WEEK_OVER_WEEK_DROP,
  },
];

/** Interruptions the screen still promises but no code checks yet. Said so, on screen. */
export const INTERRUPTS_NOT_YET_ENFORCED: readonly string[] = [
  "A validation finding of critical severity appears",
  "You reopen a core answer the diagnosis rests on",
];

export interface ThresholdText {
  text: string;
  enforced: boolean;
}

export function thresholdTexts(): ThresholdText[] {
  return [
    ...INTERRUPT_RULES.map((r) => ({ text: r.text, enforced: true })),
    ...INTERRUPTS_NOT_YET_ENFORCED.map((text) => ({ text, enforced: false })),
  ];
}

/**
 * The rule an anomaly crosses, if any: a drop on the rule's metric whose
 * week-over-week fall is at or beyond the threshold. Spikes never interrupt.
 */
export function interruptFor(
  metric: string,
  run: AnomalyRun,
  wow: WeekOverWeek,
): InterruptRule | null {
  if (run.direction !== "drop" || wow.change === null) return null;
  for (const rule of INTERRUPT_RULES) {
    if (rule.metric === metric && wow.change <= -rule.drop_threshold) return rule;
  }
  return null;
}
