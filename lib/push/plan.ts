// When a phone alert goes, and what it says — idea 53 (I-53.4). Pure: the
// clock, the zone, the stop and the queue go in; a decision comes out.
// lib/push/flush.ts reads the database and carries the decision out.
//
// The rules, in the order they apply:
//   1. Only proposals still pending and in their window are worth an alert.
//      Blocked, decided and expired ones are dropped, never sent.
//   2. While the emergency stop is on, nothing goes, and what was queued is
//      dropped rather than held: lifting the stop doesn't bring a burst.
//   3. No device, nothing to send to: dropped, so a phone switched on later
//      doesn't get yesterday's alert.
//   4. Quiet hours: nothing from 21:00 until 08:00 in the business's
//      timezone. Held until 08:00.
//   5. At most one alert a day per account (ux-spec §9, "Hard-capped at one
//      push per day; further items batch into the same thread"): a second
//      one the same local day is held until the next 08:00. The plan said
//      one an hour; the spec is stricter and wins (TASKS-FEEDBACK I-53.4).
//   6. Otherwise everything waiting goes as ONE alert: "1 thing waits for
//      your yes: a price change", or "3 things wait for your yes".
//
// The lock screen is public, so the words never carry a figure, a name or
// a contact detail. They aren't the proposal's title (which can hold all
// three: "Win back Anna Kovács with 10% off"), but a fixed phrase per
// proposal kind from the table below. Unknown kinds say "a proposal".
//
// I-45d (decided 2026-11-04, owner: "Yes, within quiet hours"): a review
// worth knowing (lib/reviews/alert) rides the same rules. Its alert is
// planned here, on the trusted side, never from the inbound path (rule 21):
// the review's own row says it is waiting (reviews.push_settled_at null).
// Rules 2–5 apply to it unchanged, and it shares the one alert a day: when
// proposals and reviews both wait they go as one alert ("1 thing waits for
// your yes, and a review worth knowing"). A review's words are fixed too
// ("A 2-star review on Google"): no reviewer, no words, no link. A pasted
// review raises no phone alert (the owner just pasted it), and one waiting
// more than REVIEW_PUSH_FRESH_DAYS is dropped rather than sent late.
//
// Warnings sent at once (2026-11-20; Vistta: an alert must look ahead, "not
// giving notification about stuff that he can walk into the stock room and
// see"): the cash forecast's first tight week and an item that runs out
// before its next delivery reached only the app and the Monday summary. Each
// is a line the watch already writes once (lib/watch/job, lib/stock/warnings);
// its row in warning_alerts waits for a phone alert, which rides the same
// rules and shares the one alert a day: with proposals or reviews it is one
// more sentence on their alert, alone it taps through to its own screen. Its
// words are fixed like the others ("Your cash could get tight in the weeks
// ahead"): no figure, no item's name. One waiting more than
// WARNING_PUSH_FRESH_DAYS is dropped rather than sent late. Whether a
// warning may go past the daily cap is the owner's to decide; until then it
// does not.

import type { Words } from "../i18n/recipient";
import { englishWords } from "../i18n/recipient";
import type { ReviewPlatformKey } from "../reviews/parse";
import { PLATFORM_LABELS, isPlatformKey } from "../reviews/parse";
import type { PushPayload } from "./send";

export const QUIET_FROM_HOUR = 21;
export const QUIET_UNTIL_HOUR = 8;
export const PUSH_TITLE = "ScaleX";
export const PUSH_TAG = "syb-waiting";

/**
 * The kinds with a phrase of their own — the few words a lock screen may
 * show, fixed text only, in messages/<locale>.json under `push.kinds`
 * (L-6: in the person's language; English by default).
 */
const KINDS: ReadonlySet<string> = new Set([
  "price_increase",
  "price_decrease",
  "discount_or_promotion",
  "paid_ads_start_or_increase",
  "paid_ads_decrease_or_pause",
  "content_publishing",
  "cold_outreach",
  "channel_expansion",
  "offer_change",
  "operations_change",
  "support_knowledge",
  "customer_email",
  "deal_followup",
  "stock_reorder_note",
  "purchase_order",
  "prepared_payment",
  "media_generation",
  "revise_goal",
  "stop_strategy",
]);

const ENGLISH = (): Words => englishWords("push");

/** The phrase for one proposal: by its kind, never its own text. */
export function kindWords(kind: string | null | undefined, w: Words = ENGLISH()): string {
  return w.t(`kinds.${kind && KINDS.has(kind) ? kind : "other"}`);
}

export interface QueuedItem {
  proposal_id: string;
  status: string;
  kind: string | null;
  expires_at: string;
}

/** I-45d: a review alert waiting for its phone alert. */
export interface QueuedReview {
  review_id: string;
  platform: string;
  stars: number | null;
  /** How it reached SYB: "email", "google" or "paste". */
  source: string;
  alerted_at: string;
}

/** A review alert older than this is dropped, not sent late. */
export const REVIEW_PUSH_FRESH_DAYS = 2;

/** The warnings that raise a phone alert: the watch log's own kinds. */
export const WARNING_KINDS = ["cash_warning", "stock_warning"] as const;
export type WarningKind = (typeof WARNING_KINDS)[number];

export function isWarningKind(v: unknown): v is WarningKind {
  return typeof v === "string" && (WARNING_KINDS as readonly string[]).includes(v);
}

/** The screen a warning's own alert opens. */
export const WARNING_SCREEN: Readonly<Record<WarningKind, string>> = {
  cash_warning: "/cash",
  stock_warning: "/stock",
};

/** A warning waiting for its phone alert (a warning_alerts row). */
export interface QueuedWarning {
  alert_id: string;
  kind: string;
  created_at: string;
}

/** A warning older than this is dropped, not sent late: it spoke of the days just ahead. */
export const WARNING_PUSH_FRESH_DAYS = 2;

export interface PushPlanInput {
  now: Date;
  /** The IANA zone quiet hours are kept in. */
  zone: string;
  halted: boolean;
  devices: number;
  /** The account's last alert (tests don't count). */
  lastSentAt: string | null;
  queued: readonly QueuedItem[];
  /** I-45d: review alerts not yet sent or dropped. */
  reviews?: readonly QueuedReview[];
  /** Warnings not yet sent or dropped. */
  warnings?: readonly QueuedWarning[];
}

/**
 * On every plan when reviews or warnings were given: the ids now settled
 * (sent or dropped). What a hold keeps waiting is not among them.
 */
interface ReviewsSettled {
  reviews_done?: string[];
  warnings_done?: string[];
}

export type PushPlan = ReviewsSettled &
  (
    | {
        act: "send";
        send: string[];
        drop: string[];
        /** The alert in English; each device gets it in its person's words (./flush, from `waiting`). */
        payload: PushPayload;
        waiting: QueuedItem[];
        /** I-45d: the review alerts it carries. */
        reviews?: QueuedReview[];
        /** The warnings it carries. */
        warnings?: QueuedWarning[];
      }
    | {
        act: "hold";
        why: "quiet_hours" | "daily_cap";
        /** When the next try can send: 08:00 local. */
        until: string;
        keep: string[];
        drop: string[];
      }
    | { act: "drop"; why: "halted" | "no_devices" | "nothing_waiting"; drop: string[] }
  );

/** Wall-clock parts of an instant in a zone. */
export function localParts(at: Date, zone: string): { date: string; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** The instant a zone's clock reads `hour`:00 on `date`. 08:00 always exists (DST moves 02:00–03:00). */
function zonedInstant(date: string, hour: number, zone: string): Date {
  const base = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  for (let offset = -14; offset <= 14; offset++) {
    const at = new Date(base - offset * 3_600_000);
    const p = localParts(at, zone);
    if (p.date === date && p.hour === hour) return at;
  }
  return new Date(base);
}

function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The next 08:00 in the zone, strictly after `now`'s local day has reached it. */
export function nextMorning(now: Date, zone: string): Date {
  const { date, hour } = localParts(now, zone);
  return zonedInstant(hour < QUIET_UNTIL_HOUR ? date : nextDay(date), QUIET_UNTIL_HOUR, zone);
}

export function inQuietHours(now: Date, zone: string): boolean {
  const { hour } = localParts(now, zone);
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

const REVIEW_ENGLISH = (): Words => englishWords("reviewPush");

/** I-45d: one review's lock-screen phrase — the platform and the stars, nothing else. */
export function reviewWords(r: QueuedReview, rw: Words = REVIEW_ENGLISH()): string {
  const key: ReviewPlatformKey = isPlatformKey(r.platform) ? r.platform : "other";
  const platform = key === "other" ? rw.t("anotherSite") : PLATFORM_LABELS[key];
  return r.stars === null
    ? rw.t("oneUnrated", { platform })
    : rw.t("one", { stars: r.stars, platform });
}

const WARNING_ENGLISH = (): Words => englishWords("warningPush");

/**
 * Warnings alone on an alert: one says what it is about, in fixed words;
 * several are counted. The tap goes to the warning's own screen, or Home
 * when they are of more than one kind.
 */
function warningPayload(warnings: readonly QueuedWarning[], ww: Words): PushPayload {
  const kinds = [...new Set(warnings.map((x) => x.kind).filter(isWarningKind))];
  const only = kinds.length === 1 ? kinds[0] : undefined;
  return {
    title: PUSH_TITLE,
    body:
      warnings.length === 1 && only
        ? ww.t(`one.${only}`)
        : ww.t("many", { count: warnings.length }),
    url: only ? WARNING_SCREEN[only] : "/home",
    tag: PUSH_TAG,
  };
}

/**
 * The alert's words and where its tap goes, in the person's words (English
 * by default). I-45d: review alerts alone tap through to /reviews; with
 * proposals they ride the proposals' alert, which taps through to the yes.
 * Warnings alone have their own words and screen; with anything else they
 * are one more sentence on that alert, which still taps where it did.
 */
export function pushWords(
  waiting: readonly QueuedItem[],
  w: Words = ENGLISH(),
  reviews: readonly QueuedReview[] = [],
  rw: Words = REVIEW_ENGLISH(),
  warnings: readonly QueuedWarning[] = [],
  ww: Words = WARNING_ENGLISH(),
): PushPayload {
  if (warnings.length > 0) {
    if (waiting.length === 0 && reviews.length === 0) return warningPayload(warnings, ww);
    const rest = pushWords(waiting, w, reviews, rw);
    return { ...rest, body: `${rest.body}${ww.t("also", { count: warnings.length })}` };
  }
  if (reviews.length > 0) {
    const only = reviews[0];
    if (waiting.length === 0) {
      return {
        title: PUSH_TITLE,
        body:
          reviews.length === 1 && only
            ? reviewWords(only, rw)
            : rw.t("many", { count: reviews.length }),
        url: "/reviews",
        tag: PUSH_TAG,
      };
    }
    return {
      title: PUSH_TITLE,
      body: rw.t("withProposals", { count: waiting.length, reviews: reviews.length }),
      url: "/proposals",
      tag: PUSH_TAG,
    };
  }
  const first = waiting[0];
  if (waiting.length === 1 && first) {
    return {
      title: PUSH_TITLE,
      body: w.t("one", { count: 1, what: kindWords(first.kind, w) }),
      url: `/proposals/${first.proposal_id}`,
      tag: PUSH_TAG,
    };
  }
  return {
    title: PUSH_TITLE,
    body: w.t("many", { count: waiting.length }),
    url: "/proposals",
    tag: PUSH_TAG,
  };
}

export function pushPlan(input: PushPlanInput): PushPlan {
  // Review 2026-10-30: compared as instants. A Postgres timestamptz string
  // ("2026-10-29 19:41:55+00") sorts before any ISO string of the same UTC
  // day ("2026-10-29T…Z"), so a string compare called live proposals stale.
  const nowMs = input.now.getTime();
  const waiting = input.queued.filter(
    (q) => q.status === "pending" && Date.parse(q.expires_at) > nowMs,
  );
  const stale = input.queued.filter((q) => !waiting.includes(q)).map((q) => q.proposal_id);
  const all = input.queued.map((q) => q.proposal_id);

  // I-45d: the review alerts worth a phone alert, and what settles each plan.
  const given = input.reviews ?? [];
  const freshFrom = nowMs - REVIEW_PUSH_FRESH_DAYS * 86_400_000;
  const reviews = given.filter((r) => r.source !== "paste" && Date.parse(r.alerted_at) > freshFrom);
  // Warnings: the fresh ones of a kind that raises an alert, and what settles each plan.
  const warned = input.warnings ?? [];
  const warnFrom = nowMs - WARNING_PUSH_FRESH_DAYS * 86_400_000;
  const warnings = warned.filter(
    (x) => isWarningKind(x.kind) && Date.parse(x.created_at) > warnFrom,
  );
  const settledAll = (
    revs: readonly QueuedReview[],
    warns: readonly QueuedWarning[],
  ): ReviewsSettled => ({
    ...(given.length === 0 ? {} : { reviews_done: revs.map((r) => r.review_id) }),
    ...(warned.length === 0 ? {} : { warnings_done: warns.map((x) => x.alert_id) }),
  });
  const everything = settledAll(given, warned);
  const staleReviews = settledAll(
    given.filter((r) => !reviews.includes(r)),
    warned.filter((x) => !warnings.includes(x)),
  );

  if (input.halted) return { act: "drop", why: "halted", drop: all, ...everything };
  if (input.devices === 0) return { act: "drop", why: "no_devices", drop: all, ...everything };
  if (waiting.length === 0 && reviews.length === 0 && warnings.length === 0) {
    return { act: "drop", why: "nothing_waiting", drop: all, ...everything };
  }

  const keep = waiting.map((q) => q.proposal_id);
  if (inQuietHours(input.now, input.zone)) {
    return {
      act: "hold",
      why: "quiet_hours",
      until: nextMorning(input.now, input.zone).toISOString(),
      keep,
      drop: stale,
      ...staleReviews,
    };
  }
  if (
    input.lastSentAt !== null &&
    localParts(new Date(input.lastSentAt), input.zone).date ===
      localParts(input.now, input.zone).date
  ) {
    return {
      act: "hold",
      why: "daily_cap",
      until: nextMorning(input.now, input.zone).toISOString(),
      keep,
      drop: stale,
      ...staleReviews,
    };
  }
  return {
    act: "send",
    send: keep,
    drop: stale,
    payload: pushWords(waiting, ENGLISH(), reviews, REVIEW_ENGLISH(), warnings),
    waiting,
    ...(given.length === 0 ? {} : { reviews }),
    ...(warned.length === 0 ? {} : { warnings }),
    ...everything,
  };
}
