// Home (2026-11-15, the owner: "retention matters the most"): the first
// screen after sign-in answers what needs the owner today. Everything it
// shows is read from screens that already exist — the queue, the cash
// forecast, the watch — and the arithmetic of what to put first lives
// here, pure, so it is testable without a browser or the database.

import { effectRange } from "../proposals/queue-model";
import type { MoneyLike, ScenarioOutcomeLike } from "../proposals/queue-model";

export interface PendingLike {
  id: string;
  module: string;
  action: { summary: string };
  scenario: {
    downside_case?: (ScenarioOutcomeLike & { formula?: string | null }) | null;
    upside_case?: (ScenarioOutcomeLike & { formula?: string | null }) | null;
  };
  expires_at?: string | null;
}

export interface Ranked<P extends PendingLike> {
  proposal: P;
  range: { low: MoneyLike; high: MoneyLike } | null;
}

/**
 * Pure: the waiting decisions in the order Home lists them — the ones with
 * a money range first, the largest upside first, then the rest as the
 * queue had them. Never more than `limit`.
 */
export function rankPending<P extends PendingLike>(pending: readonly P[], limit = 3): Ranked<P>[] {
  const ranked = pending.map((proposal, i) => {
    const r = effectRange(proposal.scenario.downside_case, proposal.scenario.upside_case);
    return { proposal, range: r ? { low: r.low, high: r.high } : null, i };
  });
  ranked.sort((a, b) => {
    if (a.range && b.range)
      return b.range.high.amount_minor - a.range.high.amount_minor || a.i - b.i;
    if (a.range) return -1;
    if (b.range) return 1;
    return a.i - b.i;
  });
  return ranked.slice(0, limit).map(({ proposal, range }) => ({ proposal, range }));
}

export interface CashLike {
  forecast:
    | {
        status: "ready";
        currency: string;
        start: {
          amount_minor: number;
          currency: string;
          basis: string;
          source: string;
          on: string | null;
        };
        line: { amount_minor: number; kind: "buffer" | "zero" };
        lowest: { index: number; balance: { low: number; high: number } };
        weeks: { start: string }[];
      }
    | { status: "refused" };
  tight: {
    start: string;
    balance: { low: number; high: number };
    line: number;
    line_kind: "buffer" | "zero";
  } | null;
}

export interface CashReading {
  currency: string;
  today: number;
  line: number;
  lineKind: "buffer" | "zero";
  /** Cash today is under the line the owner wants to keep. */
  under: boolean;
  lowest: { start: string; low: number; under: boolean };
  tight: { start: string; low: number } | null;
  source: { basis: string; source: string; on: string | null };
}

/** Pure: the cash figures Home prints, or null when the forecast refused. */
export function cashReading(view: CashLike | null): CashReading | null {
  if (!view || view.forecast.status !== "ready") return null;
  const f = view.forecast;
  const lowestWeek = f.weeks[f.lowest.index];
  return {
    currency: f.currency,
    today: f.start.amount_minor,
    line: f.line.amount_minor,
    lineKind: f.line.kind,
    under: f.start.amount_minor < f.line.amount_minor,
    lowest: {
      start: lowestWeek?.start ?? f.weeks[0]?.start ?? "",
      low: f.lowest.balance.low,
      under: f.lowest.balance.low < f.line.amount_minor,
    },
    tight: view.tight ? { start: view.tight.start, low: view.tight.balance.low } : null,
    source: { basis: f.start.basis, source: f.start.source, on: f.start.on },
  };
}
