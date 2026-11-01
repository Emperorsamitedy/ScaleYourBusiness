// The words of /benchmarks (idea 44), pure: the head, the source foot, and
// each line's sentence. Plain, first person where SYB speaks, and never a
// judgement (ux-spec §10): a figure is above, below or about the same, and
// nothing here says what to do about it.

import type { AppLocale } from "../../lib/i18n/locales";
import { dayMonthYear } from "../../lib/i18n/format";
import type { BenchLine, BenchResult, ComparedLine } from "../../lib/benchmarks/compare";
import type { BenchSource } from "../../lib/benchmarks/snapshot";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-30" → "30 Sep 2026"; in another language, its own (L-1). */
export function dateWords(iso: string, locale: AppLocale = "en"): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  if (locale !== "en") return dayMonthYear(iso, locale);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The page head: the cell in words, or what stops the comparison. */
export function headline(r: BenchResult): string {
  switch (r.status) {
    case "ready":
      return `Compared with ${r.head.group} ${r.head.size_words} in ${r.head.country}.`;
    case "no_type":
      return "I don't know what kind of business this is yet.";
    case "unmapped":
      return "There's no Eurostat comparison for this kind of business.";
    case "no_country":
      return "I don't know which country the business is in.";
    case "outside_eu":
      return `Eurostat doesn't cover ${r.country}.`;
  }
}

/** The source foot, always printed. */
export function footLine(s: BenchSource, caveat: string): string {
  return `Source: Eurostat, ${s.dataset} (${s.doi.replace(/^https:\/\//, "")}), updated ${dateWords(s.updated)}, retrieved ${dateWords(s.retrieved)}, reused with the source acknowledged. I keep each group's latest year and convert euros to your currency; Eurostat isn't responsible for that. ${caveat}`;
}

/** "Yours is 36.4%, theirs 1.2%: 35.2 points above." */
export function lineSentence(l: ComparedLine): string {
  return `Yours is ${l.own_words}, theirs ${l.bench_words}: ${l.gap_words}.`;
}

/** The boxed reading word, in caps: ABOVE, BELOW, ABOUT THE SAME. */
export function readingWord(l: BenchLine): string {
  if (l.status === "compared") return l.reading.toUpperCase();
  return l.status === "missing" ? "NOT YET" : "NO COMPARISON";
}

/** How many lines could be compared, for the aside. */
export function comparedCount(r: BenchResult): string {
  if (r.status !== "ready") return "Nothing compared";
  const n = r.lines.filter((l) => l.status === "compared").length;
  return `${n} of ${r.lines.length} compared`;
}

/** Why the size is what it is, when it isn't the owner's headcount. */
export function sizeNote(r: BenchResult): string | null {
  if (r.status !== "ready") return null;
  if (r.head.size_via === "none") {
    return "I don't know how many people work in the business, so the group is every size.";
  }
  if (r.head.size_via === "size_band" && r.head.size === "TOTAL") {
    return "Your size spans two of Eurostat's size groups, so the group is every size.";
  }
  return null;
}
