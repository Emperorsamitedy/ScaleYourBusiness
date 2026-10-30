// The /reviews screen's words — idea 45 (I-45.4). Pure: the headline, the
// stars in words, the month's count, the setup steps.

import type { ReviewItem, ReviewsView } from "../../lib/review-desk/view";

/** Stars as words: "2 of 5". */
export function starsWords(stars: number | null): string {
  return stars === null ? "No rating" : `${stars} of 5`;
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
export function dayLabel(iso: string, today: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const year = d.getUTCFullYear();
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${String(year) === today.slice(0, 4) ? "" : ` ${year}`}`;
}

/** This calendar month's reviews (by the review's own date, UTC). */
export function thisMonth(items: readonly ReviewItem[], today: string): ReviewItem[] {
  const month = today.slice(0, 7);
  return items.filter((r) => r.reviewed_at.slice(0, 7) === month);
}

export function monthName(today: string): string {
  return MONTHS_LONG[Number(today.slice(5, 7)) - 1] ?? "this month";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The head: the month's main fact. */
export function reviewsHeadline(view: Pick<ReviewsView, "reviews" | "today">): string {
  const month = thisMonth(view.reviews, view.today);
  if (view.reviews.length === 0) return "No reviews here yet.";
  if (month.length === 0) return "No new reviews this month.";
  const poor = month.filter((r) => r.stars !== null && r.stars <= 3).length;
  if (poor === 0) {
    return month.length === 1
      ? "This month's one review isn't 3 stars or fewer."
      : `None of this month's ${month.length} reviews is 3 stars or fewer.`;
  }
  return `${plural(poor, "review", "reviews")} of 3 stars or fewer this month, of ${month.length}.`;
}

/** The aside: every review on file, and how long they're kept. */
export function asideLine(view: Pick<ReviewsView, "reviews" | "retention_days">): string {
  return `${plural(view.reviews.length, "review", "reviews")} on file · kept ${view.retention_days} days`;
}

/** Why a review shows as it does, when it isn't plain. */
export function readNote(r: Pick<ReviewItem, "read_by" | "source">): string | null {
  if (r.read_by === "unread") {
    return "I couldn't read this notification, so I kept only where and when. Open it where it lives.";
  }
  if (r.read_by === "model") return "Read by my fallback reader: check it against the original.";
  if (r.source === "paste") return "You pasted this one.";
  return null;
}

/**
 * Review 2026-10-30: Gmail's forwarding confirmation, said plainly. Null
 * when none came.
 */
export function gmailConfirmationLine(
  gmail: { code: string | null; link: string | null } | null,
): string | null {
  if (!gmail) return null;
  if (gmail.code) {
    return `Gmail sent a confirmation code: ${gmail.code}. Enter it in Gmail's forwarding settings.`;
  }
  return "Gmail sent a confirmation link: open it to switch on the forwarding.";
}

/** Plain setup steps, per platform with an email to forward. */
export const SETUP_STEPS: readonly { platform: string; steps: string[] }[] = [
  {
    platform: "Google",
    steps: [
      "In your Business Profile, open Notifications (or Settings) and switch on emails for customer reviews.",
      "If those emails reach Gmail, first add the address above in Gmail's Settings, under Forwarding and POP/IMAP, Add a forwarding address. Gmail sends a confirmation code to it: the code shows up on this page, and you enter it in Gmail to finish.",
      "Then, in the mailbox those emails reach, make a rule: mail from Google about a review is forwarded to the address above.",
      "Or forward any review email to it by hand. Either way works.",
    ],
  },
  {
    platform: "Trustpilot",
    steps: [
      "In Trustpilot Business, turn on email notifications for new reviews.",
      "Forward those emails to the address above, by a rule in your mailbox or by hand.",
    ],
  },
];
