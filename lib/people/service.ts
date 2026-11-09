// Per-person figures, read and changed — P6-06 (TASKS-PHASE6.md, rule 28
// amended; rule 22). Read-only over the bookings, apart from the two things
// the owner may do here: state a person's weekly capacity, and remove a
// person. No model, no network.
//
// The gates, in the order the route applies them: the owner role (people
// figures are the owner's alone, app/api/team/people), then the team
// module's per-business switch, off by default (rule 28): with it off,
// peopleView returns before a single appointment is read.
//
// Nothing here creates a proposal, a note, a watch item or a log line
// about a person: the figures are shown to the owner and go nowhere else.
// The one decision-log entry, for a removal, carries counts and a hash,
// never the name.

import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, lte, max, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  bookingAppointments,
  bookingImports,
  connections,
  decisionLog,
  metricObservations,
  staffErasures,
  staffPeople,
} from "../../db/schema";
import { isBookingPlatform, platformLabel } from "../bookings/import-map";
import { BOOKING_WINDOW_DAYS, REBOOK_DAYS, shiftDate } from "../bookings/measures";
import { BOOKINGS_IMPORT_PROVIDER } from "../bookings/source";
import type { AppLocale } from "../i18n/locales";
import { teamModuleOn } from "../team/module";
import type { PeopleFigures, StatedCapacity } from "./figures";
import { peopleFigures } from "./figures";
import { normaliseStaff, staffKey } from "./staff-key";

/** The least and most appointments a week a stated capacity may be (the table's check). */
export const CAPACITY_MIN = 1;
export const CAPACITY_MAX = 1000;

/** Where the figures were read from. */
export interface PeopleSource {
  kind: "square" | "import";
  /** The export's platform ("Fresha"), for an import; null for Square. */
  platform: string | null;
}

export type PeopleView =
  | { enabled: false }
  | { enabled: true; status: "no_bookings" }
  | {
      enabled: true;
      status: "ok";
      source: PeopleSource;
      figures: PeopleFigures;
      /**
       * Whether any sales source records who made a sale. None does yet: the
       * Square, Shopify, WooCommerce and Stripe reads keep daily totals, not
       * per-sale rows with a staff member, so per-person sales aren't shown.
       */
      sales_by_person: false;
    };

/** The bookings source holding the most appointments up to `yesterday`: sources never add up. */
async function pickSource(
  accountId: string,
  yesterday: string,
): Promise<{ id: string; provider: string; asOf: string } | null> {
  const conns = await db
    .select({ id: connections.id, provider: connections.provider })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        inArray(connections.provider, [BOOKINGS_IMPORT_PROVIDER, "square"]),
      ),
    );
  if (conns.length === 0) return null;
  const [best] = await db
    .select({
      connection_id: bookingAppointments.connection_id,
      last: max(bookingAppointments.day),
    })
    .from(bookingAppointments)
    .where(
      and(
        inArray(
          bookingAppointments.connection_id,
          conns.map((c) => c.id),
        ),
        lte(bookingAppointments.day, yesterday),
      ),
    )
    .groupBy(bookingAppointments.connection_id)
    .orderBy(desc(sql`count(*)`));
  if (!best || best.last === null) return null;
  const conn = conns.find((c) => c.id === best.connection_id);
  if (!conn) return null;
  // The business's own latest measured day (lib/bookings/store's
  // latestMeasuredDay): the last day the daily series was computed for. Not
  // the latest appointment's day: a booking stored as "booked" for a day
  // that has since passed was never measured, and a window ending there
  // would not be the business's window, nor add up to its totals.
  const [measured] = await db
    .select({ day: max(metricObservations.period_date) })
    .from(metricObservations)
    .where(
      and(
        eq(metricObservations.connection_id, conn.id),
        eq(metricObservations.metric_key, "appointments_completed.daily"),
      ),
    );
  const asOf = measured?.day ?? null;
  return asOf === null ? null : { id: conn.id, provider: conn.provider, asOf };
}

/** The export's platform, from the account's latest import. */
async function importPlatform(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ platform: bookingImports.platform })
    .from(bookingImports)
    .where(eq(bookingImports.account_id, accountId))
    .orderBy(desc(bookingImports.imported_at))
    .limit(1);
  return row && isBookingPlatform(row.platform) ? platformLabel(row.platform) : null;
}

/** What the owner stated, by the person's name as the source records it. */
async function statedCapacities(accountId: string): Promise<Map<string, StatedCapacity>> {
  const rows = await db
    .select({
      staff_ref: staffPeople.staff_ref,
      per_week: staffPeople.capacity_per_week,
      stated_at: staffPeople.capacity_stated_at,
    })
    .from(staffPeople)
    .where(and(eq(staffPeople.account_id, accountId), isNotNull(staffPeople.capacity_per_week)));
  const out = new Map<string, StatedCapacity>();
  for (const r of rows) {
    if (r.per_week !== null && r.stated_at !== null) {
      out.set(r.staff_ref, { per_week: r.per_week, stated_at: r.stated_at });
    }
  }
  return out;
}

/** The /team per-person section's data. The caller has already checked the owner role. */
export async function peopleView(
  accountId: string,
  now: Date = new Date(),
  locale: AppLocale = "en",
): Promise<PeopleView> {
  if (!(await teamModuleOn(accountId))) return { enabled: false };
  const yesterday = shiftDate(now.toISOString().slice(0, 10), -1);
  const source = await pickSource(accountId, yesterday);
  if (!source) return { enabled: true, status: "no_bookings" };
  // From the rebooking cohort's first day: the earliest day any figure reads.
  const since = shiftDate(source.asOf, -(REBOOK_DAYS + BOOKING_WINDOW_DAYS - 1));
  const [appointments, capacities, platform] = await Promise.all([
    db
      .select({
        day: bookingAppointments.day,
        status: bookingAppointments.status,
        client_key: bookingAppointments.client_key,
        price_minor: bookingAppointments.price_minor,
        currency: bookingAppointments.currency,
        staff_ref: bookingAppointments.staff_ref,
      })
      .from(bookingAppointments)
      .where(
        and(eq(bookingAppointments.connection_id, source.id), gte(bookingAppointments.day, since)),
      ),
    statedCapacities(accountId),
    source.provider === "square" ? Promise.resolve(null) : importPlatform(accountId),
  ]);
  return {
    enabled: true,
    status: "ok",
    source: { kind: source.provider === "square" ? "square" : "import", platform },
    figures: peopleFigures(
      {
        appointments,
        asOf: source.asOf,
        lateSeparated: source.provider !== "square",
        capacities,
      },
      locale,
    ),
    sales_by_person: false,
  };
}

/* ── what the owner may change ── */

export class PeopleError extends Error {
  constructor(
    readonly reason: "unknown_person" | "bad_capacity" | "module_off",
    readonly status: number,
  ) {
    super(reason);
    this.name = "PeopleError";
  }
}

/** Pure: a stated weekly capacity, or null to clear it; anything else is refused. */
export function readCapacity(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return undefined;
  return raw >= CAPACITY_MIN && raw <= CAPACITY_MAX ? raw : undefined;
}

/** The names the account's appointments record that match `person`, spelled as stored. */
async function spellingsOf(accountId: string, person: string): Promise<string[]> {
  const wanted = normaliseStaff(person);
  if (wanted === null) return [];
  const rows = await db
    .selectDistinct({ staff_ref: bookingAppointments.staff_ref })
    .from(bookingAppointments)
    .where(
      and(eq(bookingAppointments.account_id, accountId), isNotNull(bookingAppointments.staff_ref)),
    );
  const people = await db
    .select({ staff_ref: staffPeople.staff_ref })
    .from(staffPeople)
    .where(eq(staffPeople.account_id, accountId));
  return [
    ...new Set(
      [...rows, ...people]
        .map((r) => r.staff_ref)
        .filter((r): r is string => r !== null && normaliseStaff(r) === wanted),
    ),
  ];
}

/**
 * The owner states a person's weekly capacity (appointments a week), or
 * clears it with null. Only for a person the bookings record, and only with
 * the team module on. Who stated it and when are kept beside it (rule 2).
 */
export async function stateCapacity(
  accountId: string,
  userId: string | null,
  person: string,
  perWeek: number | null,
  now: Date = new Date(),
): Promise<void> {
  if (!(await teamModuleOn(accountId))) throw new PeopleError("module_off", 409);
  const spelled = (await spellingsOf(accountId, person)).includes(person);
  if (!spelled) throw new PeopleError("unknown_person", 404);
  if (perWeek === null) {
    await db
      .delete(staffPeople)
      .where(and(eq(staffPeople.account_id, accountId), eq(staffPeople.staff_ref, person)));
    return;
  }
  const stated = {
    capacity_per_week: perWeek,
    capacity_stated_at: now.toISOString(),
    capacity_stated_by: userId,
  };
  await db
    .insert(staffPeople)
    .values({ account_id: accountId, staff_ref: person, ...stated })
    .onConflictDoUpdate({ target: [staffPeople.account_id, staffPeople.staff_ref], set: stated });
}

/**
 * Rule 22: remove a person. In one transaction their name is cleared from
 * every appointment that records it (in any spelling that normalises the
 * same), what the owner stated about them is deleted, and the keyed hash of
 * the name is remembered so the next overlapping import or sync can't write
 * it back. The appointments themselves stay, so the business's own totals
 * don't move. One decision-log entry: counts and a hash, never the name.
 * Allowed with the team module off: erasing is always the safe direction.
 */
export async function removePerson(
  accountId: string,
  profileId: string,
  userId: string | null,
  person: string,
): Promise<{ appointments: number }> {
  const key = staffKey(accountId, person);
  const spellings = await spellingsOf(accountId, person);
  if (key === null || spellings.length === 0) throw new PeopleError("unknown_person", 404);
  const cleared = await db.transaction(async (tx) => {
    const [erasure] = await tx
      .insert(staffErasures)
      .values({ account_id: accountId, staff_key: key })
      .onConflictDoUpdate({
        target: [staffErasures.account_id, staffErasures.staff_key],
        set: { at: sql`now()` },
      })
      .returning({ id: staffErasures.id });
    const rows = await tx
      .update(bookingAppointments)
      .set({ staff_ref: null })
      .where(
        and(
          eq(bookingAppointments.account_id, accountId),
          inArray(bookingAppointments.staff_ref, spellings),
        ),
      )
      .returning({ id: bookingAppointments.id });
    await tx
      .delete(staffPeople)
      .where(and(eq(staffPeople.account_id, accountId), inArray(staffPeople.staff_ref, spellings)));
    await tx.insert(decisionLog).values({
      profile_id: profileId,
      actor: "owner",
      kind: "erasure",
      ref_id: erasure?.id ?? key.slice(0, 32),
      payload_hash: createHash("sha256")
        .update(
          JSON.stringify({
            account_id: accountId,
            what: "staff_person",
            staff_key: key,
            appointments: rows.length,
          }),
        )
        .digest("hex"),
      user_id: userId,
    });
    return rows.length;
  });
  console.log(
    JSON.stringify({ event: "staff_person_removed", account_id: accountId, appointments: cleared }),
  );
  return { appointments: cleared };
}
