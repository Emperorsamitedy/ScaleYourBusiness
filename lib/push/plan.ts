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

import type { PushPayload } from "./send";

export const QUIET_FROM_HOUR = 21;
export const QUIET_UNTIL_HOUR = 8;
export const PUSH_TITLE = "SYB";
export const PUSH_TAG = "syb-waiting";

/** Kind → the few words a lock screen may show. Fixed text only. */
const KIND_WORDS: Record<string, string> = {
  price_increase: "a price change",
  price_decrease: "a price change",
  discount_or_promotion: "a promotion",
  paid_ads_start_or_increase: "an ad",
  paid_ads_decrease_or_pause: "an ad change",
  content_publishing: "a post",
  cold_outreach: "an outreach message",
  channel_expansion: "a new channel",
  offer_change: "a change to an offer",
  operations_change: "a change to how you run things",
  support_knowledge: "a support answer",
  customer_email: "an email to customers",
  deal_followup: "a follow-up",
  stock_reorder_note: "a reorder note",
  media_generation: "an image or clip to make",
  revise_goal: "a goal to look at",
  stop_strategy: "a strategy to look at",
};

/** The phrase for one proposal: by its kind, never its own text. */
export function kindWords(kind: string | null | undefined): string {
  return (kind && KIND_WORDS[kind]) || "a proposal";
}

export interface QueuedItem {
  proposal_id: string;
  status: string;
  kind: string | null;
  expires_at: string;
}

export interface PushPlanInput {
  now: Date;
  /** The IANA zone quiet hours are kept in. */
  zone: string;
  halted: boolean;
  devices: number;
  /** The account's last alert (tests don't count). */
  lastSentAt: string | null;
  queued: readonly QueuedItem[];
}

export type PushPlan =
  | { act: "send"; send: string[]; drop: string[]; payload: PushPayload }
  | {
      act: "hold";
      why: "quiet_hours" | "daily_cap";
      /** When the next try can send: 08:00 local. */
      until: string;
      keep: string[];
      drop: string[];
    }
  | { act: "drop"; why: "halted" | "no_devices" | "nothing_waiting"; drop: string[] };

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

/** The alert's words and where its tap goes. */
export function pushWords(waiting: readonly QueuedItem[]): PushPayload {
  const first = waiting[0];
  if (waiting.length === 1 && first) {
    return {
      title: PUSH_TITLE,
      body: `1 thing waits for your yes: ${kindWords(first.kind)}`,
      url: `/proposals/${first.proposal_id}`,
      tag: PUSH_TAG,
    };
  }
  return {
    title: PUSH_TITLE,
    body: `${waiting.length} things wait for your yes`,
    url: "/proposals",
    tag: PUSH_TAG,
  };
}

export function pushPlan(input: PushPlanInput): PushPlan {
  const nowIso = input.now.toISOString();
  const waiting = input.queued.filter((q) => q.status === "pending" && q.expires_at > nowIso);
  const stale = input.queued.filter((q) => !waiting.includes(q)).map((q) => q.proposal_id);
  const all = input.queued.map((q) => q.proposal_id);

  if (input.halted) return { act: "drop", why: "halted", drop: all };
  if (input.devices === 0) return { act: "drop", why: "no_devices", drop: all };
  if (waiting.length === 0) return { act: "drop", why: "nothing_waiting", drop: all };

  const keep = waiting.map((q) => q.proposal_id);
  if (inQuietHours(input.now, input.zone)) {
    return {
      act: "hold",
      why: "quiet_hours",
      until: nextMorning(input.now, input.zone).toISOString(),
      keep,
      drop: stale,
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
    };
  }
  return { act: "send", send: keep, drop: stale, payload: pushWords(waiting) };
}
