// Pure helpers for Insights · Cash flow (P5-10): the words and the chart
// model the screen draws from GET /api/cash. No React, no fetch — tested
// in cash-view.test.ts.
//
// L-3b: the fixed words (labels, column titles, week names) come from the
// "cash" catalogue through optional words, English by default; figures and
// dates in the reader's locale, in the business's currency. The sentences
// built from the forecast (the headline, the sources line, the chart's
// title, meta, foot and summary) stay English until L-4.

import type { CashView } from "../../app/api/cash/route";
import type { CashForecast, CashReady, Range } from "../../lib/cash/model";
import { CASH, wholeMoney } from "../../lib/cash/model";
import type { ScenarioCell } from "../../lib/cash/scenarios";
import { shortDate } from "../../lib/charts/model";
import { dayMonthYear } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type { CashChartModel } from "../charts/CashChart";
import { num } from "../sheet/num";

/** The screen's words and the reader's locale: the "cash" catalogue. */
export interface CashWords {
  tr: Tr;
  locale: AppLocale;
}
const ENGLISH = (): CashWords => ({ tr: englishTr("cash"), locale: "en" });

/** Always on the screen, whatever state it is in (rule 26). The screen says it in the reader's language. */
export const PLANNING_NOTE = englishTr("cash")("planningNote");

/** A whole percent, "12%" — in another language its own way ("12 %"). */
export function percentText(whole: number, locale: AppLocale = "en"): string {
  if (locale === "en") return `${whole}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(whole / 100);
}

/** A day the forecast names: ISO in English, as it always was; the reader's own date elsewhere. */
export function forecastDay(day: string, locale: AppLocale = "en"): string {
  return locale === "en" ? day : dayMonthYear(day, locale);
}

/** "€3,100 – €5,400", or one figure when both ends round alike. */
export function rangeText(r: Range, currency: string, locale: AppLocale = "en"): string {
  const a = wholeMoney(r.low, currency, locale);
  const b = wholeMoney(r.high, currency, locale);
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

export function cashChartModel(
  f: CashReady,
  tightIndex: number | null,
  words: CashWords = ENGLISH(),
): CashChartModel {
  const { tr, locale } = words;
  const cur = f.currency;
  const points = [
    {
      label: tr("view.today"),
      start: f.today,
      low: f.start.amount_minor,
      high: f.start.amount_minor,
    },
    ...f.weeks.map((w) => ({
      label: tr("view.weekOf", { day: shortDate(w.start, locale) }),
      start: w.start,
      low: w.balance.low,
      high: w.balance.high,
    })),
  ];
  const lineWords =
    f.line.kind === "buffer" ? `your ${wholeMoney(f.line.amount_minor, cur)} buffer` : "zero";
  return {
    label: tr("view.chartLabel", { weeks: CASH.horizon_weeks }),
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
export function weekRows(f: CashReady, words: CashWords = ENGLISH()): WeekRow[] {
  const { tr, locale } = words;
  const cur = f.currency;
  return f.weeks.map((w) => {
    const dated = w.fixed_out + w.debt_out;
    const out: Range = {
      low: dated + w.variable_out.low,
      high: dated + w.variable_out.high,
    };
    return {
      key: w.start,
      week: tr("view.weekOf", { day: shortDate(w.start, locale) }),
      money_in: rangeText(w.money_in, cur, locale),
      going_out: rangeText(
        { low: Math.min(out.low, out.high), high: Math.max(out.low, out.high) },
        cur,
        locale,
      ),
      due:
        w.due.length === 0
          ? "—"
          : w.due
              .map((d) => {
                const item = `${d.label} ${wholeMoney(d.amount_minor, cur, locale)}`;
                return d.set_aside ? tr("view.twelfth", { item }) : item;
              })
              .join(" · "),
      balance: rangeText(w.balance, cur, locale),
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

const signedRange = (r: Range, cur: string, words: CashWords) => {
  const one = (v: number) =>
    v > 0 ? `+${wholeMoney(v, cur, words.locale)}` : wholeMoney(v, cur, words.locale);
  const a = one(r.low);
  const b = one(r.high);
  return a === b ? a : words.tr("view.signedRange", { low: a, high: b });
};

/** The plain forecast first, then each scenario, as columns. */
export function scenarioColumns(
  f: CashReady,
  tightIndex: number | null,
  cells: readonly ScenarioCell[],
  words: CashWords = ENGLISH(),
): ScenarioColumn[] {
  const { tr, locale } = words;
  const cur = f.currency;
  const weekOf = (day: string) => tr("view.weekOfLower", { day: shortDate(day, locale) });
  const tightWords = (k: number | null, of: CashReady) =>
    k === null ? tr("view.none") : weekOf(of.weeks[k]!.start);
  const plain: ScenarioColumn = {
    key: "plain",
    title: tr("view.plainTitle"),
    change: tr("view.plainChange"),
    status: "ready",
    lowest: wholeMoney(f.lowest.balance.low, cur, locale),
    lowest_week: weekOf(f.weeks[f.lowest.index]!.start),
    end: rangeText(f.end, cur, locale),
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
        lowest: wholeMoney(r.lowest.balance.low, cur, locale),
        lowest_week: weekOf(r.forecast.weeks[r.lowest.index]!.start),
        end: rangeText(r.end, cur, locale),
        vs_plain: signedRange(r.vs_plain, cur, words),
        tight: r.tight === null ? tr("view.none") : weekOf(r.tight.start),
        why: null,
        needs: [],
      };
    }),
  ];
}

/** "Week 1 · 27 Oct", for the scenario week pickers. */
export function weekOptions(
  f: CashReady,
  words: CashWords = ENGLISH(),
): { value: number; label: string }[] {
  const { tr, locale } = words;
  return f.weeks.map((w) => ({
    value: w.index,
    label: tr("view.weekOption", {
      n: num(w.index + 1, 0, locale),
      day: shortDate(w.start, locale),
    }),
  }));
}
