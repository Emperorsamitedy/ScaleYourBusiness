// Bookings, stored and measured (specs/bookings.md §3–4), against the real
// database: an export becomes measured observations and facts that
// supersede the owner's words with the delta visible; a re-import never
// double-counts; no client identity is stored; the import source is never
// pulled or listed; Square's bookings arrive through the ordinary sync with
// the customer id hashed. The network is never touched: global fetch fails.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  anomalies,
  bookingAppointments,
  bookingImports,
  businessProfiles,
  connections,
  connectorSyncs,
  contactSuppressions,
  fieldRecords,
  metricObservations,
  profileSnapshots,
  watchActivity,
} from "../../db/schema";
import { overrideProviderForTests } from "../connectors/registry";
import { createSquareProvider } from "../connectors/providers/square";
import type { SquareFetch } from "../connectors/providers/square";
import { connect, listConnections } from "../connectors/service";
import { statedVsMeasured } from "../connectors/stated-vs-measured";
import { syncConnection } from "../connectors/sync";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { ensureSnapshot } from "../profile/snapshot";
import { readCurrentField, readFieldHistory, writeField } from "../profile/field-store";
import { addContact, emailHash, eraseContact } from "../crm/contacts";
import { clientKey, clientKeyCandidates } from "./client-key";
import { forgetBookingClient } from "./erase";
import {
  BOOKING_FACT_KEYS,
  CAPACITY_KEY,
  deriveBookingFacts,
  importBookings,
  measuresFor,
} from "./store";
import { BOOKINGS_IMPORT_PROVIDER } from "./source";

const NOW = new Date("2026-10-22T09:00:00Z");
const created: { account_id: string; profile_id: string }[] = [];

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network was called");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const s of created) {
    await db.delete(anomalies).where(eq(anomalies.profile_id, s.profile_id));
    await db.delete(watchActivity).where(eq(watchActivity.profile_id, s.profile_id));
    const rows = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await db.delete(bookingAppointments).where(inArray(bookingAppointments.connection_id, ids));
      await db.delete(bookingImports).where(inArray(bookingImports.connection_id, ids));
      await db.delete(metricObservations).where(inArray(metricObservations.connection_id, ids));
      await db.delete(connectorSyncs).where(inArray(connectorSyncs.connection_id, ids));
    }
    await db.delete(connections).where(eq(connections.account_id, s.account_id));
    await db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, s.profile_id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

async function scenario() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

async function ownerSays(profileId: string, key: string, value: unknown) {
  const at = isoDateTime("2026-08-01T10:00:00Z");
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note: null,
    }),
  );
}

const DAY_MS = 86_400_000;
const dayAt = (n: number) =>
  new Date(Date.UTC(2026, 6, 15) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * 99 days of a salon (2026-07-15 .. 2026-10-21), four appointments a day,
 * twelve regular clients, every 10th a no-show, every 13th a late
 * cancellation, every 9th cancelled in good time. Plus a future booking and
 * a past one never closed out.
 */
function salonExport(
  opts: { days?: number; startDay?: number; override?: Map<string, string> } = {},
) {
  const lines = ["Ref #,Scheduled date,Time,Status,Service,Team member,Client email,Client,Price"];
  const start = opts.startDay ?? 0;
  for (let d = start; d < start + (opts.days ?? 99); d++) {
    for (let k = 0; k < 4; k++) {
      const n = d * 4 + k;
      const ref = `B-${n}`;
      const status =
        opts.override?.get(ref) ??
        (n % 10 === 0
          ? "No-show"
          : n % 13 === 0
            ? "Late cancel"
            : n % 9 === 0
              ? "Cancelled"
              : "Completed");
      const client = n % 12;
      lines.push(
        `${ref},${dayAt(d)},${String(9 + k * 2).padStart(2, "0")}:00,${status},Cut,Kata,client${client}@example.com,Client Number${client},"12 500"`,
      );
    }
  }
  lines.push(
    `B-future-1,2026-10-30,10:00,Confirmed,Cut,Kata,client1@example.com,Client Number1,"12 500"`,
  );
  lines.push(
    `B-past-open,2026-10-20,10:00,Confirmed,Cut,Kata,client2@example.com,Client Number2,"12 500"`,
  );
  return lines.join("\n");
}

const REQUEST = { platform: "fresha" as const, currency: "HUF", dateOrder: null };

describe("the import", () => {
  it("reads the export, stores no identity, and counts what it left out", async () => {
    const s = await scenario();
    const out = await importBookings(s.account_id, salonExport(), REQUEST, NOW);
    expect(out.columns).toMatchObject({
      ref: "Ref #",
      date: "Scheduled date",
      time: "Time",
      status: "Status",
      service: "Service",
      staff: "Team member",
      client_email: "Client email",
      price: "Price",
    });
    expect(out.rows_read).toBe(99 * 4 + 2);
    expect(out.added).toBe(99 * 4 + 1);
    expect(out.skipped).toEqual({ not_closed_out: 1 });
    expect(out.booked_future).toBe(1);
    expect(out.identity).toBe("client_email");
    expect(out.measured_days).toEqual({ from: "2026-07-15", to: "2026-10-21" });

    const rows = await db
      .select()
      .from(bookingAppointments)
      .where(eq(bookingAppointments.account_id, s.account_id));
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("@example.com");
    expect(dump).not.toContain("Client Number");
    expect(rows.find((r) => r.source_ref === "fresha:ref:B-1")).toMatchObject({
      price_minor: 1_250_000,
      currency: "HUF",
      client_key: clientKey(s.account_id, { kind: "email", value: "client1@example.com" }, "x"),
    });
  });

  it("measured facts supersede the owner's words, which stay in history and show in the report", async () => {
    const s = await scenario();
    await ownerSays(s.profile_id, "service.no_show_rate", "a couple a week, mostly Mondays");
    await ownerSays(s.profile_id, "revenue.repeat_customer_rate", 60);
    await importBookings(s.account_id, salonExport(), REQUEST, NOW);

    const [conn] = await db
      .select()
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    const m = await measuresFor(conn!.id);
    expect(m?.from).toBe("2026-09-24");
    expect(m?.to).toBe("2026-10-21");
    expect(m?.no_show_rate.status).toBe("measured");
    expect(m?.rebooking_rate.status).toBe("measured");

    const words = await readCurrentField<string>(s.profile_id, BOOKING_FACT_KEYS.noShowWords);
    expect(words?.status).toBe("inferred");
    expect(words?.value).toMatch(/% no-shows and .*% late cancellations, of \d+ due appointments/);
    expect(words?.note).toMatch(/bookings export from Fresha, imported 2026-10-22/);
    const history = await readFieldHistory(s.profile_id, BOOKING_FACT_KEYS.noShowWords);
    expect(history.some((h) => h.field.value === "a couple a week, mostly Mondays")).toBe(true);

    const repeat = await readCurrentField<number>(s.profile_id, BOOKING_FACT_KEYS.rebooking);
    expect(repeat?.value).toBe(
      m?.rebooking_rate.status === "measured" ? m.rebooking_rate.value : null,
    );
    expect((await readCurrentField(s.profile_id, BOOKING_FACT_KEYS.revenue))?.value).toMatchObject({
      currency: "HUF",
    });
    // No stated capacity: utilisation is not a fact, and it says why.
    expect(await readCurrentField(s.profile_id, BOOKING_FACT_KEYS.utilisation)).toBeNull();

    const pairs = await statedVsMeasured((await ensureSnapshot(s.profile_id, "report")).id);
    const repeatPair = pairs.find((p) => p.field_key === "revenue.repeat_customer_rate");
    expect(repeatPair?.provider).toBe("Bookings export");
    expect(repeatPair?.stated.value).toBe(60);
    expect(repeatPair?.delta?.amount).toBeCloseTo((repeat?.value ?? 0) - 60, 5);
    const wordsPair = pairs.find((p) => p.field_key === "service.no_show_rate");
    expect(wordsPair?.stated.value).toBe("a couple a week, mostly Mondays");
    expect(wordsPair?.delta).toBeNull(); // words against a measurement: shown, not subtracted
    expect(wordsPair?.measured.method).toMatch(/over 2026-09-24\.\.2026-10-21/);
  });

  it("utilisation only once the owner has stated a weekly capacity", async () => {
    const s = await scenario();
    await importBookings(s.account_id, salonExport(), REQUEST, NOW);
    const [conn] = await db
      .select()
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    const before = await deriveBookingFacts(conn!.id, NOW);
    expect(before.find((o) => o.field_key === BOOKING_FACT_KEYS.utilisation)).toMatchObject({
      outcome: "refused",
      reason: expect.stringMatching(/won't assume a capacity/),
    });
    await ownerSays(s.profile_id, CAPACITY_KEY, 40);
    await deriveBookingFacts(conn!.id, NOW);
    const m = await measuresFor(conn!.id);
    const u = await readCurrentField<number>(s.profile_id, BOOKING_FACT_KEYS.utilisation);
    expect(u?.value).toBe(m?.utilisation.status === "measured" ? m.utilisation.value : -1);
    expect(u?.value).toBeCloseTo(((m?.completed ?? 0) / 160) * 100, 0);
  });

  it("re-importing an overlapping export never double-counts", async () => {
    const s = await scenario();
    const first = await importBookings(s.account_id, salonExport({ days: 60 }), REQUEST, NOW);
    expect(first.added).toBe(60 * 4 + 1);
    const day = dayAt(50);
    const count = async () => {
      const [conn] = await db
        .select()
        .from(connections)
        .where(eq(connections.account_id, s.account_id));
      const rows = await db
        .select()
        .from(metricObservations)
        .where(eq(metricObservations.connection_id, conn!.id));
      return rows
        .filter((r) => r.period_date === day && r.metric_key === "appointments_completed.daily")
        .map((r) => Number(r.value_num));
    };
    const completedBefore = await count();

    // The same 60 days again plus 39 new ones; one appointment changed since.
    const changed = new Map([["B-201", "No-show"]]);
    const second = await importBookings(
      s.account_id,
      salonExport({ days: 99, override: changed }),
      REQUEST,
      NOW,
    );
    expect(second.added).toBe(39 * 4);
    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(60 * 4 - 1 + 1); // the future booking is unchanged too
    const completedAfter = await count();
    expect(completedAfter).toHaveLength(1);
    expect(completedAfter[0]).toBe(
      (completedBefore[0] ?? 0) - (dayAt(50) === dayAt(Math.floor(201 / 4)) ? 1 : 0),
    );
    const stored = await db
      .select({ id: bookingAppointments.id })
      .from(bookingAppointments)
      .where(eq(bookingAppointments.account_id, s.account_id));
    expect(stored).toHaveLength(99 * 4 + 1);
  });

  it("the import source is never pulled and never listed as a connection", async () => {
    const s = await scenario();
    await importBookings(s.account_id, salonExport({ days: 10 }), REQUEST, NOW);
    expect(await listConnections(s.account_id)).toEqual([]);
    const [conn] = await db
      .select()
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    expect(conn?.provider).toBe(BOOKINGS_IMPORT_PROVIDER);
    expect(conn?.encrypted_secret).toBeNull();
    expect(conn?.granted_scopes).toEqual([]);
    expect((await syncConnection(conn!.id, NOW)).skipped).toBe("imported");
    // Skipped, not failed: no failure counted, no sync recorded against it.
    const [after] = await db.select().from(connections).where(eq(connections.id, conn!.id));
    expect(after?.failure_count).toBe(0);
    expect(after?.status).toBe("connected");
    expect(
      await db.select().from(connectorSyncs).where(eq(connectorSyncs.connection_id, conn!.id)),
    ).toEqual([]);
  });

  it("erasing a customer clears the client key their email made", async () => {
    const s = await scenario();
    await importBookings(s.account_id, salonExport({ days: 10 }), REQUEST, NOW);
    const key = clientKey(s.account_id, { kind: "email", value: " Client3@Example.com " }, "");
    const cleared = await forgetBookingClient(s.account_id, {
      email: "client3@example.com",
      phone: null,
    });
    expect(cleared).toBeGreaterThan(0);
    const rows = await db
      .select({ k: bookingAppointments.client_key })
      .from(bookingAppointments)
      .where(eq(bookingAppointments.account_id, s.account_id));
    expect(rows.some((r) => r.k === key)).toBe(false);
  });
});

describe("the client key", () => {
  it("is stable per account and identity, different across accounts, never the value", () => {
    const a = clientKey("acct-a", { kind: "email", value: "Anna@Example.com" }, "fresha");
    expect(a).toBe(clientKey("acct-a", { kind: "email", value: " anna@example.com" }, "booksy"));
    expect(a).not.toBe(clientKey("acct-b", { kind: "email", value: "anna@example.com" }, "fresha"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Ids are per system: client 42 in Fresha is not customer 42 in Square.
    expect(clientKey("acct-a", { kind: "id", value: "42" }, "fresha")).not.toBe(
      clientKey("acct-a", { kind: "id", value: "42" }, "square"),
    );
    expect(clientKey("acct-a", { kind: "email", value: "not an email" }, "x")).toBeNull();
    expect(clientKey("acct-a", { kind: "phone", value: "123" }, "x")).toBeNull();
  });
});

describe("Square bookings through the sync", () => {
  it("stores Square's bookings with the customer id hashed, and measures them", async () => {
    const s = await scenario();
    const bookings = Array.from({ length: 120 }, (_, i) => ({
      id: `bk${i}`,
      status: i % 8 === 0 ? "NO_SHOW" : i % 11 === 0 ? "CANCELLED_BY_CUSTOMER" : "ACCEPTED",
      start_at: new Date(Date.UTC(2026, 6, 20, 10) + Math.floor(i / 1.3) * DAY_MS).toISOString(),
      customer_id: `SQ-CUST-${i % 14}`,
      customer_note: "private note",
      appointment_segments: [
        { duration_minutes: 30, service_variation_id: "SV1", team_member_id: "TM1" },
      ],
    }));
    const scopes = [
      "PAYMENTS_READ",
      "MERCHANT_PROFILE_READ",
      "APPOINTMENTS_READ",
      "APPOINTMENTS_ALL_READ",
    ];
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    const fetch: SquareFetch = async (raw) => {
      const url = new URL(raw);
      if (url.pathname === "/oauth2/token/status") return json(200, { scopes });
      if (url.pathname === "/v2/locations") return json(200, { locations: [{ id: "L1" }] });
      if (url.pathname === "/v2/payments") return json(200, { payments: [] });
      if (url.pathname === "/v2/bookings") {
        const min = url.searchParams.get("start_at_min") ?? "";
        const max = url.searchParams.get("start_at_max") ?? "";
        return json(200, {
          bookings: bookings.filter((b) => b.start_at >= min && b.start_at < max),
        });
      }
      return json(404, {});
    };
    const restore = overrideProviderForTests(
      "square",
      createSquareProvider({ fetch, sleep: async () => {} }),
    );
    try {
      const conn = await connect(
        s.account_id,
        "square",
        JSON.stringify({ access_token: "EAAAl-fake-production-token-0123456789" }),
      );
      expect(conn.granted_scopes).toEqual([...scopes].sort());
      const outcome = await syncConnection(conn.id, NOW);
      expect(outcome.ok).toBe(true);

      const rows = await db
        .select()
        .from(bookingAppointments)
        .where(eq(bookingAppointments.connection_id, conn.id));
      expect(rows.length).toBe(bookings.length - 0);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain("SQ-CUST");
      expect(dump).not.toContain("private note");
      expect(rows[0]?.client_key).toMatch(/^[0-9a-f]{64}$/);

      const late = outcome.derived.find((d) => d.field_key === BOOKING_FACT_KEYS.lateRate);
      expect(late).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/Square/) });
      const noShow = outcome.derived.find((d) => d.field_key === BOOKING_FACT_KEYS.noShowRate);
      expect(noShow?.outcome).toBe("written");
      const words = await readCurrentField<string>(s.profile_id, BOOKING_FACT_KEYS.noShowWords);
      expect(words?.value).toMatch(/Square counts late cancellations among them/);

      // A second sync re-reads the tail and changes nothing.
      const again = await syncConnection(conn.id, NOW);
      expect(again.ok).toBe(true);
      const after = await db
        .select({ id: bookingAppointments.id })
        .from(bookingAppointments)
        .where(eq(bookingAppointments.connection_id, conn.id));
      expect(after).toHaveLength(rows.length);
    } finally {
      restore();
    }
  });
});

describe("erasure survives a re-import (review 2026-10-23, #3, #11)", () => {
  const keysOf = async (accountId: string) =>
    (
      await db
        .select({ k: bookingAppointments.client_key, ref: bookingAppointments.source_ref })
        .from(bookingAppointments)
        .where(eq(bookingAppointments.account_id, accountId))
    ).map((r) => r.k);
  const cleanup = async (accountId: string) => {
    await db.delete(contactSuppressions).where(eq(contactSuppressions.account_id, accountId));
  };

  it("erase, then re-import the usual export: the client's rows stay unlinked", async () => {
    const s = await scenario();
    try {
      await importBookings(s.account_id, salonExport({ days: 10 }), REQUEST, NOW);
      const key = clientKey(s.account_id, { kind: "email", value: "client3@example.com" }, "");
      expect((await keysOf(s.account_id)).filter((k) => k === key).length).toBeGreaterThan(0);

      const contact = await addContact(s.account_id, {
        email: "client3@example.com",
        consent: { status: "unsure", source: "test fixture" },
      });
      await eraseContact(s.account_id, contact.id);
      expect((await keysOf(s.account_id)).includes(key)).toBe(false);

      const again = await importBookings(s.account_id, salonExport({ days: 10 }), REQUEST, NOW);
      expect((await keysOf(s.account_id)).includes(key)).toBe(false);
      expect(again.gaps.client_erased).toBeGreaterThan(0);
      expect(again.added).toBe(0);
      // Every other client is still linked.
      const other = clientKey(s.account_id, { kind: "email", value: "client4@example.com" }, "");
      expect((await keysOf(s.account_id)).includes(other)).toBe(true);
    } finally {
      await cleanup(s.account_id);
    }
  });

  it("an unsubscribed address is never linked by an import", async () => {
    const s = await scenario();
    try {
      await db.insert(contactSuppressions).values({
        account_id: s.account_id,
        email_hash: emailHash("client5@example.com"),
        reason: "unsubscribed",
      });
      const out = await importBookings(s.account_id, salonExport({ days: 10 }), REQUEST, NOW);
      const key = clientKey(s.account_id, { kind: "email", value: "client5@example.com" }, "");
      expect((await keysOf(s.account_id)).includes(key)).toBe(false);
      expect(out.gaps.client_erased).toBeGreaterThan(0);
    } finally {
      await cleanup(s.account_id);
    }
  });

  it("a phone-keyed export without references: erased stays erased, and the row keys never move", async () => {
    const s = await scenario();
    const csv = [
      "Date,Time,Status,Service,Phone",
      "2026-10-01,10:00,Completed,Cut,+36 30 123 4567",
      "2026-10-01,10:00,Completed,Cut,+36 30 765 4321",
      "2026-10-02,11:00,No-show,Colour,+36 30 123 4567",
    ].join("\n");
    const generic = { platform: "generic" as const, currency: null, dateOrder: null };
    const refs = async () =>
      (
        await db
          .select({ ref: bookingAppointments.source_ref, k: bookingAppointments.client_key })
          .from(bookingAppointments)
          .where(eq(bookingAppointments.account_id, s.account_id))
      )
        .map((r) => r.ref)
        .sort();
    await importBookings(s.account_id, csv, generic, NOW);
    const before = await refs();
    expect(before).toHaveLength(3);
    // Two clients in one slot: numbered, never told apart by their key.
    expect(before.filter((r) => r.endsWith(":1"))).toHaveLength(2);
    expect(before.filter((r) => r.endsWith(":2"))).toHaveLength(1);

    const key = clientKey(s.account_id, { kind: "phone", value: "+36301234567" }, "");
    await forgetBookingClient(s.account_id, { email: null, phone: "+36 30 123 4567" });
    const again = await importBookings(s.account_id, csv, generic, NOW);
    expect(again.added).toBe(0);
    expect(await refs()).toEqual(before);
    expect((await keysOf(s.account_id)).includes(key)).toBe(false);
    expect(again.gaps.client_erased).toBe(2);
  });

  it("migration 0053 re-keys old content refs exactly as the reader now keys them", async () => {
    const s = await scenario();
    const csv = [
      "Date,Time,Status,Service,Staff,Email",
      "2026-10-01,10:00,Completed,Cut,Kata,anna@example.com",
      "2026-10-01,10:00,Completed,Cut,Kata,bea@example.com",
      "2026-10-03,,Completed,Colour,,cili@example.com",
    ].join("\n");
    await importBookings(
      s.account_id,
      csv,
      { platform: "generic", currency: null, dateOrder: null },
      NOW,
    );
    const rows = await db
      .select({ id: bookingAppointments.id, ref: bookingAppointments.source_ref })
      .from(bookingAppointments)
      .where(eq(bookingAppointments.account_id, s.account_id));
    const truth = new Map(rows.map((r) => [r.id, r.ref]));
    // Put them back into the old form: a different 32-hex content, numbered 1 each.
    for (const [i, r] of rows.entries()) {
      await db
        .update(bookingAppointments)
        .set({ source_ref: `generic:k:${String(i).padStart(32, "a")}:1` })
        .where(eq(bookingAppointments.id, r.id));
    }
    const migration = readFileSync(
      fileURLToPath(new URL("../../db/migrations/0053_optimal_randall_flagg.sql", import.meta.url)),
      "utf8",
    );
    const statements = migration.split("--> statement-breakpoint").slice(-2);
    for (const statement of statements) await db.execute(sql.raw(statement));
    const after = await db
      .select({ id: bookingAppointments.id, ref: bookingAppointments.source_ref })
      .from(bookingAppointments)
      .where(eq(bookingAppointments.account_id, s.account_id));
    expect(after.map((r) => r.ref).sort()).toEqual([...truth.values()].sort());
    // And the slot shared by two clients still holds two distinct refs.
    expect(new Set(after.map((r) => r.ref)).size).toBe(3);
  });
});

describe("the client key's own derivation (review 2026-10-23, #11)", () => {
  it("is HKDF over CONNECTOR_KEY alone: setting COOKIE_SECRET later changes nothing", () => {
    const id = { kind: "email" as const, value: "anna@example.com" };
    const saved = process.env.COOKIE_SECRET;
    try {
      delete process.env.COOKIE_SECRET;
      const before = clientKey("acct-a", id, "");
      expect(clientKeyCandidates("acct-a", id, "")).toEqual([before]);
      process.env.COOKIE_SECRET = "set-later-0123456789abcdef0123456789abcdef";
      expect(clientKey("acct-a", id, "")).toBe(before);
      // Erasure also tries the key rows made while COOKIE_SECRET was set carry.
      const candidates = clientKeyCandidates("acct-a", id, "");
      expect(candidates).toHaveLength(2);
      expect(candidates[0]).toBe(before);
      expect(candidates[1]).not.toBe(before);
    } finally {
      if (saved === undefined) delete process.env.COOKIE_SECRET;
      else process.env.COOKIE_SECRET = saved;
    }
  });
});
