// The /reviews screen's words — idea 45 (I-45.4). Pure: the headline, the
// stars in words, the month's count, the setup steps.
//
// L-3b (TASKS-LANGUAGES.md): the words are the "reviews" catalogue through
// an optional translator, English by default from messages/en.json, so
// English says exactly what it always said; dates and counts in the
// reader's locale. A review's own words are content, shown as written.

import { dayMonth, dayMonthYear } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type { ReviewItem, ReviewsView } from "../../lib/review-desk/view";
import type { Tone } from "../charts/Viz";
import { num } from "../sheet/num";

const EN = (): Tr => englishTr("reviews");

/** A review of this many stars or fewer is worth knowing. */
export const POOR_STARS = 3;
/** The top of the star scale. */
export const MAX_STARS = 5;

/** Stars as words: "2 of 5". */
export function starsWords(stars: number | null, tr: Tr = EN(), locale: AppLocale = "en"): string {
  return stars === null
    ? tr("stars.none")
    : tr("stars.of", { stars: num(stars, 0, locale), max: num(MAX_STARS, 0, locale) });
}

/** One rating's row in the star spread; `key` is what the list is filtered by. */
export interface StarCount {
  key: string;
  stars: number | null;
  count: number;
}

/** A rating as a filter key: "5" … "1", or "none" for a review with no rating. */
export function starKey(stars: number | null): string {
  return stars === null ? "none" : String(stars);
}

/** How many of the listed reviews gave each rating, 5 down to 1; unrated ones last, only when there are any. */
export function starSpread(items: readonly Pick<ReviewItem, "stars">[]): StarCount[] {
  const count = (stars: number | null) => items.filter((r) => r.stars === stars).length;
  const rows: StarCount[] = Array.from({ length: MAX_STARS }, (_, i) => MAX_STARS - i).map(
    (stars) => ({ key: starKey(stars), stars, count: count(stars) }),
  );
  const unrated = count(null);
  return unrated > 0 ? [...rows, { key: starKey(null), stars: null, count: unrated }] : rows;
}

/** A rating's mark in the spread (app/viz.css): good filled --ok, poor hollow --alarm. */
export function starTone(stars: number | null): Tone {
  if (stars === null) return "hollow";
  if (stars > POOR_STARS) return "ok";
  return stars === POOR_STARS ? "soft" : "alarm";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "27 Oct", with the year when it isn't this year's. */
export function dayLabel(iso: string, today: string, locale: AppLocale = "en"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const year = d.getUTCFullYear();
  const thisYear = String(year) === today.slice(0, 4);
  if (locale !== "en") {
    const day = d.toISOString().slice(0, 10);
    return thisYear ? dayMonth(day, locale) : dayMonthYear(day, locale);
  }
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${thisYear ? "" : ` ${year}`}`;
}

/** This calendar month's reviews (by the review's own date, UTC). */
export function thisMonth(items: readonly ReviewItem[], today: string): ReviewItem[] {
  const month = today.slice(0, 7);
  return items.filter((r) => r.reviewed_at.slice(0, 7) === month);
}

/** The month's name on its own ("October", "октябрь"), or "this month" when today isn't a date. */
export function monthName(today: string, tr: Tr = EN(), locale: AppLocale = "en"): string {
  const m = Number(today.slice(5, 7));
  if (locale !== "en" && m >= 1 && m <= 12) {
    return new Intl.DateTimeFormat(intlTag(locale), { month: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(2000, m - 1, 1)),
    );
  }
  return MONTHS_LONG[m - 1] ?? tr("thisMonth");
}

/** The head: the month's main fact. */
export function reviewsHeadline(
  view: Pick<ReviewsView, "reviews" | "today">,
  tr: Tr = EN(),
): string {
  const month = thisMonth(view.reviews, view.today);
  if (view.reviews.length === 0) return tr("headline.none");
  if (month.length === 0) return tr("headline.noneThisMonth");
  const poor = month.filter((r) => r.stars !== null && r.stars <= POOR_STARS).length;
  if (poor === 0) {
    return month.length === 1
      ? tr("headline.oneFine", { stars: POOR_STARS })
      : tr("headline.noneFine", { count: month.length, stars: POOR_STARS });
  }
  return tr("headline.poor", { poor, stars: POOR_STARS, total: month.length });
}

/** The aside: every review on file, and how long they're kept. */
export function asideLine(
  view: Pick<ReviewsView, "reviews" | "retention_days">,
  tr: Tr = EN(),
): string {
  return tr("aside", { count: view.reviews.length, days: view.retention_days });
}

/** Why a review shows as it does, when it isn't plain. */
export function readNote(r: Pick<ReviewItem, "read_by" | "source">, tr: Tr = EN()): string | null {
  if (r.read_by === "unread") return tr("readNote.unread");
  if (r.read_by === "model") return tr("readNote.model");
  if (r.source === "paste") return tr("readNote.paste");
  if (r.source === "google") return tr("google.readNote");
  return null;
}

/**
 * Review 2026-10-30: Gmail's forwarding confirmation, said plainly. Null
 * when none came.
 */
export function gmailConfirmationLine(
  gmail: { code: string | null; link: string | null } | null,
  tr: Tr = EN(),
): string | null {
  if (!gmail) return null;
  if (gmail.code) return tr("gmail.code", { code: gmail.code });
  return tr("gmail.link");
}

/** The setup steps' keys, per platform with an email to forward. */
const STEP_KEYS: readonly { platform: string; key: string; steps: readonly string[] }[] = [
  { platform: "Google", key: "google", steps: ["notifications", "gmail", "rule", "byHand"] },
  { platform: "Trustpilot", key: "trustpilot", steps: ["notifications", "forward"] },
];

/** Plain setup steps, per platform with an email to forward. */
export function setupSteps(tr: Tr = EN()): { platform: string; steps: string[] }[] {
  return STEP_KEYS.map((p) => ({
    platform: p.platform,
    steps: p.steps.map((s) => tr(`setup.${p.key}.${s}`)),
  }));
}

/** The English steps, as the screen has always listed them. */
export const SETUP_STEPS: readonly { platform: string; steps: string[] }[] = setupSteps();

/** The Google card's fixed lines (I-45a), in the reader's language. */
export const GOOGLE_NEED_KEYS = ["approval", "signIn", "location"] as const;
