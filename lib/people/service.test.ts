// P6-06 against the real database (rule 28 amended; rule 22). A salon's
// export with a "Team member" column goes through the real import (parse →
// stored appointments, the name on each row as staff_ref), and the
// per-person view reads it back. With the team module off nothing is read.
// The owner states one person's capacity; then removes a person: the name
// leaves every appointment and every stored person field, the business's
// own measures don't move, and re-importing the same export doesn't bring
// the name back. The network is never touched.

import "dotenv/config";

import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accountModules,
  bookingAppointments,
  decisionLog,
  staffErasures,
  staffPeople,
} from "../../db/schema";
import { BOOKINGS_IMPORT_PROVIDER } from "../bookings/source";
import { bookingMeasures, shiftDate } from "../bookings/measures";
import { importBookings, storeAppointments } from "../bookings/store";
import { bootstrapIntake } from "../intake/service";
import { TEAM_MODULE } from "../team/module";
import { PeopleError, peopleView, readCapacity, removePerson, stateCapacity } from "./service";
import { staffKey } from "./staff-key";

const NOW = new Date("2026-11-08T09:00:00Z");
const YESTERDAY = "2026-11-07";

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network was called");
  });
});
afterEach(() => vi.unstubAllGlobals());

/** Thirty days of a three-stylist salon: 2 appointments a day each, a no-show every fifth. */
function exportCsv(): string {
  const lines = ["Ref #,Scheduled date,Time,Status,Service,Team member,Client email,Price"];
  let n = 0;
  for (let d = 1; d <= 30; d++) {
    const day = shiftDate(YESTERDAY, -(d - 1));
    for (const who of ["Sinead", "aoife", "Marta"]) {
      for (let k = 0; k < 2; k++) {
        n++;
        const status = n % 5 === 0 ? "No-show" : "Completed";
        lines.push(
          `R-${n},${day},${10 + k}:00,${status},Cut,${who},client${n % 40}@example.test,45.00`,
        );
      }
    }
  }
  return lines.join("\n");
}

async function salon(on: boolean) {
  const boot = await bootstrapIntake();
  if (on) {
    await db
      .insert(accountModules)
      .values({ account_id: boot.account_id, module: TEAM_MODULE, enabled: true });
  }
  await importBookings(
    boot.account_id,
    exportCsv(),
    { platform: "fresha", currency: "EUR", dateOrder: null },
    NOW,
  );
  return boot;
}

async function storedNames(accountId: string): Promise<(string | null)[]> {
  const rows = await db
    .select({ staff_ref: bookingAppointments.staff_ref })
    .from(bookingAppointments)
    .where(eq(bookingAppointments.account_id, accountId));
  return rows.map((r) => r.staff_ref);
}

async function businessMeasures(accountId: string) {
  const rows = await db
    .select({
      day: bookingAppointments.day,
      status: bookingAppointments.status,
      client_key: bookingAppointments.client_key,
      price_minor: bookingAppointments.price_minor,
      currency: bookingAppointments.currency,
    })
    .from(bookingAppointments)
    .where(eq(bookingAppointments.account_id, accountId));
  return bookingMeasures(rows, YESTERDAY, {
    lateSeparated: true,
    capacityPerWeek: null,
    sourceName: "your bookings export",
  });
}

describe("the staff column, from the export to the stored appointment", () => {
  it("keeps each row's team member as written", async () => {
    const boot = await salon(false);
    const names = await storedNames(boot.account_id);
    expect(names).toHaveLength(180);
    expect(new Set(names)).toEqual(new Set(["Sinead", "aoife", "Marta"]));
  });
});

describe("the team module's switch (rule 28): off by default", () => {
  it("reads nothing and shows nothing per person while it is off", async () => {
    const boot = await salon(false);
    expect(await peopleView(boot.account_id, NOW)).toEqual({ enabled: false });
  });

  it("refuses to take a capacity while it is off", async () => {
    const boot = await salon(false);
    await expect(stateCapacity(boot.account_id, null, "Marta", 30, NOW)).rejects.toMatchObject({
      reason: "module_off",
    });
  });
});

describe("each person's own figures, with the module on", () => {
  it("lists the three alphabetically, with the window, the source and the counts", async () => {
    const boot = await salon(true);
    const view = await peopleView(boot.account_id, NOW);
    if (!view.enabled || view.status !== "ok") throw new Error("expected figures");
    expect(view.source).toEqual({ kind: "import", platform: "Fresha" });
    expect(view.sales_by_person).toBe(false);
    expect([view.figures.from, view.figures.to]).toEqual([shiftDate(YESTERDAY, -27), YESTERDAY]);
    expect(view.figures.people.map((p) => p.person)).toEqual(["aoife", "Marta", "Sinead"]);
    for (const p of view.figures.people) {
      expect(p.appointments).toBe(56);
      expect(p.revenue.status).toBe("measured");
      expect(p.no_show_rate.status).toBe("measured");
      expect(p.utilisation).toEqual({ status: "unmeasured", why: "no_capacity" });
    }
  });

  it("measures utilisation once the owner states a person's capacity, with who and when", async () => {
    const boot = await salon(true);
    await stateCapacity(boot.account_id, null, "Marta", 14, NOW);
    const view = await peopleView(boot.account_id, NOW);
    if (!view.enabled || view.status !== "ok") throw new Error("expected figures");
    const marta = view.figures.people.find((p) => p.person === "Marta");
    expect(marta?.capacity).toEqual({ per_week: 14, stated_at: expect.any(String) });
    expect(marta?.utilisation).toMatchObject({ status: "measured", of: 56 });
    expect(view.figures.people.find((p) => p.person === "aoife")?.utilisation.status).toBe(
      "unmeasured",
    );
    await stateCapacity(boot.account_id, null, "Marta", null, NOW);
    const cleared = await db
      .select()
      .from(staffPeople)
      .where(eq(staffPeople.account_id, boot.account_id));
    expect(cleared).toEqual([]);
  });

  it("refuses a capacity for a name the bookings never recorded, or out of bounds", async () => {
    const boot = await salon(true);
    await expect(stateCapacity(boot.account_id, null, "Nobody", 10, NOW)).rejects.toBeInstanceOf(
      PeopleError,
    );
    expect(readCapacity(0)).toBeUndefined();
    expect(readCapacity(1001)).toBeUndefined();
    expect(readCapacity(2.5)).toBeUndefined();
    expect(readCapacity("12")).toBeUndefined();
    expect(readCapacity(1)).toBe(1);
    expect(readCapacity(1000)).toBe(1000);
    expect(readCapacity(null)).toBeNull();
  });
});

describe("rule 22: removing a person", () => {
  it("erases their name and stored fields, keeps the business's totals, and survives a re-import", async () => {
    const boot = await salon(true);
    await stateCapacity(boot.account_id, null, "aoife", 20, NOW);
    const before = await businessMeasures(boot.account_id);

    // Any spelling that normalises the same is the same person.
    const out = await removePerson(boot.account_id, boot.profile_id, null, " AOIFE ");
    expect(out.appointments).toBe(60);

    const names = await storedNames(boot.account_id);
    expect(names).toHaveLength(180);
    expect(names.filter((n) => n === null)).toHaveLength(60);
    expect(names).not.toContain("aoife");
    expect(
      await db.select().from(staffPeople).where(eq(staffPeople.account_id, boot.account_id)),
    ).toEqual([]);
    expect(await businessMeasures(boot.account_id)).toEqual(before);

    const view = await peopleView(boot.account_id, NOW);
    if (!view.enabled || view.status !== "ok") throw new Error("expected figures");
    expect(view.figures.people.map((p) => p.person)).toEqual(["Marta", "Sinead"]);
    expect(view.figures.unattributed).toBe(56);

    // Remembered as a keyed hash only, and logged without the name.
    const [erasure] = await db
      .select()
      .from(staffErasures)
      .where(eq(staffErasures.account_id, boot.account_id));
    expect(erasure?.staff_key).toBe(staffKey(boot.account_id, "aoife"));
    const log = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, boot.profile_id), eq(decisionLog.kind, "erasure")));
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log).toLowerCase()).not.toContain("aoife");

    // The usual overlapping export, imported again: the name stays gone, nothing doubles.
    const again = await importBookings(
      boot.account_id,
      exportCsv(),
      { platform: "fresha", currency: "EUR", dateOrder: null },
      NOW,
    );
    expect(again.added).toBe(0);
    expect(again.unchanged).toBe(180);
    expect((await storedNames(boot.account_id)).filter((n) => n === null)).toHaveLength(60);
    expect(await businessMeasures(boot.account_id)).toEqual(before);
  });

  it("holds for a sync's appointments too (Square writes through the same store)", async () => {
    const boot = await salon(true);
    await removePerson(boot.account_id, boot.profile_id, null, "Marta");
    const [conn] = await db
      .select({ id: bookingAppointments.connection_id })
      .from(bookingAppointments)
      .where(eq(bookingAppointments.account_id, boot.account_id))
      .limit(1);
    if (!conn) throw new Error("no connection");
    const input = {
      source_ref: "square:new-1",
      day: YESTERDAY,
      start_time: "15:00",
      status: "completed" as const,
      service: "Cut",
      client: null,
      duration_minutes: 30,
      price_minor: null,
      currency: null,
    };
    const store = (staff_ref: string) =>
      db.transaction((tx) =>
        storeAppointments(
          tx,
          { id: conn.id, account_id: boot.account_id, provider: BOOKINGS_IMPORT_PROVIDER },
          [{ ...input, source_ref: `square:${staff_ref}`, staff_ref }],
          { batchId: null, scope: "square" },
        ),
      );
    await store("marta");
    await store("Sinead");
    const rows = await db
      .select({ ref: bookingAppointments.source_ref, staff: bookingAppointments.staff_ref })
      .from(bookingAppointments)
      .where(eq(bookingAppointments.connection_id, conn.id));
    expect(rows.find((r) => r.ref === "square:marta")?.staff).toBeNull();
    expect(rows.find((r) => r.ref === "square:Sinead")?.staff).toBe("Sinead");
  });

  it("refuses a person the bookings never recorded", async () => {
    const boot = await salon(true);
    await expect(
      removePerson(boot.account_id, boot.profile_id, null, "Nobody"),
    ).rejects.toMatchObject({ reason: "unknown_person", status: 404 });
  });
});
