// The day-30 shadow summary's counts and money as marks (components/charts/Viz)
// — the same figures ShadowSummaryView says in sentences.

import type { Seg, Tone } from "../charts/Viz";
import type { Money } from "../../lib/core/money";
import type { ShadowSummary } from "../../lib/ladder/shadow-summary";

export type ShadowOutcome = "gained" | "nothing" | "lost" | "unproven" | "open";

const TONE: Record<ShadowOutcome, Tone> = {
  gained: "ok",
  nothing: "soft",
  lost: "alarm",
  unproven: "faint",
  open: "hollow",
};

/** Pure: one segment per outcome, in the summary's order; none when nothing is counted. */
export function shadowSegs(
  s: Pick<ShadowSummary, "gained" | "nothing" | "lost" | "unproven" | "still_open">,
  word: (o: ShadowOutcome) => string,
): Seg[] {
  const counts: [ShadowOutcome, number][] = [
    ["gained", s.gained.count],
    ["nothing", s.nothing],
    ["lost", s.lost.count],
    ["unproven", s.unproven],
    ["open", s.still_open],
  ];
  if (counts.every(([, n]) => n <= 0)) return [];
  return counts.map(([o, n]) => ({ key: o, label: word(o), value: n, tone: TONE[o] }));
}

export interface GainLoss {
  currency: string;
  gained: Money;
  lost: Money;
  /** The larger of the two, unsigned: the scale both bars share. */
  max: number;
}

/** Pure: gained beside lost for each currency that has either, never across currencies (rule 1). */
export function gainLoss(gained: readonly Money[], lost: readonly Money[]): GainLoss[] {
  const of = (list: readonly Money[], currency: string): Money =>
    list.find((m) => m.currency === currency) ?? { amount_minor: 0, currency };
  return [...new Set([...gained, ...lost].map((m) => m.currency))]
    .sort((a, b) => a.localeCompare(b))
    .map((currency) => {
      const g = of(gained, currency);
      const l = of(lost, currency);
      return {
        currency,
        gained: g,
        lost: l,
        max: Math.max(Math.abs(g.amount_minor), Math.abs(l.amount_minor)),
      };
    })
    .filter((p) => p.max > 0);
}
