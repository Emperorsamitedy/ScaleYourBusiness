// Pure helpers for Insights · Cash flow (P5-10): the words and the chart
// model the screen draws from GET /api/cash. No React, no fetch — tested
// in cash-view.test.ts.
//
// L-3b: the fixed words (labels, column titles, week names) come from the
// "cash" catalogue through optional words, English by default; figures and
// dates in the reader's locale, in the business's currency. L-4b: the
// sentences built from the forecast (the headline, the sources line, the
// chart's title, meta, foot and summary) come from the "cashWords"
// catalogue through optional `SentenceWords`, English by default; the
// basis names from "sheet".

import type { CashView } from "../../app/api/cash/route";
import type { CashForecast, CashReady, Range, SourceLine } from "../../lib/cash/model";
import { CASH, wholeMoney } from "../../lib/cash/model";
import type { ScenarioCell } from "../../lib/cash/scenarios";
import { cashEnglish } from "../../lib/cash/words";
import { shortDate } from "../../lib/charts/model";
import type { Basis } from "../report/basis";
import { basisName } from "../report/basis";
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

/** The sentences' words: "cashWords", the basis names ("sheet"), and the locale (L-4b). */
export interface SentenceWords {
  tr: Tr;
  sheet: Tr;
  locale: AppLocale;
}
const SENTENCES = (): SentenceWords => ({ ...cashEnglish(), sheet: englishTr("sheet") });

const basisWord = (b: Basis, w: SentenceWords) => basisName(b, w.sheet);

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

/** A day the forecast names, in the reader's own date ("8 Nov 2025"). */
export function forecastDay(day: string, locale: AppLocale = "en"): string {
  return dayMonthYear(day, locale);
}

/** "€3,100 – €5,400", or one figure when both ends round alike. */
export function rangeText(r: Range, currency: string, locale: AppLocale = "en"): string {
  const a = wholeMoney(r.low, currency, locale);
  const b = wholeMoney(r.high, currency, locale);
  return a === b ? a : `${a} – ${b}`;
}

/** The page's one display line. */
export function headline(view: CashView, words: SentenceWords = SENTENCES()): string {
  const { tr, locale } = words;
  const f = view.forecast;
  if (f.status !== "ready") return f.headline;
  if (view.tight) {
    return tr("view.headlineTight", {
      when: view.tight.index === 0 ? "now" : "later",
      day: shortDate(view.tight.start, locale),
      amount: wholeMoney(view.tight.balance.low, f.currency, locale),
    });
  }
  const weeks = num(CASH.horizon_weeks, 0, locale);
  return f.line.kind === "buffer"
    ? tr("view.headlineBuffer", {
        weeks,
        amount: wholeMoney(f.line.amount_minor, f.currency, locale),
      })
    : tr("view.headlineZero", { weeks });
}

/** The three inputs the sources line names, by their stable key, with their inline words. */
const SOURCES_LINE: Partial<Record<SourceLine["key"], string>> = {
  cash: "view.inline.cash",
  moneyIn: "view.inline.moneyIn",
  payout: "view.inline.payout",
};

/** The sources line, always shown: what the forecast is built on, in one line. */
export function sourcesLine(f: CashForecast, words: SentenceWords = SENTENCES()): string {
  const { tr, locale } = words;
  if (f.status !== "ready") {
    if (f.history) {
      return tr("view.sourcesHistory", {
        source: f.history.source,
        noun: f.history.noun,
        days: f.history.covered_days,
        from: shortDate(f.history.first_day, locale),
        to: shortDate(f.history.last_day, locale),
        // More than enough history (the cash figure is what's missing) reads
        // "8 of 8", not "13 of 8".
        complete: num(Math.min(f.history.complete_weeks, f.history.needed_weeks), 0, locale),
        needed: f.history.needed_weeks,
      });
    }
    return tr("view.sourcesNothing");
  }
  const parts = f.sources.flatMap((s) => {
    const inline = SOURCES_LINE[s.key];
    if (!inline) return [];
    const label = tr(inline);
    return [
      s.basis
        ? tr("view.sourcesPartBasis", { label, value: s.value, basis: basisWord(s.basis, words) })
        : tr("view.sourcesPart", { label, value: s.value }),
    ];
  });
  return tr("view.sourcesReady", { parts: parts.join(" · ") });
}

export function cashChartModel(
  f: CashReady,
  tightIndex: number | null,
  words: CashWords = ENGLISH(),
  sentences: SentenceWords = SENTENCES(),
): CashChartModel {
  const { tr, locale } = words;
  const s = sentences.tr;
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
  const lineArgs = {
    line: f.line.kind,
    amount: f.line.kind === "buffer" ? wholeMoney(f.line.amount_minor, cur, locale) : "",
    day: tightIndex === null ? "" : shortDate(f.weeks[tightIndex]!.start, locale),
  };
  const pattern =
    f.pattern.kind === "season"
      ? s(f.pattern.growth ? "view.footGrowth" : "view.footSpan")
      : s("view.footRecent", { count: f.pattern.recent_complete });
  return {
    label: tr("view.chartLabel", { weeks: CASH.horizon_weeks }),
    title: s(tightIndex === null ? "view.titleAbove" : "view.titleUnder", lineArgs),
    meta: s("view.meta", {
      source: f.series.source,
      noun: f.series.noun,
      observed: basisWord("OBSERVED", sentences),
      stated: basisWord("STATED", sentences),
      assumed: basisWord("ASSUMED", sentences),
    }),
    foot: `${s("view.band")} ${pattern}`,
    summary: `${s("view.summary", {
      weeks: CASH.horizon_weeks,
      start: wholeMoney(f.start.amount_minor, cur, locale),
      end: rangeText(f.end, cur, locale),
    })} ${s(tightIndex === null ? "view.summaryAbove" : "view.summaryUnder", lineArgs)}`,
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
