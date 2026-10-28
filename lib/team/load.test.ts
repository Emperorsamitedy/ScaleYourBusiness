// P5-18/P5-19 against the real database: the team module is off by
// default and, while off, nothing is read or computed; switched on, the
// loader hands coverage only a booking's day, start time and status and a
// role's title and hours — so names in the team-member column, the client
// column or a role's tasks never reach the output. The network is never
// touched: global fetch fails.

import "dotenv/config";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { accountModules, bookingAppointments } from "../../db/schema";
import { CAPACITY_KEY, ensureImportConnection } from "../bookings/store";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { CoverageInput } from "./coverage";
import { teamCoverage } from "./coverage";
import { STAFF_KEY, teamView } from "./load";
import { TEAM_MODULE, teamModuleOn, teamOnFrom } from "./module";

const NOW = new Date("2026-10-25T09:00:00Z"); // a Sunday: yesterday is a Saturday
const DAY_MS = 86_400_000;
const day = (n: number) => new Date(NOW.getTime() - n * DAY_MS).toISOString().slice(0, 10);
const connectionIds: string[] = [];
const accountIds: string[] = [];

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network was called");
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  for (const id of connectionIds) {
    await db.delete(bookingAppointments).where(eq(bookingAppointments.connection_id, id));
  }
  for (const id of accountIds) {
    await db.delete(accountModules).where(eq(accountModules.account_id, id));
  }
});

async function fact(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(NOW.toISOString());
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

async function setTeam(accountId: string, enabled: boolean) {
  await db
    .insert(accountModules)
    .values({ account_id: accountId, module: TEAM_MODULE, enabled })
    .onConflictDoUpdate({
      target: [accountModules.account_id, accountModules.module],
      set: { enabled },
    });
}

/** A studio with eight weeks of Saturday bookings, named staff and clients, and two named roles. */
async function studio(staff: readonly string[]) {
  const boot = await bootstrapIntake();
  accountIds.push(boot.account_id);
  await fact(boot.profile_id, CAPACITY_KEY, 25);
  const [a, b] = [randomUUID(), randomUUID()];
  await fact(boot.profile_id, STAFF_KEY, { entity_ids: [a, b] });
  await fact(boot.profile_id, `operations.${a}.role_title`, "Teacher");
  await fact(boot.profile_id, `operations.${a}.hours_per_week`, 3);
  await fact(boot.profile_id, `operations.${a}.main_tasks`, `${staff[0]} teaches the wheel`);
  await fact(boot.profile_id, `operations.${b}.role_title`, "Teacher");
  await fact(boot.profile_id, `operations.${b}.hours_per_week`, 1);
  await fact(boot.profile_id, `operations.${b}.main_tasks`, `${staff[1]} covers lunch`);
  const conn = await ensureImportConnection(boot.account_id);
  connectionIds.push(conn.id);
  const rows: (typeof bookingAppointments.$inferInsert)[] = [];
  for (let week = 0; week < 8; week++) {
    const d = day(1 + week * 7);
    for (let h = 10; h < 14; h++) {
      for (let k = 0; k < 7; k++) {
        rows.push({
          account_id: boot.account_id,
          connection_id: conn.id,
          source_ref: `t-${d}-${h}-${k}`,
          day: d,
          start_time: `${h}:${k % 2 ? "30" : "00"}`,
          status: "completed",
          service: "Wheel class",
          staff_ref: staff[k % staff.length] ?? null,
          client_key: `${staff[0]}-client-${k}`,
          duration_minutes: 60,
          price_minor: 4500,
          currency: "EUR",
        });
      }
    }
  }
  await db.insert(bookingAppointments).values(rows);
  return boot;
}

describe("P5-18 — the team module switch", () => {
  it("is off from rows: missing is off, a row decides", () => {
    expect(teamOnFrom([])).toBe(false);
    expect(teamOnFrom([{ module: "marketing", enabled: true }])).toBe(false);
    expect(teamOnFrom([{ module: TEAM_MODULE, enabled: true }])).toBe(true);
    expect(teamOnFrom([{ module: TEAM_MODULE, enabled: false }])).toBe(false);
  });

  it("is off by default, and while off reads and computes nothing", async () => {
    const boot = await studio(["Aoife", "Sinead"]);
    const compute = vi.fn(teamCoverage);
    expect(await teamModuleOn(boot.account_id)).toBe(false);
    expect(await teamView(boot.account_id, boot.profile_id, NOW, compute)).toEqual({
      enabled: false,
    });
    await setTeam(boot.account_id, false);
    expect(await teamView(boot.account_id, boot.profile_id, NOW, compute)).toEqual({
      enabled: false,
    });
    expect(compute).not.toHaveBeenCalled();

    await setTeam(boot.account_id, true);
    const on = await teamView(boot.account_id, boot.profile_id, NOW, compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(on.enabled).toBe(true);
  });
});

describe("P5-19 — what the loader hands coverage", () => {
  it("reads a booking's day, start time and status, and a role's title and hours, nothing else", async () => {
    const boot = await studio(["Aoife", "Sinead"]);
    await setTeam(boot.account_id, true);
    let seen: CoverageInput | null = null;
    await teamView(boot.account_id, boot.profile_id, NOW, (input) => {
      seen = input;
      return teamCoverage(input);
    });
    const input = seen as CoverageInput | null;
    expect(input?.bookings?.slots.length).toBe(8 * 4 * 7);
    for (const s of input?.bookings?.slots ?? []) {
      expect(Object.keys(s).sort()).toEqual(["day", "start_time", "status"]);
    }
    expect(input?.roles).toEqual([
      { role_title: "Teacher", hours_per_week: 3 },
      { role_title: "Teacher", hours_per_week: 1 },
    ]);
    expect(input?.capacityPerWeek).toBe(25);
    expect(input?.asOf).toBe(day(1));
  });

  it("gives byte-identical output whoever the bookings and tasks name", async () => {
    const first = await studio(["Aoife", "Sinead"]);
    const second = await studio(["Marta", "Niamh"]);
    for (const b of [first, second]) await setTeam(b.account_id, true);
    const a = await teamView(first.account_id, first.profile_id, NOW);
    const b = await teamView(second.account_id, second.profile_id, NOW);
    expect(a.enabled && a.result.status).toBe("ok");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const n of ["Aoife", "Sinead", "Marta", "Niamh"])
      expect(JSON.stringify(a)).not.toContain(n);
    if (a.enabled && a.result.status === "ok") {
      expect(a.result.headline).toBe(
        "Saturdays 10:00–14:00 ran 112% booked; one teacher covers about 6.3 appointments an hour at your stated 25 a week.",
      );
    }
  });
});
