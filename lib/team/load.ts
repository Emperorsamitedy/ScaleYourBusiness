// Reading coverage by hour — P5-19/P5-20 (Phase 5 Session E). Read-only
// apart from what /hours already does (a single-zone country's timezone is
// written as an inferred fact when hourly takings are read). No model, no
// network.
//
// The module gate comes first: with the team module off (the default,
// rule 28) teamView returns before a single booking or role is read.
//
// What is selected, column by column, and nothing more (rule 28):
//   bookings   day, start time and status. The team-member and client
//              columns are never selected, so they cannot reach a sum.
//   roles      each 9.2 row's role title and hours a week. The row's other
//              answers (tasks, cost, replaceability) are not read.
//   the rest   the stated weekly capacity (1.4.2.3b), the opening hours
//              already parsed for /hours, the season forecast, and hourly
//              takings only when there are no bookings to hold against
//              capacity.

import { and, desc, eq, gte, inArray, isNull, lte, max, min, sql } from "drizzle-orm";
import { db } from "../../db";
import { bookingAppointments, connections, fieldRecords } from "../../db/schema";
import { BOOKINGS_IMPORT_PROVIDER } from "../bookings/source";
import { CAPACITY_KEY } from "../bookings/store";
import { coverageLine } from "../hours/coverage";
import { isOpenHour } from "../hours/grid";
import type { OpeningSchedule, Weekday } from "../hours/schedule";
import { SCHEDULE_KEY } from "../hours/schedule";
import { loadTradingSales } from "../hours/trading";
import { readCurrentField } from "../profile/field-store";
import { loadSeasons } from "../seasons/load";
import type { CoverageInput, CoverageResult, RoleInput, SeasonInput, SlotInput } from "./coverage";
import { TEAM, TEAM_WEEKDAYS, dayText, teamCoverage } from "./coverage";
import { teamModuleOn } from "./module";

/** The 9.2 answer (an entity list) and the two sub-fields read from each of its rows. */
export const STAFF_KEY = "operations.staff";
export const ROLE_FIELDS = ["role_title", "hours_per_week"] as const;

const DAY_MS = 86_400_000;
const shift = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export type TeamView =
  { enabled: false } | { enabled: true; generated_on: string; result: CoverageResult };

/** The roles from 9.2: title and hours only. */
export async function loadRoles(profileId: string): Promise<RoleInput[]> {
  const marker = await readCurrentField<{ entity_ids?: unknown }>(profileId, STAFF_KEY);
  const ids = Array.isArray(marker?.value?.entity_ids)
    ? marker.value.entity_ids.filter((x): x is string => typeof x === "string")
    : [];
  if (ids.length === 0) return [];
  const keys = ids.flatMap((id) => ROLE_FIELDS.map((f) => `operations.${id}.${f}`));
  const rows = await db
    .select({
      field_key: fieldRecords.field_key,
      status: fieldRecords.status,
      value: fieldRecords.value,
    })
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        inArray(fieldRecords.field_key, keys),
        isNull(fieldRecords.superseded_at),
      ),
    );
  const answered = new Map(
    rows.filter((r) => r.status === "answered").map((r) => [r.field_key, r.value]),
  );
  return ids.map((id) => {
    const title = answered.get(`operations.${id}.role_title`);
    const hours = answered.get(`operations.${id}.hours_per_week`);
    return {
      role_title: typeof title === "string" ? title : null,
      hours_per_week: typeof hours === "number" && Number.isFinite(hours) ? hours : null,
    };
  });
}

/** The owner's own weekly capacity, answered only: never an assumed one. */
async function statedCapacity(profileId: string): Promise<number | null> {
  const f = await readCurrentField<unknown>(profileId, CAPACITY_KEY);
  if (!f || f.status !== "answered") return null;
  return typeof f.value === "number" && Number.isFinite(f.value) && f.value > 0 ? f.value : null;
}

/** The opening hours /hours already parsed, as open trading hours per stated weekday. */
async function statedOpenHours(
  profileId: string,
): Promise<Partial<Record<Weekday, number[]>> | null> {
  const f = await readCurrentField<OpeningSchedule>(profileId, SCHEDULE_KEY);
  const schedule = f?.value;
  if (!schedule || typeof schedule !== "object" || !schedule.days) return null;
  const out: Partial<Record<Weekday, number[]>> = {};
  for (const w of TEAM_WEEKDAYS) {
    if (schedule.unstated?.includes(w)) continue;
    const periods = schedule.days[w];
    if (!Array.isArray(periods)) continue;
    out[w] = Array.from({ length: 30 }, (_, h) => h).filter((h) => isOpenHour(periods, h));
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** One bookings source's slots in the window: the one holding the most (sources never add up). */
async function loadBookings(
  accountId: string,
  yesterday: string,
): Promise<{ asOf: string; bookings: NonNullable<CoverageInput["bookings"]> } | null> {
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
  const spans = await db
    .select({
      connection_id: bookingAppointments.connection_id,
      first: min(bookingAppointments.day),
      last: max(bookingAppointments.day),
      n: sql<number>`count(*)::int`,
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
  const best = spans[0];
  if (!best || best.first === null || best.last === null) return null;
  const conn = conns.find((c) => c.id === best.connection_id);
  const asOf = best.last;
  const from = shift(asOf, -(TEAM.window_days - 1));
  const slots: SlotInput[] = await db
    .select({
      day: bookingAppointments.day,
      start_time: bookingAppointments.start_time,
      status: bookingAppointments.status,
    })
    .from(bookingAppointments)
    .where(
      and(
        eq(bookingAppointments.connection_id, best.connection_id),
        gte(bookingAppointments.day, from),
        lte(bookingAppointments.day, asOf),
      ),
    )
    .orderBy(bookingAppointments.day, bookingAppointments.start_time, bookingAppointments.id);
  return {
    asOf,
    bookings: {
      source: conn?.provider === "square" ? "Square bookings" : "your bookings export",
      first_day: best.first,
      slots,
    },
  };
}

/** The season forecast, reduced to what coverage needs: the busy stretch ahead, or why not. */
async function loadSeason(accountId: string, profileId: string, now: Date): Promise<SeasonInput> {
  const { result } = await loadSeasons(accountId, profileId, now);
  if (result.status === "no_data") {
    return { status: "unread", reason: "nothing is measured by the day yet" };
  }
  if (result.status === "too_little") {
    return {
      status: "unread",
      reason: `${result.complete_weeks} of the ${result.needed_weeks} complete weeks a season needs, ready around ${dayText(result.ready_on)}`,
    };
  }
  const busy = result.upcoming.find((u) => u.run.kind === "busy");
  if (!busy) return { status: "none_ahead" };
  return {
    status: "busy_ahead",
    starts_on: busy.starts_on,
    ends_on: busy.ends_on,
    in_progress: busy.in_progress,
    index: busy.run.index,
    low: busy.run.low,
    high: busy.run.high,
  };
}

/** Everything coverage reads, for one business. */
export async function loadCoverageInput(
  accountId: string,
  profileId: string,
  now: Date = new Date(),
): Promise<CoverageInput> {
  const yesterday = shift(now.toISOString().slice(0, 10), -1);
  const [booked, capacity, openHours, season, roles] = await Promise.all([
    loadBookings(accountId, yesterday),
    statedCapacity(profileId),
    statedOpenHours(profileId),
    loadSeason(accountId, profileId, now),
    loadRoles(profileId),
  ]);
  const asOf = booked?.asOf ?? yesterday;

  // Takings only when bookings can't be held against a stated capacity.
  let takings: CoverageInput["takings"] = null;
  if (booked === null || capacity === null) {
    const sales = await loadTradingSales(profileId, shift(asOf, -(TEAM.window_days - 1)), asOf);
    if (!("reason" in sales)) {
      takings = {
        source: coverageLine(sales.providers),
        currency: sales.currency,
        byDay: sales.byDay,
        measuredDays: sales.measuredDays,
      };
    }
  }
  return {
    asOf,
    bookings: booked?.bookings ?? null,
    takings,
    capacityPerWeek: capacity,
    openHours,
    season,
    roles,
  };
}

/** P5-20's screen data. With the module off, nothing is read beyond the switch. */
export async function teamView(
  accountId: string,
  profileId: string,
  now: Date = new Date(),
  compute: (input: CoverageInput) => CoverageResult = teamCoverage,
): Promise<TeamView> {
  if (!(await teamModuleOn(accountId))) return { enabled: false };
  const input = await loadCoverageInput(accountId, profileId, now);
  return { enabled: true, generated_on: now.toISOString().slice(0, 10), result: compute(input) };
}
