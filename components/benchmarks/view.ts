// The words of /benchmarks (idea 44), pure: the head, the source foot, and
// each line's sentence. Plain, first person where SYB speaks, and never a
// judgement (ux-spec §10): a figure is above, below or about the same, and
// nothing here says what to do about it.
//
// L-3b: the fixed words are the "benchmarks" catalogue through an optional
// translator, English by default; dates in the reader's locale. The cell,
// size and country words, the figures and the caveat come from
// lib/benchmarks, already in the reader's language (L-4b, the route's
// "benchmarksWords").

import type { AppLocale } from "../../lib/i18n/locales";
import { dayMonthYear } from "../../lib/i18n/format";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type { BenchLine, BenchResult, ComparedLine } from "../../lib/benchmarks/compare";
import type { BenchSource } from "../../lib/benchmarks/snapshot";

/** The screen's words and the reader's locale: the "benchmarks" catalogue. */
export interface BenchWords {
  tr: Tr;
  locale: AppLocale;
}
const ENGLISH = (): BenchWords => ({ tr: englishTr("benchmarks"), locale: "en" });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-30" → "30 Sep 2026"; in another language, its own (L-1). */
export function dateWords(iso: string, locale: AppLocale = "en"): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  if (locale !== "en") return dayMonthYear(iso, locale);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The page head: the cell in words, or what stops the comparison. */
export function headline(r: BenchResult, w: BenchWords = ENGLISH()): string {
  const { tr } = w;
  switch (r.status) {
    case "ready":
      return tr("head.ready", {
        group: r.head.group,
        size: r.head.size_words,
        country: r.head.country,
      });
    case "no_type":
      return tr("head.noType");
    case "unmapped":
      return tr("head.unmapped");
    case "no_country":
      return tr("head.noCountry");
    case "outside_eu":
      return tr("head.outsideEu", { country: r.country });
  }
}

/** The source foot, always printed. */
export function footLine(s: BenchSource, caveat: string, w: BenchWords = ENGLISH()): string {
  return w.tr("foot", {
    dataset: s.dataset,
    doi: s.doi.replace(/^https:\/\//, ""),
    updated: dateWords(s.updated, w.locale),
    retrieved: dateWords(s.retrieved, w.locale),
    caveat,
  });
}

/** "Yours is 36.4%, theirs 1.2%: 35.2 points above." */
export function lineSentence(l: ComparedLine, w: BenchWords = ENGLISH()): string {
  return w.tr("line", { own: l.own_words, bench: l.bench_words, gap: l.gap_words });
}

const READING_KEY: Record<string, string> = {
  above: "reading.above",
  below: "reading.below",
  "about the same": "reading.same",
};

/** The boxed reading word, in caps: ABOVE, BELOW, ABOUT THE SAME (English; one argument, so it maps). */
export function readingWord(l: BenchLine): string {
  return readingWordIn(l, ENGLISH());
}

/** The boxed reading word in the reader's language. */
export function readingWordIn(l: BenchLine, w: BenchWords): string {
  if (l.status === "compared") {
    const key = READING_KEY[l.reading];
    return key ? w.tr(key) : l.reading.toUpperCase();
  }
  return w.tr(l.status === "missing" ? "reading.notYet" : "reading.none");
}

/** How many lines could be compared, for the aside. */
export function comparedCount(r: BenchResult, w: BenchWords = ENGLISH()): string {
  if (r.status !== "ready") return w.tr("nothingCompared");
  const n = r.lines.filter((l) => l.status === "compared").length;
  return w.tr("comparedCount", { count: n, total: r.lines.length });
}

/** Why the size is what it is, when it isn't the owner's headcount. */
export function sizeNote(r: BenchResult, w: BenchWords = ENGLISH()): string | null {
  if (r.status !== "ready") return null;
  if (r.head.size_via === "none") return w.tr("size.unknown");
  if (r.head.size_via === "size_band" && r.head.size === "TOTAL") return w.tr("size.spans");
  return null;
}
