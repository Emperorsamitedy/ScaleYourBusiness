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
  /**
   * The lowest of the weeks ahead (its cautious end). `aboveToday`: every
   * week ahead is above today's cash, so today is the low and the tile says
   * so; without that the figure reads as a mistake beside a smaller "today".
   */
  lowest: { start: string; low: number; under: boolean; aboveToday: boolean };
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
      aboveToday: f.lowest.balance.low > f.start.amount_minor,
    },
    tight: view.tight ? { start: view.tight.start, low: view.tight.balance.low } : null,
    source: { basis: f.start.basis, source: f.start.source, on: f.start.on },
  };
}

/**
 * What one of Home's reads came back as. A refused read (401: no session
 * for this business) is not a failed one: it sends the visitor to sign in,
 * where a failed read only leaves its part out. A read still out is
 * "reading", and never taken for an answer.
 */
export type Read<T> =
  | { state: "reading" }
  | {
      state: "read";
      data: T;
      /** What was read last is on screen while a newer read is out (read-model.ts). */
      refreshing?: boolean;
      /** The newest read failed; what shows is the read before it. */
      lapsed?: boolean;
    }
  | { state: "signed_out" }
  | { state: "failed" };

/** Pure: a response status as the outcome of a read, before its body is parsed. */
export function readOutcome(status: number): "read" | "signed_out" | "failed" {
  if (status === 401) return "signed_out";
  return status >= 200 && status < 300 ? "read" : "failed";
}

/** Pure: what a read holds, or null while it is out or when it came back without data. */
export function dataOf<T>(read: Read<T>): T | null {
  return read.state === "read" ? read.data : null;
}

/** Pure: whether any read was refused for want of a session. */
export function signedOut(reads: readonly Read<unknown>[]): boolean {
  return reads.some((r) => r.state === "signed_out");
}

export type Waiting =
  { state: "known"; count: number } | { state: "reading" } | { state: "unread" };

/**
 * Pure: how many decisions wait, from the two reads that can say so: the
 * rail's counts first, the queue itself second. "unread" once neither can
 * answer: the headline then says so instead of "Reading…" for ever, and
 * the waiting figure is left out rather than shown as nothing.
 */
export function waitingCount(
  nav: Read<{ pending: number }>,
  queue: Read<{ pending: readonly unknown[] }>,
): Waiting {
  const count = dataOf(nav)?.pending ?? dataOf(queue)?.pending.length ?? null;
  if (count !== null) return { state: "known", count };
  if (nav.state === "reading" || queue.state === "reading") return { state: "reading" };
  return { state: "unread" };
}

/** The windows "Your sales" can show, in days. */
export const PERIODS = [7, 30, 90] as const;

/**
 * Pure: the windows the period switch offers for `measured` days: each
 * standard window the days fill, then all of them when they end between
 * two ("7, 22" for 22 measured days). Fewer than two means no switch.
 */
export function periodOptions(measured: number): number[] {
  if (!Number.isInteger(measured) || measured <= 0) return [];
  const out: number[] = PERIODS.filter((p) => measured >= p);
  const widest = PERIODS[PERIODS.length - 1]!;
  if (measured < widest && !out.includes(measured)) out.push(measured);
  return out;
}

/** Pure: the window to show: the owner's last choice when it is offered, else 30 days, else the widest. */
export function periodFor(saved: number | null, options: readonly number[]): number | null {
  if (options.length === 0) return null;
  if (saved !== null && options.includes(saved)) return saved;
  return options.includes(30) ? 30 : options[options.length - 1]!;
}

/**
 * Pure: the line under the waiting figure. "Nothing to decide" only under
 * a counted zero, the biggest range only when there is one, and otherwise
 * no line: an unknown count, or decisions without a money range, are not
 * "nothing".
 */
export function waitingLine(count: number | null, hasRange: boolean): "none" | "biggest" | null {
  if (count === 0) return "none";
  return count !== null && hasRange ? "biggest" : null;
}
