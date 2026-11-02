// Pure read-model for the pipeline screen (P5-17): the headline, the quiet
// sentence, the stale reason, the win rate in words and the follow-up's
// worded flag. Everything is counted from what the API returns; nothing is
// estimated here.
//
// L-3b (TASKS-LANGUAGES.md): the words are the "pipeline" catalogue through
// an optional translator, English by default (so English has one source),
// and every figure and date is in the reader's locale.

import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import { dayMonth, dayMonthYear } from "../../lib/i18n/format";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type { Money } from "../../lib/core/money";
import type { DealAge, Staleness, Weighted, WinRate } from "../../lib/pipeline/maths";
import { minorUnitExponent } from "../../lib/core/money";
import { moneyText } from "../sheet/num";

/** The screen's words and the reader's locale. */
export interface PipelineWords {
  tr: Tr;
  locale: AppLocale;
}
const ENGLISH = (): PipelineWords => ({ tr: englishTr("pipeline"), locale: "en" });

export const money = (m: Money, locale: AppLocale = "en") =>
  moneyText(m.amount_minor, m.currency, locale);

/** A weighted figure in whole units: the range is an estimate, so cents would be false precision. */
export const roughMoney = (m: Money, locale: AppLocale = "en") => {
  const unit = 10 ** minorUnitExponent(m.currency);
  return moneyText(Math.round(m.amount_minor / unit) * unit, m.currency, locale);
};

/** "Nobody has spoken to Café Nua in 23 days" — the follow-up's own words. */
export function quietSentence(who: string, age: DealAge, w: PipelineWords = ENGLISH()): string {
  const { tr } = w;
  if (age.quiet_from === "added") {
    return age.days_quiet === 0
      ? tr("view.quietAddedToday", { who })
      : tr("view.quietAddedAgo", { who, days: age.days_quiet });
  }
  if (age.days_quiet === 0) return tr("view.spokeToday", { who });
  return tr("view.nobodySpoke", { who, days: age.days_quiet });
}

const DAY_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** "6 Nov"; in another language, its own day-and-month (L-1). */
export function dayWords(day: string, locale: AppLocale = "en"): string {
  if (locale !== "en") return dayMonth(day, locale);
  return DAY_FMT.format(new Date(`${day}T00:00:00Z`));
}

const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "28 Oct 2025": a day with its year, for a window that spans one; in another language, its own. */
export function dateWords(day: string, locale: AppLocale = "en"): string {
  if (locale !== "en") return dayMonthYear(day, locale);
  return DATE_FMT.format(new Date(`${day.slice(0, 10)}T00:00:00Z`));
}

export function staleWhy(stale: Staleness, w: PipelineWords = ENGLISH()): string {
  return stale.why === "no_next_step"
    ? w.tr("view.noNextStep")
    : w.tr("view.overdue", { day: dayWords(stale.due, w.locale), days: stale.days_over });
}

/** A whole percent from a fraction: "25%"; in another language, its own ("25 %", "25 %"). */
export function pct(f: number, locale: AppLocale = "en"): string {
  if (locale === "en") return `${Math.round(f * 100)}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(Math.round(f * 100) / 100);
}

/** A percent the owner stated (25 or 22.5), as they stated it. */
export function statedPct(p: number, locale: AppLocale = "en"): string {
  if (locale === "en") return `${p}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(p / 100);
}

/** The win rate in words: what it is, what it rests on, its range. */
export function rateWords(rate: WinRate, w: PipelineWords = ENGLISH()): string {
  const { tr, locale } = w;
  if (rate.basis === "none") return tr("view.rateNone");
  const p = (f: number) => pct(f, locale);
  if (rate.basis === "measured") {
    return tr("view.rateMeasured", {
      point: p(rate.point),
      won: rate.closed.won,
      closed: rate.closed.won + rate.closed.lost,
      low: p(rate.low),
      high: p(rate.high),
    });
  }
  return tr("view.rateStated", { point: p(rate.point), low: p(rate.low), high: p(rate.high) });
}

/** The screen's one display line, stated from real data. */
export function pipelineHeadline(
  open: number,
  weighted: Weighted | undefined,
  w: PipelineWords = ENGLISH(),
): string {
  const { tr, locale } = w;
  if (open === 0 || weighted === undefined) return tr("view.headNone");
  if (!weighted.ok) {
    const totals = weighted.open_totals.map((m) => money(m, locale)).join(` ${tr("view.and")} `);
    return totals === ""
      ? tr("view.headNoValue", { open })
      : tr("view.headCantWeigh", { open, totals });
  }
  if (weighted.lines.length === 0) return tr("view.headNoValue", { open });
  const first = weighted.lines[0]!;
  const values = {
    low: roughMoney(first.low, locale),
    high: roughMoney(first.high, locale),
    total: money(first.open_total, locale),
  };
  return weighted.lines.length > 1
    ? tr("view.headLikelyMore", { ...values, others: weighted.lines.length - 1 })
    : tr("view.headLikely", values);
}

export type FollowUpTone = "ok" | "drift" | "low" | "alarm";

/** A follow-up proposal's state as a worded flag. */
export function followUpWord(
  f: {
    status: string;
    draft: unknown;
    blocked_by_limit: string | null;
  },
  tr: Tr = ENGLISH().tr,
): { word: string; tone: FollowUpTone } {
  if (f.status === "approved" || f.status === "executed") {
    return f.draft
      ? { word: tr("view.follow.drafted"), tone: "ok" }
      : { word: tr("view.follow.approved"), tone: "ok" };
  }
  if (f.status === "pending") return { word: tr("view.follow.pending"), tone: "drift" };
  if (f.status === "blocked") return { word: tr("view.follow.blocked"), tone: "alarm" };
  if (f.status === "rejected") return { word: tr("view.follow.rejected"), tone: "low" };
  if (f.status === "changes_requested") {
    return { word: tr("view.follow.changes_requested"), tone: "drift" };
  }
  return { word: f.status, tone: "low" };
}
