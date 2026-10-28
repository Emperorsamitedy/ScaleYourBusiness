// Pure helpers for Insights · Cash flow (P5-10): the words and the chart
// model the screen draws from GET /api/cash. No React, no fetch — tested
// in cash-view.test.ts.

import type { CashView } from "../../app/api/cash/route";
import type { CashForecast, CashReady, Range } from "../../lib/cash/model";
import { CASH, wholeMoney } from "../../lib/cash/model";
import type { ScenarioCell } from "../../lib/cash/scenarios";
import { shortDate } from "../../lib/charts/model";
import type { CashChartModel } from "../charts/CashChart";

/** Always on the screen, whatever state it is in (rule 26). */
export const PLANNING_NOTE =
  "A planning aid from your own numbers, not financial advice. SYB never moves, pays or collects money.";

/** "€3,100 – €5,400", or one figure when both ends round alike. */
export function rangeText(r: Range, currency: string): string {
  const a = wholeMoney(r.low, currency);
  const b = wholeMoney(r.high, currency);
  return a === b ? a : `${a} – ${b}`;
}

/** The page's one display line. */
export function headline(view: CashView): string {
  const f = view.forecast;
  if (f.status !== "ready") return f.headline;
  if (view.tight) {
    const when =
      view.tight.index === 0 ? "this week" : `in the week of ${shortDate(view.tight.start)}`;
    return `Money could get tight ${when}: the cautious end falls to ${wholeMoney(view.tight.balance.low, f.currency)}.`;
  }
  return f.line.kind === "buffer"
    ? `No week of the next ${CASH.horizon_weeks} dips under your ${wholeMoney(f.line.amount_minor, f.currency)} buffer, even at the cautious end.`
    : `No week of the next ${CASH.horizon_weeks} goes below zero, even at the cautious end.`;
}

/** The sources line, always shown: what the forecast is built on, in one line. */
export function sourcesLine(f: CashForecast): string {
  if (f.status !== "ready") {
    if (f.history) {
      return `Sources: ${f.history.source} ${f.history.noun}, ${f.history.covered_days} measured days from ${shortDate(f.history.first_day)} to ${shortDate(f.history.last_day)}; ${f.history.complete_weeks} of ${f.history.needed_weeks} complete weeks needed.`;
    }
    return "Sources: nothing measured that a forecast can be built on yet.";
  }
  const parts = f.sources
    .filter((s) => ["Cash today", "Money in", "Payout timing"].includes(s.label))
    .map((s) => `${s.label.toLowerCase()} ${s.value}${s.basis ? ` (${s.basis})` : ""}`);
  return `Sources: ${parts.join(" · ")} · your costs as you listed them.`;
}

export function cashChartModel(f: CashReady, tightIndex: number | null): CashChartModel {
  const cur = f.currency;
  const points = [
    { label: "Today", start: f.today, low: f.start.amount_minor, high: f.start.amount_minor },
    ...f.weeks.map((w) => ({
      label: `Week of ${shortDate(w.start)}`,
      start: w.start,
      low: w.balance.low,
      high: w.balance.high,
    })),
  ];
  const lineWords =
    f.line.kind === "buffer" ? `your ${wholeMoney(f.line.amount_minor, cur)} buffer` : "zero";
  return {
    label: `The next ${CASH.horizon_weeks} weeks · balance at each week's end`,
    title:
      tightIndex === null
        ? `Above ${lineWords} all the way`
        : `Under ${lineWords} in the week of ${shortDate(f.weeks[tightIndex]!.start)}`,
    meta: `${f.series.source} · ${f.series.noun} OBSERVED · costs STATED · timing ASSUMED`,
    foot: `The band runs from the cautious end (slow sales, slow payouts) to the hopeful end. ${f.pattern.kind === "season" ? (f.pattern.growth ? "Each week follows the same week last year, scaled by your recent growth." : "Each week runs between the same week last year and your recent weeks.") : `Each week runs like your last ${f.pattern.recent_complete} complete weeks.`}`,
    summary: `Your balance over the next ${CASH.horizon_weeks} weeks, from ${wholeMoney(f.start.amount_minor, cur)} today to ${rangeText(f.end, cur)}. ${tightIndex === null ? `It stays above ${lineWords}.` : `The cautious end dips under ${lineWords} in the week of ${shortDate(f.weeks[tightIndex]!.start)}.`}`,
    points,
    line: { amount: f.line.amount_minor, label: f.line.kind === "buffer" ? "BUFFER" : "ZERO" },
    tight: tightIndex === null ? null : tightIndex + 1,
    currency: cur,
  };
}

export interface WeekRow {
  key: string;
  week: string;
  money_in: string;
  going_out: string;
  due: string;
  balance: string;
  under: boolean;
}

/** The week-by-week table: every figure the chart draws, in words. */
export function weekRows(f: CashReady): WeekRow[] {
  const cur = f.currency;
  return f.weeks.map((w) => {
    const dated = w.fixed_out + w.debt_out;
    const out: Range = {
      low: dated + w.variable_out.low,
      high: dated + w.variable_out.high,
    };
    return {
      key: w.start,
      week: `Week of ${shortDate(w.start)}`,
      money_in: rangeText(w.money_in, cur),
      going_out: rangeText(
        { low: Math.min(out.low, out.high), high: Math.max(out.low, out.high) },
        cur,
      ),
      due:
        w.due.length === 0
          ? "—"
          : w.due
              .map(
                (d) =>
                  `${d.label} ${wholeMoney(d.amount_minor, cur)}${d.set_aside ? " (a twelfth)" : ""}`,
              )
              .join(" · "),
      balance: rangeText(w.balance, cur),
      under: w.balance.low < f.line.amount_minor,
    };
  });
}

export interface ScenarioColumn {
  key: string;
  title: string;
  change: string;
  status: "ready" | "missing";
  lowest: string;
  lowest_week: string;
  end: string;
  vs_plain: string;
  tight: string;
  why: string | null;
  needs: { what: string; href: string }[];
}

const signedRange = (r: Range, cur: string) => {
  const one = (v: number) => (v > 0 ? `+${wholeMoney(v, cur)}` : wholeMoney(v, cur));
  const a = one(r.low);
  const b = one(r.high);
  return a === b ? a : `${a} to ${b}`;
};

/** The plain forecast first, then each scenario, as columns. */
export function scenarioColumns(
  f: CashReady,
  tightIndex: number | null,
  cells: readonly ScenarioCell[],
): ScenarioColumn[] {
  const cur = f.currency;
  const tightWords = (k: number | null, of: CashReady) =>
    k === null ? "none" : `week of ${shortDate(of.weeks[k]!.start)}`;
  const plain: ScenarioColumn = {
    key: "plain",
    title: "As things are",
    change: "Nothing changes.",
    status: "ready",
    lowest: wholeMoney(f.lowest.balance.low, cur),
    lowest_week: `week of ${shortDate(f.weeks[f.lowest.index]!.start)}`,
    end: rangeText(f.end, cur),
    vs_plain: "—",
    tight: tightWords(tightIndex, f),
    why: null,
    needs: [],
  };
  return [
    plain,
    ...cells.map((c): ScenarioColumn => {
      if (c.status === "missing") {
        return {
          key: c.kind,
          title: c.title,
          change: "—",
          status: "missing",
          lowest: "—",
          lowest_week: "",
          end: "—",
          vs_plain: "—",
          tight: "—",
          why: c.why,
          needs: c.needs,
        };
      }
      const r = c.result;
      return {
        key: r.kind,
        title: r.title,
        change: r.change,
        status: "ready",
        lowest: wholeMoney(r.lowest.balance.low, cur),
        lowest_week: `week of ${shortDate(r.forecast.weeks[r.lowest.index]!.start)}`,
        end: rangeText(r.end, cur),
        vs_plain: signedRange(r.vs_plain, cur),
        tight: r.tight === null ? "none" : `week of ${shortDate(r.tight.start)}`,
        why: null,
        needs: [],
      };
    }),
  ];
}

/** "Week 1 · 27 Oct", for the scenario week pickers. */
export function weekOptions(f: CashReady): { value: number; label: string }[] {
  return f.weeks.map((w) => ({
    value: w.index,
    label: `Week ${w.index + 1} · ${shortDate(w.start)}`,
  }));
}
