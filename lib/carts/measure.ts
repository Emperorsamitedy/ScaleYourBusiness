// Abandoned carts, measured — idea 47. Pure: no database, no clock, no model.
//
// Over the last CARTS.window_days complete days (ending yesterday, UTC, the
// day grammar orders.daily uses) against the same span before:
//
//   started     checkouts Shopify reports as begun in the window
//   left        of those, the ones never finished (completed_at null)
//   share left  left ÷ (left + the orders the sync counted in the window):
//               a finished checkout is an order, so it is in the orders
//   value left  the left carts' totals, per currency, never added across
//   products    the store products in the most left carts, with units
//
// "Likely to win back" is a range from a named rule of thumb (WIN_BACK,
// ASSUMED), applied only to the carts whose shopper can actually be emailed
// (their own recorded consent, rule 19), never to the rest and never the
// owner's own number.
//
// Rule 25: under CARTS.min_days days of carts in the window, or under
// CARTS.min_carts carts left in it, nothing is measured. The refusal says
// how many there are and, where a date can be known, when it will be ready.
// The window before is compared only when it passes the same two tests.

import type { CartLine } from "../../db/schema";
import { shiftDay } from "../anomaly/baseline";

/** The pinned numbers, tested at their boundaries. */
export const CARTS = {
  /** Each sync reads the checkouts started in this many days (the window and the one before). */
  read_days: 60,
  /** Stored carts older than this are deleted. */
  retention_days: 90,
  window_days: 30,
  /** Rule 25: a window needs carts on this many of its days (from the first cart read)… */
  min_days: 14,
  /** …and this many carts left in it. */
  min_carts: 10,
  /** Products listed as left behind. */
  top_products: 5,
} as const;

/**
 * The rule of thumb behind "likely to win back". ASSUMED: a planning figure
 * from email practice, named as such on the screen, never measured on the
 * owner's shop and never the owner's own number. Applied to the value of the
 * carts whose shopper may be emailed, as a low–high range.
 */
export const WIN_BACK = {
  low: 0.03,
  high: 0.1,
  label: "ASSUMED",
  statement:
    "Rule of thumb, not your number: of the carts a reminder email reaches, about 3–10% come back as an order.",
} as const;

/** Why a cart's shopper can or can't be emailed — decided by the loader, per contact, every time. */
export type CartReach =
  /** A contact with explicit consent on record, and no suppression. */
  | "emailable"
  /** A contact whose recorded consent isn't explicit. */
  | "no_consent"
  /** Unsubscribed or erased. */
  | "suppressed"
  /** An address that is none of the owner's contacts. */
  | "not_contact"
  /** No address SYB could read. */
  | "no_email";

export interface CartFact {
  ref: string;
  /** "YYYY-MM-DD", the UTC day the checkout started. */
  day: string;
  completed: boolean;
  total_minor: number;
  currency: string;
  lines: readonly CartLine[];
  lines_truncated: boolean;
  /** The keyed email hash, or null. */
  shopper: string | null;
  reach: CartReach;
}

export interface Money {
  amount_minor: number;
  currency: string;
}

export interface WindowStats {
  from: string;
  to: string;
  started: number;
  left: number;
  recovered: number;
  /** Orders the sync counted in the window; null when no order day was measured. */
  orders: number | null;
  /** left ÷ (left + orders), 0–1; null without orders. */
  share_left: number | null;
  /** Per currency, sorted by code. */
  value_left: Money[];
}

export interface ProductLeft {
  product_ref: string;
  /** The line's own title, the latest seen; a label for when no offer is matched. */
  title: string | null;
  /** Left carts holding it. */
  carts: number;
  units: number;
  /** quantity × unit price, per currency. */
  value: Money[];
}

export interface WinBack {
  currency: string;
  /** The value of the emailable carts this range is taken from. */
  base_minor: number;
  low_minor: number;
  high_minor: number;
}

export interface Reach {
  /** Distinct shoppers behind the left carts: one per hash, and one per cart without an address. */
  shoppers: number;
  /** Distinct shoppers who may be emailed. */
  emailable_shoppers: number;
  /** Left carts per reach. */
  carts: Record<CartReach, number>;
}

export type CartsMeasure =
  | {
      status: "refused";
      from: string;
      to: string;
      /** Days of the window with carts read (from the first cart's day). */
      days: number;
      left: number;
      /** The day it will be ready, when a date can be known; null when it waits on carts. */
      ready_from: string | null;
      reason: string;
    }
  | {
      status: "measured";
      current: WindowStats;
      /** The 30 days before, when they pass the same tests; else null with why. */
      prior: WindowStats | null;
      prior_note: string | null;
      products: ProductLeft[];
      /** Left carts with more lines than one read takes: their products are counted short. */
      truncated: number;
      reach: Reach;
      win_back: WinBack[];
    };

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** "6 Nov" — en-GB, UTC. */
export function dayWords(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Days of [from, to] on or after the first cart's day. */
export function coveredDays(firstDay: string | null, from: string, to: string): number {
  if (firstDay === null || firstDay > to) return 0;
  const start = firstDay > from ? firstDay : from;
  return daysBetween(start, to) + 1;
}

function addMoney(into: Map<string, number>, currency: string, amount: number): void {
  into.set(currency, (into.get(currency) ?? 0) + amount);
}

function sortedMoney(m: Map<string, number>): Money[] {
  return [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, amount_minor]) => ({ currency, amount_minor }));
}

function inWindow(c: CartFact, from: string, to: string): boolean {
  return c.day >= from && c.day <= to;
}

function windowStats(
  carts: readonly CartFact[],
  orders: readonly { day: string; count: number }[],
  from: string,
  to: string,
): WindowStats {
  const mine = carts.filter((c) => inWindow(c, from, to));
  const left = mine.filter((c) => !c.completed);
  const value = new Map<string, number>();
  for (const c of left) addMoney(value, c.currency.toUpperCase(), c.total_minor);
  const orderDays = orders.filter((o) => o.day >= from && o.day <= to);
  const orderCount = orderDays.length === 0 ? null : orderDays.reduce((s, o) => s + o.count, 0);
  const all = orderCount === null ? null : orderCount + left.length;
  return {
    from,
    to,
    started: mine.length,
    left: left.length,
    recovered: mine.length - left.length,
    orders: orderCount,
    share_left: all === null || all === 0 ? null : left.length / all,
    value_left: sortedMoney(value),
  };
}

/** Pure: the window's carts and orders, measured, or refused with why. */
export function measureCarts(input: {
  today: string;
  carts: readonly CartFact[];
  orders: readonly { day: string; count: number }[];
}): CartsMeasure {
  const to = shiftDay(input.today, -1);
  const from = shiftDay(input.today, -CARTS.window_days);
  const firstDay = input.carts.reduce<string | null>(
    (min, c) => (min === null || c.day < min ? c.day : min),
    null,
  );
  const days = coveredDays(firstDay, from, to);
  const current = windowStats(input.carts, input.orders, from, to);

  if (days < CARTS.min_days || current.left < CARTS.min_carts) {
    const short: string[] = [];
    if (days < CARTS.min_days) {
      short.push(
        firstDay === null
          ? "no carts read yet"
          : `${days} day${days === 1 ? "" : "s"} of carts (I need ${CARTS.min_days})`,
      );
    }
    if (current.left < CARTS.min_carts) {
      short.push(
        `${current.left} cart${current.left === 1 ? "" : "s"} left in the last ${CARTS.window_days} days (I need ${CARTS.min_carts})`,
      );
    }
    // A day short is a date; a cart short isn't — nobody knows when the next one is left.
    const ready_from =
      firstDay !== null && current.left >= CARTS.min_carts
        ? shiftDay(firstDay, CARTS.min_days)
        : null;
    const when =
      ready_from !== null
        ? `It will be ready from ${dayWords(ready_from)}.`
        : `It will be ready once ${CARTS.min_carts} carts are left within ${CARTS.window_days} days${days < CARTS.min_days && firstDay !== null ? `, and not before ${dayWords(shiftDay(firstDay, CARTS.min_days))}` : ""}.`;
    return {
      status: "refused",
      from,
      to,
      days,
      left: current.left,
      ready_from,
      reason: `Too little to measure yet: ${short.join(" and ")}. ${when}`,
    };
  }

  const pTo = shiftDay(from, -1);
  const pFrom = shiftDay(from, -CARTS.window_days);
  const pDays = coveredDays(firstDay, pFrom, pTo);
  const priorStats = windowStats(input.carts, input.orders, pFrom, pTo);
  const priorOk = pDays >= CARTS.min_days && priorStats.left >= CARTS.min_carts;

  const left = input.carts.filter((c) => inWindow(c, from, to) && !c.completed);

  // Products: in how many left carts, how many units, at what value.
  const byProduct = new Map<
    string,
    { title: string | null; carts: Set<string>; units: number; value: Map<string, number> }
  >();
  for (const c of left) {
    for (const l of c.lines) {
      if (l.product_ref === null || l.quantity <= 0) continue;
      const p = byProduct.get(l.product_ref) ?? {
        title: null,
        carts: new Set<string>(),
        units: 0,
        value: new Map<string, number>(),
      };
      p.title = l.title ?? p.title;
      p.carts.add(c.ref);
      p.units += l.quantity;
      addMoney(p.value, c.currency.toUpperCase(), l.quantity * l.unit_price_minor);
      byProduct.set(l.product_ref, p);
    }
  }
  const products = [...byProduct.entries()]
    .map(([product_ref, p]) => ({
      product_ref,
      title: p.title,
      carts: p.carts.size,
      units: p.units,
      value: sortedMoney(p.value),
    }))
    .sort(
      (a, b) =>
        b.carts - a.carts ||
        b.units - a.units ||
        (a.product_ref < b.product_ref ? -1 : a.product_ref > b.product_ref ? 1 : 0),
    )
    .slice(0, CARTS.top_products);

  // Reach: who is behind the left carts, and who may be emailed.
  const carts: Record<CartReach, number> = {
    emailable: 0,
    no_consent: 0,
    suppressed: 0,
    not_contact: 0,
    no_email: 0,
  };
  const hashes = new Set<string>();
  const emailable = new Set<string>();
  let anonymous = 0;
  const base = new Map<string, number>();
  for (const c of left) {
    carts[c.reach] += 1;
    if (c.shopper === null) anonymous += 1;
    else hashes.add(c.shopper);
    if (c.reach === "emailable" && c.shopper !== null) {
      emailable.add(c.shopper);
      addMoney(base, c.currency.toUpperCase(), c.total_minor);
    }
  }

  return {
    status: "measured",
    current,
    prior: priorOk ? priorStats : null,
    prior_note: priorOk
      ? null
      : `No comparison yet: the ${CARTS.window_days} days before have ${pDays} day${pDays === 1 ? "" : "s"} of carts and ${priorStats.left} left, and a comparison needs ${CARTS.min_days} days and ${CARTS.min_carts} carts.`,
    products,
    truncated: left.filter((c) => c.lines_truncated).length,
    reach: { shoppers: hashes.size + anonymous, emailable_shoppers: emailable.size, carts },
    win_back: sortedMoney(base).map((m) => ({
      currency: m.currency,
      base_minor: m.amount_minor,
      low_minor: Math.round(m.amount_minor * WIN_BACK.low),
      high_minor: Math.round(m.amount_minor * WIN_BACK.high),
    })),
  };
}
