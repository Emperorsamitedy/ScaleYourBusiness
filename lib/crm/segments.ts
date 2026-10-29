// Segmentation and lifecycle — Phase 4 Session E (P4-13).
//
// Arithmetic, not inference: a contact's lifecycle state is a function
// of dates and counts the owner imported from their shop, with the
// thresholds pinned below and boundary-tested in both directions. No
// model is anywhere near this file (TASKS-PHASE4 cost discipline:
// "segments and lifecycle are arithmetic").
//
// What "measured" means here, honestly: Phase 2's observations are
// business-wide (revenue per day), never per customer, so the per-
// contact history comes from the shop's own customer export (P4-03 +
// the purchase columns of P4-13). A contact with no date at all is
// "unknown" — a state, not a guess.
//
// A segment is a deterministic filter with its arithmetic written out
// as evidence, and it separates WHO IS IN IT from WHO MAY BE EMAILED:
// the consent gate (rule 19) decides the second, per contact, every time.

import type { ContactRow } from "./contacts";
import { canEmailForMarketing, listContacts } from "./contacts";

/** The thresholds, in days — pinned here, tested at their boundaries. */
export const LIFECYCLE = {
  /** Only purchase (or activity) within this many days, with at most one order: new. */
  new_days: 30,
  /** Last purchase (or activity) within this many days: active. */
  active_days: 90,
  /** Beyond active and within this: lapsing. Beyond this: lapsed. */
  lapsing_days: 180,
} as const;

/** VIP: this many orders, OR total spend in the top tenth of contacts with spend in the same currency. */
export const VIP = { min_orders: 3, top_spend_fraction: 0.1, min_population: 10 } as const;

export type Lifecycle = "new" | "active" | "lapsing" | "lapsed" | "unknown";

const DAY_MS = 86_400_000;

export function daysBetween(fromIso: string, now: Date): number {
  return (now.getTime() - Date.parse(fromIso)) / DAY_MS;
}

/** The date lifecycle counts from: a purchase if the shop exported one, else the last activity. */
export function referenceDate(
  contact: Pick<ContactRow, "last_purchase_at" | "last_activity_at">,
): string | null {
  return contact.last_purchase_at ?? contact.last_activity_at ?? null;
}

// "New" counts from the purchase date, not from when the row was imported:
// a shop export brings years of customers in on one afternoon, and the
// import date says nothing about how new any of them is to the business.
export function lifecycleOf(
  contact: Pick<ContactRow, "last_purchase_at" | "last_activity_at" | "orders_count">,
  now: Date,
): Lifecycle {
  const ref = referenceDate(contact);
  if (ref === null) return "unknown";
  const since = daysBetween(ref, now);
  if (since <= LIFECYCLE.new_days && (contact.orders_count ?? 0) <= 1) return "new";
  if (since <= LIFECYCLE.active_days) return "active";
  if (since <= LIFECYCLE.lapsing_days) return "lapsing";
  return "lapsed";
}

/** "abandoned_cart" (idea 47) is computed from stored carts by lib/carts/segment.ts, not here. */
export type SegmentKey = "lapsed" | "lapsing" | "new" | "vip" | "abandoned_cart";

export interface Segment {
  key: SegmentKey;
  label: string;
  /** Everyone the filter matches. */
  contact_ids: string[];
  /** The subset the consent gate lets through for marketing email, decided per contact. */
  emailable_ids: string[];
  excluded: { no_email: number; no_consent: number; suppressed: number };
  /** The arithmetic, in words a card can show. */
  evidence: string[];
}

export interface SegmentReport {
  computed_at: string;
  contacts: number;
  lifecycle: Record<Lifecycle, number>;
  segments: Segment[];
}

/** The spend floor for VIP by top fraction, per currency; null where the population is too small to rank. */
export function vipSpendFloors(contacts: readonly ContactRow[]): Map<string, number> {
  const byCurrency = new Map<string, number[]>();
  for (const c of contacts) {
    if (c.total_spent_minor === null || c.spent_currency === null) continue;
    byCurrency.set(c.spent_currency, [
      ...(byCurrency.get(c.spent_currency) ?? []),
      c.total_spent_minor,
    ]);
  }
  const floors = new Map<string, number>();
  for (const [currency, amounts] of byCurrency) {
    if (amounts.length < VIP.min_population) continue;
    const sorted = [...amounts].sort((a, b) => b - a);
    const topCount = Math.max(1, Math.floor(sorted.length * VIP.top_spend_fraction));
    floors.set(currency, sorted[topCount - 1]!);
  }
  return floors;
}

export function isVip(contact: ContactRow, floors: ReadonlyMap<string, number>): boolean {
  if ((contact.orders_count ?? 0) >= VIP.min_orders) return true;
  if (contact.total_spent_minor === null || contact.spent_currency === null) return false;
  const floor = floors.get(contact.spent_currency);
  return floor !== undefined && contact.total_spent_minor >= floor;
}

async function gate(
  members: readonly ContactRow[],
): Promise<{ emailable_ids: string[]; excluded: Segment["excluded"] }> {
  const emailable_ids: string[] = [];
  const excluded = { no_email: 0, no_consent: 0, suppressed: 0 };
  for (const c of members) {
    const verdict = await canEmailForMarketing(c);
    if (verdict.allowed) {
      emailable_ids.push(c.id);
    } else if (verdict.reason.startsWith("no email")) {
      excluded.no_email++;
    } else if (verdict.reason.startsWith("suppressed")) {
      excluded.suppressed++;
    } else {
      excluded.no_consent++;
    }
  }
  return { emailable_ids, excluded };
}

/** Lifecycle counts and the four segments, with their arithmetic shown. */
export async function computeSegments(accountId: string, now = new Date()): Promise<SegmentReport> {
  const all = await listContacts(accountId);
  const lifecycle: Record<Lifecycle, number> = {
    new: 0,
    active: 0,
    lapsing: 0,
    lapsed: 0,
    unknown: 0,
  };
  const states = new Map<string, Lifecycle>();
  for (const c of all) {
    const state = lifecycleOf(c, now);
    states.set(c.id, state);
    lifecycle[state]++;
  }
  const floors = vipSpendFloors(all);

  const build = async (
    key: SegmentKey,
    label: string,
    members: ContactRow[],
    evidence: string[],
  ): Promise<Segment> => {
    const { emailable_ids, excluded } = await gate(members);
    return {
      key,
      label,
      contact_ids: members.map((c) => c.id),
      emailable_ids,
      excluded,
      evidence: [
        ...evidence,
        `${members.length} of ${all.length} contacts match; ${emailable_ids.length} hold explicit email consent and no suppression (rule 19), ${excluded.no_consent} lack consent, ${excluded.no_email} have no address, ${excluded.suppressed} are suppressed`,
      ],
    };
  };

  const byState = (state: Lifecycle) => all.filter((c) => states.get(c.id) === state);
  const vips = all.filter((c) => isVip(c, floors));
  const floorText =
    floors.size === 0
      ? `fewer than ${VIP.min_population} contacts carry a spend figure, so only the order count counts`
      : [...floors.entries()]
          .map(
            ([cur, f]) =>
              `top ${VIP.top_spend_fraction * 100}% of spend in ${cur} starts at ${f} minor units`,
          )
          .join("; ");

  return {
    computed_at: now.toISOString(),
    contacts: all.length,
    lifecycle,
    segments: [
      await build("lapsed", "Lapsed customers", byState("lapsed"), [
        `lapsed = last purchase (or activity) more than ${LIFECYCLE.lapsing_days} days before ${now.toISOString().slice(0, 10)}`,
      ]),
      await build("lapsing", "Lapsing customers", byState("lapsing"), [
        `lapsing = last purchase between ${LIFECYCLE.active_days} and ${LIFECYCLE.lapsing_days} days ago`,
      ]),
      await build("new", "New customers", byState("new"), [
        `new = first seen within ${LIFECYCLE.new_days} days with at most one order`,
      ]),
      await build("vip", "Best customers", vips, [
        `VIP = ${VIP.min_orders}+ orders, or ${floorText}`,
      ]),
    ],
  };
}
