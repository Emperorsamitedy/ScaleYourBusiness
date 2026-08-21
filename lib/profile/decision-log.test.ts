// Session G — the append-only decision log against live Postgres.
// P0-33 rejected at the database level · P0-34 every change logged · P0-35 update throws

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, decisionLog, fieldRecords } from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { money } from "../core/money";
import type { Money } from "../core/money";
import { hashFieldPayload, writeField } from "./field-store";

let accountId: string;
let profileId: string;

beforeAll(async () => {
  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: "HUF", locale: "hu-HU" })
    .returning();
  if (!account) throw new Error("account insert failed");
  accountId = account.id;
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: accountId, schema_version: "1.0.0" })
    .returning();
  if (!profile) throw new Error("profile insert failed");
  profileId = profile.id;
});

afterAll(async () => {
  // decision_log rows deliberately stay — the audit trail outlives its subject.
  await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profileId));
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

function pgError(error: unknown): { code?: string; message?: string } {
  return (error as { cause?: { code?: string; message?: string } }).cause ?? {};
}

describe("P0-33 + P0-35 — the database rejects every mutation of the log", () => {
  it("rejects UPDATE with the append-only error", async () => {
    try {
      await db.update(decisionLog).set({ ref_id: "tampered" });
      expect.fail("UPDATE must throw");
    } catch (error) {
      expect(pgError(error).message).toMatch(/append-only: UPDATE is not permitted/);
    }
  });

  it("rejects DELETE with the append-only error", async () => {
    try {
      await db.delete(decisionLog);
      expect.fail("DELETE must throw");
    } catch (error) {
      expect(pgError(error).message).toMatch(/append-only: DELETE is not permitted/);
    }
  });

  it("rejects TRUNCATE too — it bypasses row triggers, so a statement trigger blocks it", async () => {
    try {
      await db.execute("TRUNCATE decision_log");
      expect.fail("TRUNCATE must throw");
    } catch (error) {
      expect(pgError(error).message).toMatch(/append-only: TRUNCATE is not permitted/);
    }
  });
});

describe("P0-34 — every profile change writes an entry, atomically", () => {
  it("writeField leaves a profile_change entry pointing at the new record, hash matching", async () => {
    const field = createField<Money>({
      id: fieldId("revenue.monthly_revenue"),
      value: money(420_000_000, "HUF"),
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: isoDateTime("2026-08-20T10:00:00.000Z"),
      recorded_at: isoDateTime(new Date().toISOString()),
      note: null,
    });
    const recordId = await writeField(profileId, field);

    const entries = await db
      .select()
      .from(decisionLog)
      .where(eq(decisionLog.profile_id, profileId));
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.kind).toBe("profile_change");
    expect(entry?.actor).toBe("owner"); // owner_input → owner
    expect(entry?.ref_id).toBe(recordId);
    expect(entry?.payload_hash).toBe(hashFieldPayload(profileId, field));
  });

  it("a system-sourced write logs actor system, and a supersession logs a second entry", async () => {
    const inferred = createField<number>({
      id: fieldId("costs.gross_margin"),
      value: 0.31,
      status: "inferred",
      confidence: 0.675,
      source: {
        kind: "inferred",
        derived_from: [fieldId("revenue.monthly_revenue")],
        method: "gross_margin = (revenue - cogs) / revenue",
      },
      observed_at: isoDateTime("2026-08-20T10:00:00.000Z"),
      recorded_at: isoDateTime(new Date().toISOString()),
      note: null,
    });
    await writeField(profileId, inferred);
    await writeField(profileId, { ...inferred, value: 0.29 });

    const entries = await db
      .select()
      .from(decisionLog)
      .where(eq(decisionLog.profile_id, profileId));
    // one from the previous test + two from this one
    expect(entries).toHaveLength(3);
    expect(entries.filter((e) => e.actor === "system")).toHaveLength(2);
  });
});
