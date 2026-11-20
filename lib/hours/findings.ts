// Trading-hours findings — P2-30's last mile (Phase 2 Session F).
//
// The analysis (./trading) is per weekday; the report and the watch need
// findings an owner reads: one per signal, naming the weekdays it fires
// on, carrying the arithmetic that fired it, the coverage line ("card
// sales only…") and the honest limit. Pure and deterministic — no model,
// the same analysis always gives the same findings (CLAUDE.md cost rule).
//
// Weekdays still short of measured days are one `too_early` finding that
// says how many weeks remain; it is a finding, not a failure (rule 5's
// spirit), and it never guesses a verdict for them.

import type { Weekday } from "./schedule";
import { WEEKDAYS } from "./schedule";
import type { TradingAnalysis, WeekdayAnalysis } from "./trading";
import { TRADING } from "./trading";

export const DAY_WORD: Record<Weekday, string> = {
  mon: "Mondays",
  tue: "Tuesdays",
  wed: "Wednesdays",
  thu: "Thursdays",
  fri: "Fridays",
  sat: "Saturdays",
  sun: "Sundays",
};

export type HoursSignal = "opening" | "closing" | "attention" | "too_early";

export interface HoursFinding {
  signal: HoursSignal;
  weekdays: Weekday[];
  title: string;
  detail: string;
  /** The lines that fired it, one per weekday, prefixed with the day. */
  arithmetic: string[];
}

/** What the report stores and the watch logs. Null when nothing is measured. */
export interface TradingHoursBlock {
  from: string;
  to: string;
  zone: string;
  currency: string;
  coverage: string;
  limit: string;
  findings: HoursFinding[];
}

/** "Fridays", "Fridays and Saturdays", "Mondays, Tuesdays and Fridays". */
export function dayList(days: readonly Weekday[]): string {
  const words = days.map((d) => DAY_WORD[d]);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

const SIGNALS: {
  signal: Exclude<HoursSignal, "too_early">;
  fired: (w: WeekdayAnalysis) => boolean;
  /** Which arithmetic line belongs to this signal. */
  line: RegExp;
  title: (days: string) => string;
  detail: string;
}[] = [
  {
    signal: "opening",
    fired: (w) => w.opening_signal,
    line: /opening signal/,
    title: (days) => `Demand probably starts before you open on ${days}`,
    detail:
      "Your first open hour already takes most of what your best hour takes, so people are likely arriving, or wanting to, before the doors open.",
  },
  {
    signal: "closing",
    fired: (w) => w.closing_signal === true,
    line: /closing signal/,
    title: (days) => `The last hour doesn't pay for itself on ${days}`,
    detail:
      "On most measured days the final open hour took less than an open hour costs you in staff and energy.",
  },
  {
    signal: "attention",
    fired: (w) => w.attention_signal === true,
    line: /attention signal/,
    title: (days) => `People look you up online well before you open on ${days}`,
    detail:
      "A large share of that day's website visits come in the hours just before opening: interest is there before the doors are.",
  },
];

function prefixed(w: WeekdayAnalysis, line: RegExp): string[] {
  return w.arithmetic.filter((a) => line.test(a)).map((a) => `${DAY_WORD[w.weekday]}: ${a}`);
}

/**
 * Pure: the findings for one analysis, in a fixed order (opening, closing,
 * attention, too_early), each naming its weekdays Monday first.
 */
export function tradingFindings(analysis: TradingAnalysis): TradingHoursBlock | null {
  if (analysis.status !== "ok") return null;
  // No stated hours on any day: nothing to judge, and silence must not read as "all fine".
  if (analysis.weekdays.every((w) => w.verdict === "hours_unknown")) return null;
  const byDay = new Map(analysis.weekdays.map((w) => [w.weekday, w]));
  const ordered = WEEKDAYS.flatMap((d) => {
    const w = byDay.get(d);
    return w ? [w] : [];
  });

  const findings: HoursFinding[] = [];
  for (const s of SIGNALS) {
    const fired = ordered.filter((w) => w.verdict === "ok" && s.fired(w));
    if (fired.length === 0) continue;
    const weekdays = fired.map((w) => w.weekday);
    findings.push({
      signal: s.signal,
      weekdays,
      title: s.title(dayList(weekdays)),
      detail: s.detail,
      arithmetic: fired.flatMap((w) => prefixed(w, s.line)),
    });
  }

  const early = ordered.filter((w) => w.verdict === "too_early");
  if (early.length > 0) {
    // One measured day per weekday per week, so days short = weeks to wait.
    const weeks = Math.max(...early.map((w) => TRADING.min_days_per_weekday - w.days_measured));
    const weekdays = early.map((w) => w.weekday);
    findings.push({
      signal: "too_early",
      weekdays,
      title: `Too early to judge ${dayList(weekdays)}: about ${weeks} more week${weeks === 1 ? "" : "s"} of measured sales`,
      detail: `A verdict on a weekday needs ${TRADING.min_days_per_weekday} measured days of it. Until then nothing is concluded about those days.`,
      arithmetic: early.map(
        (w) =>
          `${DAY_WORD[w.weekday]}: ${w.days_measured} of ${TRADING.min_days_per_weekday} measured days`,
      ),
    });
  }

  return {
    from: analysis.from,
    to: analysis.to,
    zone: analysis.zone,
    currency: analysis.currency,
    coverage: analysis.coverage,
    limit: analysis.limit,
    findings,
  };
}

/** Which signals fire on which days — the watch logs only when this moves. */
export function findingsSignature(block: TradingHoursBlock): string {
  return block.findings.map((f) => `${f.signal}:${f.weekdays.join(",")}`).join(";");
}
