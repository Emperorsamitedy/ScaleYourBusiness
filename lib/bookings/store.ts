// Bookings, stored and measured — specs/bookings.md §3–4.
//
// Two sources write appointments here: the Square sync (each page's
// bookings, in the page's transaction) and an owner's export file
// (importBookings). Either way:
//
//   · one row per (connection, source_ref), a unique index: an overlapping
//     re-import updates what it already has and adds only what is new, so
//     nothing is counted twice;
//   · the client identity is hashed on the way in (client-key.ts) and the
//     raw value goes no further;
//   · the daily counts go to metric_observations under the connection, the
//     table every connector feeds, so the anomaly layer and the watch read
//     them like any other series;
//   · the 28-day measures become measured facts through the same writer
//     the connectors use (derive.ts), superseding the owner's estimates
//     (rule 3) with the delta shown in the report (rule 11).

import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, lte, max, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  bookingAppointments,
  bookingImports,
  businessProfiles,
  connections,
  decisionLog,
  metricObservations,
} from "../../db/schema";
import { detectAnomalies } from "../anomaly/detect";
import type { DeriveOutcome, DeriveWindow } from "../connectors/derive";
import { writeMeasured } from "../connectors/derive";
import type { MetricKey } from "../connectors/provider";
import type { Executor } from "../connectors/service";
import { upsertObservations } from "../connectors/service";
import { isoDate, isoDateTime } from "../core/iso";
import { readCurrentField } from "../profile/field-store";
import { clientKey } from "./client-key";
import type { BookingPlatform, ColumnRole } from "./import-map";
import { platformLabel } from "./import-map";
import type { BookingMeasures } from "./measures";
import {
  BOOKING_WINDOW_DAYS,
  REBOOK_DAYS,
  bookingMeasures,
  dailyBookingObservations,
  shiftDate,
} from "./measures";
import type { DateOrder } from "./parse";
import type { CellGap, RowSkipReason } from "./rows";
import { BookingImportError, readExport } from "./rows";
import { BOOKINGS_IMPORT_PROVIDER } from "./source";
import type { BookingInput, MeasuredAppointment } from "./types";

type ConnectionRow = typeof connections.$inferSelect;
type Conn = Pick<ConnectionRow, "id" | "account_id" | "provider">;

/** The facts the measures become (specs/bookings.md §4). */
export const BOOKING_FACT_KEYS = {
  completed: "service.appointments_completed_28d",
  noShowRate: "service.no_show_rate_28d",
  lateRate: "service.late_cancellation_rate_28d",
  noShowWords: "service.no_show_rate",
  rebooking: "revenue.repeat_customer_rate",
  revenue: "service.booking_revenue_28d",
  utilisation: "service.utilisation_28d",
} as const;

/** The bank's weekly-capacity question (1.4.2.3b): utilisation's only denominator. */
export const CAPACITY_KEY = "service.capacity_per_week";

/** Keys the report's stated-against-measured table looks for. */
export const BOOKING_STATED_KEYS: readonly string[] = [
  BOOKING_FACT_KEYS.noShowWords,
  BOOKING_FACT_KEYS.rebooking,
];

const CHUNK = 500;

/* ── the import source ── */

/** The account's import source, created on first use. Never pulled, never listed as a connection. */
export async function ensureImportConnection(accountId: string): Promise<ConnectionRow> {
  const find = async () => {
    const [row] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.account_id, accountId),
          eq(connections.provider, BOOKINGS_IMPORT_PROVIDER),
          eq(connections.purpose, "measure"),
          ne(connections.status, "disconnected"),
        ),
      );
    return row ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  try {
    const [row] = await db
      .insert(connections)
      .values({
        account_id: accountId,
        provider: BOOKINGS_IMPORT_PROVIDER,
        purpose: "measure",
        status: "connected",
        encrypted_secret: null,
        granted_scopes: [],
      })
      .returning();
    if (row) return row;
  } catch {
    // Two imports racing: the partial unique index let one in. Read it.
  }
  const raced = await find();
  if (!raced) throw new BookingImportError("the bookings import could not be set up", 500);
  return raced;
}

/* ── storing appointments ── */

export interface StoreCounts {
  added: number;
  updated: number;
  unchanged: number;
  /** The days the stored appointments fall on, or null when there were none. */
  days: { from: string; to: string } | null;
}

function keyFor(conn: Conn, input: BookingInput, scope: string): string | null {
  if (input.client === null) return null;
  if (input.client.kind === "keyed") return input.client.key;
  return clientKey(conn.account_id, input.client, scope);
}

/**
 * Upsert appointments by (connection, source_ref). A row whose values are
 * unchanged is left alone and counted as such; a changed one (a booking
 * since completed) is updated in place.
 */
export async function storeAppointments(
  executor: Executor,
  conn: Conn,
  inputs: readonly BookingInput[],
  options: { batchId: string | null; scope: string },
): Promise<StoreCounts> {
  const counts: StoreCounts = { added: 0, updated: 0, unchanged: 0, days: null };
  if (inputs.length === 0) return counts;
  const now = new Date().toISOString();
  for (let i = 0; i < inputs.length; i += CHUNK) {
    const chunk = inputs.slice(i, i + CHUNK);
    const rows = chunk.map((a) => ({
      account_id: conn.account_id,
      connection_id: conn.id,
      source_ref: a.source_ref,
      batch_id: options.batchId,
      day: a.day,
      start_time: a.start_time,
      status: a.status,
      service: a.service,
      staff_ref: a.staff_ref,
      client_key: keyFor(conn, a, options.scope),
      duration_minutes: a.duration_minutes,
      price_minor: a.price_minor,
      currency: a.price_minor === null ? null : a.currency,
      updated_at: now,
    }));
    const existing = await executor
      .select()
      .from(bookingAppointments)
      .where(
        and(
          eq(bookingAppointments.connection_id, conn.id),
          inArray(
            bookingAppointments.source_ref,
            rows.map((r) => r.source_ref),
          ),
        ),
      );
    const before = new Map(existing.map((r) => [r.source_ref, r]));
    const changed = rows.filter((r) => {
      const old = before.get(r.source_ref);
      if (!old) {
        counts.added++;
        return true;
      }
      const same =
        old.day === r.day &&
        old.start_time === r.start_time &&
        old.status === r.status &&
        old.service === r.service &&
        old.staff_ref === r.staff_ref &&
        old.client_key === r.client_key &&
        old.duration_minutes === r.duration_minutes &&
        old.price_minor === r.price_minor &&
        old.currency === r.currency;
      if (same) counts.unchanged++;
      else counts.updated++;
      return !same;
    });
    for (const r of rows) {
      if (counts.days === null) counts.days = { from: r.day, to: r.day };
      if (r.day < counts.days.from) counts.days.from = r.day;
      if (r.day > counts.days.to) counts.days.to = r.day;
    }
    if (changed.length === 0) continue;
    await executor
      .insert(bookingAppointments)
      .values(changed)
      .onConflictDoUpdate({
        target: [bookingAppointments.connection_id, bookingAppointments.source_ref],
        set: {
          batch_id: sqlExcluded("batch_id"),
          day: sqlExcluded("day"),
          start_time: sqlExcluded("start_time"),
          status: sqlExcluded("status"),
          service: sqlExcluded("service"),
          staff_ref: sqlExcluded("staff_ref"),
          client_key: sqlExcluded("client_key"),
          duration_minutes: sqlExcluded("duration_minutes"),
          price_minor: sqlExcluded("price_minor"),
          currency: sqlExcluded("currency"),
          updated_at: sqlExcluded("updated_at"),
        },
      });
  }
  return counts;
}

const sqlExcluded = (column: string) => sql.raw(`excluded."${column}"`);

async function measuredAppointments(
  executor: Executor,
  connectionId: string,
  range?: { from: string; to: string },
): Promise<MeasuredAppointment[]> {
  return executor
    .select({
      day: bookingAppointments.day,
      status: bookingAppointments.status,
      client_key: bookingAppointments.client_key,
      price_minor: bookingAppointments.price_minor,
      currency: bookingAppointments.currency,
    })
    .from(bookingAppointments)
    .where(
      range
        ? and(
            eq(bookingAppointments.connection_id, connectionId),
            gte(bookingAppointments.day, range.from),
            lte(bookingAppointments.day, range.to),
          )
        : eq(bookingAppointments.connection_id, connectionId),
    );
}

/** Recompute the daily series for [from, to] from the stored rows: the table is the truth. */
export async function recomputeDailyObservations(
  executor: Executor,
  conn: Conn,
  range: { from: string; to: string },
  observedAt: string,
): Promise<number> {
  if (range.from > range.to) return 0;
  const appts = await measuredAppointments(executor, conn.id, range);
  return upsertObservations(
    conn.id,
    conn.provider,
    dailyBookingObservations(appts, range.from, range.to, observedAt, {
      lateSeparated: lateSeparated(conn.provider),
    }),
    executor,
  );
}

/** Square folds a late cancellation into NO_SHOW; an export may say which is which. */
function lateSeparated(provider: string): boolean {
  return provider !== "square";
}

/* ── the import ── */

export interface ImportRequest {
  platform: BookingPlatform;
  currency: string | null;
  dateOrder: DateOrder | null;
}

export interface ImportOutcome {
  batch_id: string;
  platform: BookingPlatform;
  platform_label: string;
  columns: Partial<Record<ColumnRole, string>>;
  rows_read: number;
  added: number;
  updated: number;
  unchanged: number;
  skipped: Partial<Record<RowSkipReason, number>>;
  unknown_statuses: Record<string, number>;
  gaps: Partial<Record<CellGap, number>>;
  merged_lines: number;
  identity: "client_id" | "client_email" | "client_phone" | null;
  date_order: { order: DateOrder; proven: boolean } | null;
  /** The days the file covered that are now measured (up to yesterday), or null. */
  measured_days: { from: string; to: string } | null;
  booked_future: number;
  derived: DeriveOutcome[];
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Import one bookings export. The file is read (nothing guessed), its
 * appointments stored idempotently, the days it touched re-measured from
 * the table, and the 28-day facts derived. The batch is one decision-log
 * entry: counts and a hash, no PII.
 */
export async function importBookings(
  accountId: string,
  csv: string,
  request: ImportRequest,
  now = new Date(),
): Promise<ImportOutcome> {
  const today = dayOf(now);
  const read = readExport(
    csv,
    {
      platform: request.platform,
      currency: request.currency,
      dateOrder: request.dateOrder,
      today,
    },
    (identity) => clientKey(accountId, identity, request.platform),
  );
  if (read.appointments.length === 0) {
    const reasons = Object.entries(read.skipped)
      .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
      .join(", ");
    throw new BookingImportError(
      `none of the ${read.rows_read} rows could be read${reasons ? ` (${reasons})` : ""}`,
    );
  }

  const conn = await ensureImportConnection(accountId);
  const yesterday = shiftDate(today, -1);
  const observedAt = now.toISOString();

  const { batchId, counts, measuredDays } = await db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(bookingImports)
      .values({
        account_id: accountId,
        connection_id: conn.id,
        platform: request.platform,
        currency: read.columns.price ? (request.currency?.trim().toUpperCase() ?? null) : null,
        imported_at: observedAt,
        rows_read: read.rows_read,
        added: 0,
        updated: 0,
        unchanged: 0,
        skipped: read.skipped as Record<string, number>,
        columns: read.columns as Record<string, string>,
      })
      .returning({ id: bookingImports.id });
    if (!batch) throw new BookingImportError("the import could not be recorded", 500);
    const stored = await storeAppointments(tx, conn, read.appointments, {
      batchId: batch.id,
      scope: request.platform,
    });
    let measured: { from: string; to: string } | null = null;
    if (stored.days && stored.days.from <= yesterday) {
      measured = {
        from: stored.days.from,
        to: stored.days.to < yesterday ? stored.days.to : yesterday,
      };
      await recomputeDailyObservations(tx, conn, measured, observedAt);
    }
    await tx
      .update(bookingImports)
      .set({ added: stored.added, updated: stored.updated, unchanged: stored.unchanged })
      .where(eq(bookingImports.id, batch.id));
    return { batchId: batch.id, counts: stored, measuredDays: measured };
  });

  const derived = await deriveBookingFacts(conn.id, now);
  try {
    await detectAnomalies(conn.id, now);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "anomaly_detection_failed",
        account_id: accountId,
        connection_id: conn.id,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
  }

  const outcome: ImportOutcome = {
    batch_id: batchId,
    platform: request.platform,
    platform_label: platformLabel(request.platform),
    columns: read.columns,
    rows_read: read.rows_read,
    added: counts.added,
    updated: counts.updated,
    unchanged: counts.unchanged,
    skipped: read.skipped,
    unknown_statuses: read.unknown_statuses,
    gaps: read.gaps,
    merged_lines: read.merged_lines,
    identity: read.identity,
    date_order: read.date_order,
    measured_days: measuredDays,
    booked_future: read.appointments.filter((a) => a.status === "booked_future").length,
    derived,
  };

  // The batch on the record — counts and a hash, no PII (rule 7, rule 22).
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, accountId));
  const summary = {
    account_id: accountId,
    batch_id: batchId,
    kind: "bookings",
    platform: request.platform,
    rows_read: read.rows_read,
    added: counts.added,
    updated: counts.updated,
    unchanged: counts.unchanged,
    skipped: read.skipped,
    columns: Object.keys(read.columns).sort(),
  };
  if (profile) {
    await db.insert(decisionLog).values({
      profile_id: profile.id,
      actor: "owner",
      kind: "import",
      ref_id: batchId,
      payload_hash: createHash("sha256").update(JSON.stringify(summary)).digest("hex"),
    });
  }
  console.log(JSON.stringify({ event: "bookings_imported", ...summary }));
  return outcome;
}

/* ── the measured facts ── */

async function latestMeasuredDay(connectionId: string): Promise<string | null> {
  const [row] = await db
    .select({ day: max(metricObservations.period_date) })
    .from(metricObservations)
    .where(
      and(
        eq(metricObservations.connection_id, connectionId),
        eq(metricObservations.metric_key, "appointments_completed.daily"),
      ),
    );
  return row?.day ?? null;
}

async function statedCapacity(profileId: string): Promise<number | null> {
  const f = await readCurrentField<unknown>(profileId, CAPACITY_KEY);
  // Only the owner's own figure: utilisation is never computed on an assumed capacity.
  if (!f || f.status !== "answered") return null;
  return typeof f.value === "number" && Number.isFinite(f.value) && f.value > 0 ? f.value : null;
}

/** Where a connection's bookings came from, in words for a fact's note. */
async function provenance(conn: ConnectionRow): Promise<string> {
  if (conn.provider !== BOOKINGS_IMPORT_PROVIDER) return "Square bookings";
  const [batch] = await db
    .select({ platform: bookingImports.platform, at: bookingImports.imported_at })
    .from(bookingImports)
    .where(eq(bookingImports.connection_id, conn.id))
    .orderBy(desc(bookingImports.imported_at))
    .limit(1);
  if (!batch) return "a bookings export";
  const platform = batch.platform as BookingPlatform;
  const label = platform === "generic" ? "your booking system" : platformLabel(platform);
  return `bookings export from ${label}, imported ${new Date(batch.at).toISOString().slice(0, 10)}`;
}

/** The measures for the screen: null when nothing is measured yet. */
export async function measuresFor(connectionId: string): Promise<BookingMeasures | null> {
  const [conn] = await db.select().from(connections).where(eq(connections.id, connectionId));
  if (!conn) return null;
  const asOf = await latestMeasuredDay(conn.id);
  if (asOf === null) return null;
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, conn.account_id));
  return bookingMeasures(await measuredAppointments(db, conn.id), asOf, {
    lateSeparated: lateSeparated(conn.provider),
    capacityPerWeek: profile ? await statedCapacity(profile.id) : null,
    sourceName: conn.provider === "square" ? "Square" : "your bookings export",
  });
}

/**
 * The 28-day measures as profile facts. A measure that can't be computed
 * honestly is a refusal with its reason, and the owner's figure stays.
 * Returns [] for a connection with no bookings at all.
 */
export async function deriveBookingFacts(
  connectionId: string,
  now = new Date(),
): Promise<DeriveOutcome[]> {
  const [conn] = await db.select().from(connections).where(eq(connections.id, connectionId));
  if (!conn) return [];
  const asOf = await latestMeasuredDay(conn.id);
  if (asOf === null) return [];
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, conn.account_id));
  if (!profile) return [];

  const m = bookingMeasures(await measuredAppointments(db, conn.id), asOf, {
    lateSeparated: lateSeparated(conn.provider),
    capacityPerWeek: await statedCapacity(profile.id),
    sourceName: conn.provider === "square" ? "Square" : "your bookings export",
  });
  const from = await provenance(conn);
  const recordedAt = isoDateTime(now.toISOString());
  const window: DeriveWindow = { from: isoDate(m.from), to: isoDate(m.to) };
  const series = (...metrics: MetricKey[]) => metrics;
  const outcomes: DeriveOutcome[] = [];

  const write = async (
    fieldKey: string,
    value: unknown,
    metrics: MetricKey[],
    arithmetic: string,
    span: DeriveWindow = window,
  ) =>
    outcomes.push(
      await writeMeasured({
        profileId: profile.id,
        fieldKey,
        value,
        provider: conn.provider,
        metrics,
        method: `${arithmetic}; over ${span.from}..${span.to} from ${from} (connection ${conn.id})`,
        window: span,
        recordedAt,
        note: `Measured from ${from}, ${span.from} to ${span.to}.`,
      }),
    );
  const refuse = (fieldKey: string, reason: string) =>
    outcomes.push({ field_key: fieldKey, outcome: "refused", reason });

  await write(
    BOOKING_FACT_KEYS.completed,
    m.completed,
    series("appointments_completed.daily"),
    `count of completed appointments`,
  );

  const counts = series(
    "appointments_completed.daily",
    "appointments_no_show.daily",
    ...(m.late_cancellations === null ? [] : series("appointments_cancelled_late.daily")),
  );
  if (m.no_show_rate.status === "measured") {
    await write(
      BOOKING_FACT_KEYS.noShowRate,
      m.no_show_rate.value,
      counts,
      m.no_show_rate.arithmetic,
    );
    const late =
      m.late_cancellation_rate.status === "measured"
        ? ` and ${m.late_cancellation_rate.value}% late cancellations`
        : " (Square counts late cancellations among them)";
    await write(
      BOOKING_FACT_KEYS.noShowWords,
      `${m.no_show_rate.value}% no-shows${late}, of ${m.due} due appointments, ${m.from} to ${m.to}`,
      counts,
      m.no_show_rate.arithmetic,
    );
  } else {
    refuse(BOOKING_FACT_KEYS.noShowRate, m.no_show_rate.reason);
    refuse(BOOKING_FACT_KEYS.noShowWords, m.no_show_rate.reason);
  }
  if (m.late_cancellation_rate.status === "measured") {
    await write(
      BOOKING_FACT_KEYS.lateRate,
      m.late_cancellation_rate.value,
      counts,
      m.late_cancellation_rate.arithmetic,
    );
  } else {
    refuse(BOOKING_FACT_KEYS.lateRate, m.late_cancellation_rate.reason);
  }
  if (m.rebooking_rate.status === "measured") {
    const cohortFrom = shiftDate(m.to, -(REBOOK_SPAN - 1));
    await write(
      BOOKING_FACT_KEYS.rebooking,
      m.rebooking_rate.value,
      series("appointments_completed.daily"),
      m.rebooking_rate.arithmetic,
      { from: isoDate(cohortFrom), to: isoDate(m.to) },
    );
  } else {
    refuse(BOOKING_FACT_KEYS.rebooking, m.rebooking_rate.reason);
  }
  if (m.revenue.status === "measured") {
    await write(
      BOOKING_FACT_KEYS.revenue,
      m.revenue.value,
      series("booking_revenue.daily"),
      m.revenue.arithmetic,
    );
  } else {
    refuse(BOOKING_FACT_KEYS.revenue, m.revenue.reason);
  }
  if (m.utilisation.status === "measured") {
    await write(
      BOOKING_FACT_KEYS.utilisation,
      m.utilisation.value,
      series("appointments_completed.daily"),
      m.utilisation.arithmetic,
    );
  } else {
    refuse(BOOKING_FACT_KEYS.utilisation, m.utilisation.reason);
  }
  return outcomes;
}

/** The rebooking fact spans its cohort and the follow-up after it. */
const REBOOK_SPAN = BOOKING_WINDOW_DAYS + REBOOK_DAYS;

/* ── the screen ── */

export interface BookingsView {
  imports: {
    id: string;
    platform: string;
    platform_label: string;
    currency: string | null;
    imported_at: string;
    rows_read: number;
    added: number;
    updated: number;
    unchanged: number;
    skipped: Record<string, number>;
    columns: Record<string, string>;
  }[];
  /** Appointments stored, by source. */
  stored: { source: "import" | "square"; appointments: number }[];
  measures: { source: "import" | "square"; measures: BookingMeasures }[];
}

export async function bookingsView(accountId: string): Promise<BookingsView> {
  const conns = await db
    .select()
    .from(connections)
    .where(and(eq(connections.account_id, accountId), eq(connections.purpose, "measure")));
  const sources = conns.filter(
    (c) => c.provider === BOOKINGS_IMPORT_PROVIDER || c.provider === "square",
  );
  const imports = await db
    .select()
    .from(bookingImports)
    .where(eq(bookingImports.account_id, accountId))
    .orderBy(desc(bookingImports.imported_at))
    .limit(10);
  const view: BookingsView = {
    imports: imports.map((b) => ({
      id: b.id,
      platform: b.platform,
      platform_label: platformLabel(b.platform as BookingPlatform),
      currency: b.currency,
      imported_at: b.imported_at,
      rows_read: b.rows_read,
      added: b.added,
      updated: b.updated,
      unchanged: b.unchanged,
      skipped: b.skipped,
      columns: b.columns,
    })),
    stored: [],
    measures: [],
  };
  for (const c of sources) {
    const source = c.provider === "square" ? "square" : "import";
    const rows = await db
      .select({ id: bookingAppointments.id })
      .from(bookingAppointments)
      .where(eq(bookingAppointments.connection_id, c.id));
    if (rows.length === 0) continue;
    view.stored.push({ source, appointments: rows.length });
    const m = await measuresFor(c.id);
    if (m) view.measures.push({ source, measures: m });
  }
  return view;
}
