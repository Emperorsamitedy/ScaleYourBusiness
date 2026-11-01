// The same Google review, arriving two ways — I-45a.
//
// A Google review can reach SYB by the owner's forwarded notification email
// (I-45.1) and by reading the owner's Business Profile (I-45a). The two
// don't share a key: the email's link may be the whole listing, its date is
// when the email came, and Google's API gives no review link at all. So a
// review from one way is checked against the other way's reviews before it
// is filed: same stars, dates within TWIN_WINDOW_DAYS, and the same words
// (a notification may cut a long review short, so a long enough start
// counts). A review with no words matches only on the same reviewer's first
// name. Without stars on both sides, nothing is called a twin: two
// different reviews are worse folded into one than kept apart.
//
// Pure apart from twinOf's one bounded read. Stranger-reachable (the inbound
// path files through store.ts): lib/reviews and the database only.

import { and, eq, gte, lte, ne } from "drizzle-orm";
import type { db } from "../../db";
import { reviews } from "../../db/schema";

export const TWIN_WINDOW_DAYS = 7;
/** The shortest start of a review's words that may stand for the whole of it. */
export const TWIN_MIN_PREFIX = 30;
/** The most rows looked at for one review. */
const TWIN_CANDIDATES = 50;
const DAY_MS = 86_400_000;

export interface TwinShape {
  stars: number | null;
  text: string | null;
  reviewer: string | null;
  reviewed_at: string;
}

function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/(\s*(…|\.\.\.|read more|more))+$/u, "")
    .trim();
}

function firstName(reviewer: string | null): string | null {
  if (reviewer === null) return null;
  const first = reviewer.normalize("NFKC").trim().split(/\s+/)[0] ?? "";
  const letters = first.replace(/[^\p{L}]/gu, "").toLowerCase();
  return letters === "" ? null : letters;
}

/** Pure: is `a` the same review as `b`, read another way? */
export function isTwin(a: TwinShape, b: TwinShape): boolean {
  if (a.stars === null || b.stars === null || a.stars !== b.stars) return false;
  const apart = Math.abs(Date.parse(a.reviewed_at) - Date.parse(b.reviewed_at));
  if (!(apart <= TWIN_WINDOW_DAYS * DAY_MS)) return false;
  const ta = a.text === null ? "" : normalise(a.text);
  const tb = b.text === null ? "" : normalise(b.text);
  if (ta !== "" || tb !== "") {
    if (ta === "" || tb === "") return false;
    if (ta === tb) return true;
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    return short.length >= TWIN_MIN_PREFIX && long.startsWith(short);
  }
  const na = firstName(a.reviewer);
  return na !== null && na === firstName(b.reviewer);
}

type Executor = Pick<typeof db, "select">;

/**
 * The review already on file that `r` is a twin of, read the OTHER way, or
 * null. Only Google reviews have two ways in, so any other platform is null.
 */
export async function twinOf(
  executor: Executor,
  r: TwinShape & { profile_id: string; platform: string; source: string },
): Promise<string | null> {
  if (r.platform !== "google" || r.stars === null) return null;
  const at = Date.parse(r.reviewed_at);
  if (Number.isNaN(at)) return null;
  const rows = await executor
    .select({
      id: reviews.id,
      stars: reviews.stars,
      text: reviews.text,
      reviewer: reviews.reviewer,
      reviewed_at: reviews.reviewed_at,
    })
    .from(reviews)
    .where(
      and(
        eq(reviews.profile_id, r.profile_id),
        eq(reviews.platform, "google"),
        r.source === "google" ? ne(reviews.source, "google") : eq(reviews.source, "google"),
        eq(reviews.stars, r.stars),
        gte(reviews.reviewed_at, new Date(at - TWIN_WINDOW_DAYS * DAY_MS).toISOString()),
        lte(reviews.reviewed_at, new Date(at + TWIN_WINDOW_DAYS * DAY_MS).toISOString()),
      ),
    )
    .limit(TWIN_CANDIDATES);
  return rows.find((row) => isTwin(r, row))?.id ?? null;
}
