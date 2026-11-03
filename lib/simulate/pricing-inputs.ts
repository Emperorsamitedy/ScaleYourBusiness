// What-if pricing's database side — idea 43. Reads the figures
// lib/simulate/pricing.ts works from, each with its provenance, and
// nothing else: the offers on the profile snapshot (price, cost to
// deliver, units a month — the same facts the economics engine reads),
// the owner's per-order costs, and, for a booking business, its own
// last 28 days of appointments per service and the stated weekly
// capacity. Read-only; no model call; nothing written but the snapshot
// the simulator already ensures.

import { and, eq, gte, inArray, lte, max } from "drizzle-orm";
import { db } from "../../db";
import {
  accounts,
  bookingAppointments,
  businessProfiles,
  connections,
  metricObservations,
} from "../../db/schema";
import { BOOKING_WINDOW_DAYS, shiftDate } from "../bookings/measures";
import { BOOKINGS_IMPORT_PROVIDER } from "../bookings/source";
import { CAPACITY_KEY } from "../bookings/store";
import { SELLS_KEY, TYPE_KEY } from "../charts/load";
import { archetypeFor } from "../charts/profiles";
import { readCurrentField } from "../profile/field-store";
import { ensureSnapshot, readSnapshot } from "../profile/snapshot";
import type { PricingInputs } from "./pricing";
import { offerItems, perOrderCosts, serviceItems } from "./pricing-items";
import type { SimText } from "./words";
import { englishSimText, section } from "./words";

/** The bookings source with the latest measured day, its window and rows. */
async function bookingRows(accountId: string, w: SimText) {
  const conns = await db
    .select({ id: connections.id, provider: connections.provider })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.purpose, "measure"),
        inArray(connections.provider, [BOOKINGS_IMPORT_PROVIDER, "square"]),
      ),
    );
  let best: { id: string; provider: string; day: string } | null = null;
  for (const c of conns) {
    const [row] = await db
      .select({ day: max(metricObservations.period_date) })
      .from(metricObservations)
      .where(
        and(
          eq(metricObservations.connection_id, c.id),
          eq(metricObservations.metric_key, "appointments_completed.daily"),
        ),
      );
    if (row?.day && (best === null || row.day > best.day)) {
      best = { id: c.id, provider: c.provider, day: row.day };
    }
  }
  if (!best) return null;
  const to = best.day;
  const from = shiftDate(to, -(BOOKING_WINDOW_DAYS - 1));
  const rows = await db
    .select({
      service: bookingAppointments.service,
      status: bookingAppointments.status,
      price_minor: bookingAppointments.price_minor,
      currency: bookingAppointments.currency,
    })
    .from(bookingAppointments)
    .where(
      and(
        eq(bookingAppointments.connection_id, best.id),
        gte(bookingAppointments.day, from),
        lte(bookingAppointments.day, to),
      ),
    );
  return {
    from,
    to,
    rows,
    source: best.provider === "square" ? "Square" : section(w, "items")("bookingsExport"),
  };
}

/**
 * Everything what-if pricing needs for one business, as of `now`. The
 * sources' words are `words` (L-4b): the pricing route passes the
 * request's; every other caller keeps the English default.
 */
export async function gatherPricingInputs(
  profileId: string,
  now: Date = new Date(),
  words: SimText = englishSimText(),
): Promise<PricingInputs> {
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id, currency: accounts.reporting_currency })
    .from(businessProfiles)
    .innerJoin(accounts, eq(accounts.id, businessProfiles.account_id))
    .where(eq(businessProfiles.id, profileId));
  if (!profile) throw new Error("no such business");

  const view = await readSnapshot((await ensureSnapshot(profileId)).id);
  const [type, sells, capacity] = await Promise.all([
    readCurrentField<unknown>(profileId, TYPE_KEY),
    readCurrentField<unknown>(profileId, SELLS_KEY),
    readCurrentField<unknown>(profileId, CAPACITY_KEY),
  ]);
  const archetype = archetypeFor(
    type?.status === "answered" ? type.value : null,
    sells?.status === "answered" ? sells.value : null,
  );

  const offers = offerItems(view, words);
  const bookings = await bookingRows(profile.account_id, words);
  // Only the owner's own capacity: the book's room is never worked out on an assumed one.
  const capacityPerWeek =
    capacity?.status === "answered" &&
    typeof capacity.value === "number" &&
    Number.isFinite(capacity.value) &&
    capacity.value > 0
      ? capacity.value
      : null;
  const services = bookings
    ? serviceItems(
        {
          rows: bookings.rows,
          from: bookings.from,
          to: bookings.to,
          source: bookings.source,
          capacityPerWeek,
          offers,
        },
        words,
      )
    : [];
  // An offer a service already stands for isn't listed twice.
  const served = new Set(services.map((s) => s.name.trim().toLowerCase()));

  return {
    as_of: now.toISOString().slice(0, 10),
    currency: profile.currency,
    archetype,
    items: [...services, ...offers.filter((o) => !served.has(o.name.trim().toLowerCase()))],
    per_order_costs: perOrderCosts(view, words),
  };
}
