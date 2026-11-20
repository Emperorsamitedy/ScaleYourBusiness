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
//
// L-4b: the sentence and reasons come from the "cashWords" catalogue through
// optional words, English by default — the watch log is written with the
// default, so what is stored stays English (rule 7); the screen's copy is in
// the reader's language. clearedSentence is only ever logged, so it is English.

import { shortDate } from "../charts/model";
import { rangeOf } from "../i18n/range";
import type { CashReady, CashWeek, Range } from "./model";
import { CASH, wholeMoney } from "./model";
import type { Words } from "./words";
import { andList, cashEnglish, timesText } from "./words";

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

/** Pure: the reasons a week is tight, in words, most specific first. */
export function tightReasons(f: CashReady, k: number, words: Words = cashEnglish()): string[] {
  const { tr, locale } = words;
  const week = f.weeks[k]!;
  const cur = f.currency;
  const whole = (minor: number) => wholeMoney(minor, cur, locale);
  const x1 = (v: number) => timesText(v, 1, locale);
  /** "0.6 to 0.8×", or "0.3×" when both ends round alike. */
  const spread = (lo: number, hi: number) => {
    const a = x1(lo);
    const b = x1(hi);
    return a === b ? a : rangeOf(a.slice(0, -1), b, locale);
  };
  const reasons: string[] = [];

  // Lumps due that week: a quarterly cost by name; the monthly ones together.
  for (const d of week.due.filter((x) => x.cadence === "quarterly" && !x.debt)) {
    reasons.push(tr("tight.quarterly", { label: d.label, amount: whole(d.amount_minor) }));
  }
  const monthly = week.due.filter((x) => !x.debt && x.cadence !== "quarterly");
  if (monthly.length > 0) {
    const total = monthly.reduce((s, d) => s + d.amount_minor, 0);
    reasons.push(tr("tight.monthly", { day: 1, amount: whole(total) }));
  }
  const debt = week.due.filter((x) => x.debt);
  if (debt.length > 0) {
    const total = debt.reduce((s, d) => s + d.amount_minor, 0);
    reasons.push(tr("tight.debt", { count: debt.length, amount: whole(total) }));
  }

  // A quiet stretch: last year's same weeks under the normal week, up to this one.
  const quiet: CashWeek[] = [];
  for (let j = k; j >= 0; j--) {
    const ly = f.weeks[j]!.last_year;
    if (ly === null || ly.index > CASH.quiet_index) break;
    quiet.unshift(f.weeks[j]!);
  }
  if (quiet.length === 1) {
    reasons.push(tr("tight.quietWeek", { index: x1(quiet[0]!.last_year!.index) }));
  } else if (quiet.length > 1) {
    const idx = quiet.map((w) => w.last_year!.index);
    reasons.push(
      tr("tight.quietStretch", {
        count: quiet.length,
        spread: spread(Math.min(...idx), Math.max(...idx)),
      }),
    );
  }

  // Nothing lumpy and nothing quiet: the weeks to it take out more than they bring in.
  const nets = f.weeks.slice(0, k + 1).map((w) => w.net.low);
  const avg = nets.reduce((s, v) => s + v, 0) / nets.length;
  if (avg < 0 && reasons.length === 0) {
    reasons.push(tr("tight.outrun", { amount: whole(-avg) }));
  }
  if (reasons.length === 0) {
    reasons.push(tr("tight.startClose", { amount: whole(f.start.amount_minor) }));
  }
  return reasons;
}

/** Pure: the first week whose cautious end dips under the line, or null. */
export function tightWeek(f: CashReady, words: Words = cashEnglish()): TightWeek | null {
  const { tr, locale } = words;
  const line = f.line.amount_minor;
  const week = f.weeks.find((w) => w.balance.low < line);
  if (!week) return null;
  const cur = f.currency;
  const reasons = tightReasons(f, week.index, words);
  const both = week.balance.high < line;
  const sentence = tr("tight.sentence", {
    when: week.index === 0 ? "now" : "later",
    day: shortDate(week.start, locale),
    low: wholeMoney(week.balance.low, cur, locale),
    line: f.line.kind,
    buffer: f.line.kind === "buffer" ? wholeMoney(line, cur, locale) : "",
    both: both ? "yes" : "no",
    high: both ? wholeMoney(week.balance.high, cur, locale) : "",
    reasons: andList(reasons, locale),
  });
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
