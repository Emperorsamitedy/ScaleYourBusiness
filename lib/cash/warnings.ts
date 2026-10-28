// "Money gets tight" — Phase 5 Session B (P5-08). Pure.
//
// The first week of the 13 whose CAUTIOUS end (the low end of the range)
// dips under the owner's buffer, or under an empty account when no buffer is
// stated, with the reason in words: the lumps due that week ("the VAT return
// (€3,900, quarterly)"), a quiet stretch where last year's same weeks ran
// under the normal week, or simply more going out than coming in.
//
// It is a warning for the owner to read, never a push to act (rule 26, and
// rule 12: nothing here proposes anything). The words state what the
// forecast shows and why; they never tell the owner to move, borrow, chase
// or pay anything, and warnings.test.ts holds them to that. The warning goes
// to the watch log (lib/watch/job.ts, logCashWarning) and from there to the
// weekly summary's "What I noticed"; nothing else is sent.

import { shortDate } from "../charts/model";
import type { CashReady, CashWeek, Range } from "./model";
import { CASH, wholeMoney } from "./model";

export interface TightWeek {
  index: number;
  start: string;
  end: string;
  balance: Range;
  line: number;
  line_kind: "buffer" | "zero";
  /** How far the cautious end falls under the line, in minor units (> 0). */
  shortfall: number;
  /** The hopeful end is under the line too. */
  both_ends: boolean;
  reasons: string[];
  sentence: string;
  /** What the watch log compares, so an unchanged warning is said once. */
  signature: string;
}

/** Words a warning never uses: it reports, it doesn't push (P5-08). */
export const PUSH_WORDS =
  /\b(should|must|need to|have to|you'll want|consider|try|recommend|urge|borrow|transfer|move money|chase|act now|urgent|immediately)\b/i;

const sentenceList = (parts: readonly string[]) =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

const x1 = (v: number) => `${(Math.round(v * 10) / 10).toFixed(1)}×`;
/** "0.6–0.8×", or "0.3×" when both ends round alike. */
const spread = (lo: number, hi: number) => {
  const a = (Math.round(lo * 10) / 10).toFixed(1);
  const b = (Math.round(hi * 10) / 10).toFixed(1);
  return a === b ? `${a}×` : `${a}–${b}×`;
};

/** Pure: the reasons a week is tight, in words, most specific first. */
export function tightReasons(f: CashReady, k: number): string[] {
  const week = f.weeks[k]!;
  const cur = f.currency;
  const reasons: string[] = [];

  // Lumps due that week: a quarterly cost by name; the monthly ones together.
  for (const d of week.due.filter((x) => x.cadence === "quarterly" && !x.debt)) {
    reasons.push(`${d.label} (${wholeMoney(d.amount_minor, cur)}, quarterly)`);
  }
  const monthly = week.due.filter((x) => !x.debt && x.cadence !== "quarterly");
  if (monthly.length > 0) {
    const total = monthly.reduce((s, d) => s + d.amount_minor, 0);
    reasons.push(`your monthly costs on the 1st (${wholeMoney(total, cur)})`);
  }
  const debt = week.due.filter((x) => x.debt);
  if (debt.length > 0) {
    const total = debt.reduce((s, d) => s + d.amount_minor, 0);
    reasons.push(
      `${debt.length === 1 ? "a repayment" : "repayments"} on your debt (${wholeMoney(total, cur)})`,
    );
  }

  // A quiet stretch: last year's same weeks under the normal week, up to this one.
  const quiet: CashWeek[] = [];
  for (let j = k; j >= 0; j--) {
    const ly = f.weeks[j]!.last_year;
    if (ly === null || ly.index > CASH.quiet_index) break;
    quiet.unshift(f.weeks[j]!);
  }
  if (quiet.length === 1) {
    reasons.push(
      `a quiet week (last year the same week ran ${x1(quiet[0]!.last_year!.index)} your normal week)`,
    );
  } else if (quiet.length > 1) {
    const idx = quiet.map((w) => w.last_year!.index);
    reasons.push(
      `a quiet stretch (last year the same ${quiet.length} weeks ran ${spread(Math.min(...idx), Math.max(...idx))} your normal week)`,
    );
  }

  // Nothing lumpy and nothing quiet: the weeks to it take out more than they bring in.
  const nets = f.weeks.slice(0, k + 1).map((w) => w.net.low);
  const avg = nets.reduce((s, v) => s + v, 0) / nets.length;
  if (avg < 0 && reasons.length === 0) {
    reasons.push(
      `about ${wholeMoney(-avg, cur)} a week more going out than coming in at the cautious end`,
    );
  }
  if (reasons.length === 0) {
    reasons.push(
      `a start close to the line: your cash today is ${wholeMoney(f.start.amount_minor, cur)}`,
    );
  }
  return reasons;
}

/** Pure: the first week whose cautious end dips under the line, or null. */
export function tightWeek(f: CashReady): TightWeek | null {
  const line = f.line.amount_minor;
  const week = f.weeks.find((w) => w.balance.low < line);
  if (!week) return null;
  const cur = f.currency;
  const reasons = tightReasons(f, week.index);
  const both = week.balance.high < line;
  const lineWords =
    f.line.kind === "buffer"
      ? `under the ${wholeMoney(line, cur)} you want to keep`
      : "below zero, an overdrawn account";
  const hopeful = both
    ? `; even at the hopeful end it is about ${wholeMoney(week.balance.high, cur)}`
    : "";
  const when = week.index === 0 ? "this week" : `in the week of ${shortDate(week.start)}`;
  const sentence =
    `Money could get tight ${when}: at the cautious end the balance falls to about ` +
    `${wholeMoney(week.balance.low, cur)}, ${lineWords}${hopeful}. Why: ${sentenceList(reasons)}.`;
  return {
    index: week.index,
    start: week.start,
    end: week.end,
    balance: week.balance,
    line,
    line_kind: f.line.kind,
    shortfall: line - week.balance.low,
    both_ends: both,
    reasons,
    sentence,
    signature: `${week.start}|${f.line.kind}|${line}|${cur}`,
  };
}

/** The watch log's sentence when a warning logged before no longer holds. */
export function clearedSentence(f: CashReady): string {
  return f.line.kind === "buffer"
    ? `Cash: no week of the next ${CASH.horizon_weeks} dips under your ${wholeMoney(f.line.amount_minor, f.currency)} buffer at the cautious end any more.`
    : `Cash: no week of the next ${CASH.horizon_weeks} dips below zero at the cautious end any more.`;
}
