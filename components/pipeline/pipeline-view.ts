// Pure read-model for the pipeline screen (P5-17): the headline, the quiet
// sentence, the stale reason, the win rate in words and the follow-up's
// worded flag. Everything is counted from what the API returns; nothing is
// estimated here.

import type { Money } from "../../lib/core/money";
import type { DealAge, Staleness, Weighted, WinRate } from "../../lib/pipeline/maths";
import { minorUnitExponent } from "../../lib/core/money";
import { moneyText } from "../sheet/num";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const money = (m: Money) => moneyText(m.amount_minor, m.currency);

/** A weighted figure in whole units: the range is an estimate, so cents would be false precision. */
export const roughMoney = (m: Money) => {
  const unit = 10 ** minorUnitExponent(m.currency);
  return moneyText(Math.round(m.amount_minor / unit) * unit, m.currency);
};

/** "Nobody has spoken to Café Nua in 23 days" — the follow-up's own words. */
export function quietSentence(who: string, age: DealAge): string {
  if (age.quiet_from === "added") {
    return age.days_quiet === 0
      ? `${who} was added today; no conversation recorded yet`
      : `Nothing recorded with ${who} since you added it, ${plural(age.days_quiet, "day")} ago`;
  }
  if (age.days_quiet === 0) return `You spoke to ${who} today`;
  return `Nobody has spoken to ${who} in ${plural(age.days_quiet, "day")}`;
}

const DAY_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

export function dayWords(day: string): string {
  return DAY_FMT.format(new Date(`${day}T00:00:00Z`));
}

const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "28 Oct 2025": a day with its year, for a window that spans one. */
export function dateWords(day: string): string {
  return DATE_FMT.format(new Date(`${day.slice(0, 10)}T00:00:00Z`));
}

export function staleWhy(stale: Staleness): string {
  return stale.why === "no_next_step"
    ? "No next step"
    : `Next step was due ${dayWords(stale.due)}, ${plural(stale.days_over, "day")} ago`;
}

const pct = (f: number) => `${Math.round(f * 100)}%`;

/** The win rate in words: what it is, what it rests on, its range. */
export function rateWords(rate: WinRate): string {
  if (rate.basis === "none") return "Not known yet";
  if (rate.basis === "measured") {
    const n = rate.closed.won + rate.closed.lost;
    return `${pct(rate.point)} measured: ${rate.closed.won} won of ${n} closed, likely ${pct(rate.low)}–${pct(rate.high)}`;
  }
  return `${pct(rate.point)} as you stated it, read as ${pct(rate.low)}–${pct(rate.high)}`;
}

/** The screen's one display line, stated from real data. */
export function pipelineHeadline(open: number, weighted: Weighted | undefined): string {
  if (open === 0 || weighted === undefined) return "No open deals yet.";
  if (!weighted.ok) {
    const totals = weighted.open_totals.map(money).join(" and ");
    return totals === ""
      ? `${plural(open, "open deal")}, none with a value yet.`
      : `${plural(open, "open deal")} worth ${totals}. I can't weigh them yet.`;
  }
  if (weighted.lines.length === 0) return `${plural(open, "open deal")}, none with a value yet.`;
  const first = weighted.lines[0]!;
  const more =
    weighted.lines.length > 1
      ? `, and more in ${plural(weighted.lines.length - 1, "other currency", "other currencies")}`
      : "";
  return `${roughMoney(first.low)}–${roughMoney(first.high)} of your ${money(first.open_total)} open is likely to close${more}.`;
}

export type FollowUpTone = "ok" | "drift" | "low" | "alarm";

/** A follow-up proposal's state as a worded flag. */
export function followUpWord(f: {
  status: string;
  draft: unknown;
  blocked_by_limit: string | null;
}): { word: string; tone: FollowUpTone } {
  if (f.status === "approved" || f.status === "executed") {
    return f.draft ? { word: "drafted", tone: "ok" } : { word: "approved", tone: "ok" };
  }
  if (f.status === "pending") return { word: "waiting for you", tone: "drift" };
  if (f.status === "blocked") return { word: "blocked by your rule", tone: "alarm" };
  if (f.status === "rejected") return { word: "declined", tone: "low" };
  if (f.status === "changes_requested") return { word: "changes asked", tone: "drift" };
  return { word: f.status, tone: "low" };
}
