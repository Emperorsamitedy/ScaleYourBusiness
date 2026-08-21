// Session E — supersession against live Postgres.
// P0-26 write-marks · P0-27 default read · P0-28 history chain · P0-29 price ×3

import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords } from "../../db/schema";
import { createField } from "../core/field";
import type { Field } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { Money } from "../core/money";
import { money } from "../core/money";
import { readCurrentField, readFieldHistory, writeField } from "./field-store";

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
  await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profileId));
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

function priceField(amountMinor: number, observedAt: string): Field<Money> {
  return createField<Money>({
    id: fieldId("revenue.average_order_value"),
    value: money(amountMinor, "HUF"),
    status: "answered",
    confidence: 0.75,
    source: { kind: "owner_input" },
    observed_at: isoDateTime(observedAt),
    recorded_at: isoDateTime(new Date().toISOString()),
    note: null,
  });
}

describe("P0-26 — a write marks the previous record, never updates it", () => {
  it("second write leaves two rows: old one superseded and pointing at its successor", async () => {
    const firstId = await writeField(profileId, priceField(500_000, "2026-06-01T00:00:00Z"));
    const secondId = await writeField(profileId, priceField(575_000, "2026-08-01T00:00:00Z"));

    const rows = await db
      .select()
      .from(fieldRecords)
      .where(
        and(
          eq(fieldRecords.profile_id, profileId),
          eq(fieldRecords.field_key, "revenue.average_order_value"),
        ),
      );
    expect(rows).toHaveLength(2);

    const first = rows.find((r) => r.id === firstId);
    const second = rows.find((r) => r.id === secondId);
    // The old record: intact value, marked superseded, chained forward.
    expect(first?.value).toEqual({ amount_minor: 500_000, currency: "HUF" });
    expect(first?.superseded_at).not.toBeNull();
    expect(first?.superseded_by).toBe(secondId);
    // The new record is the only current one.
    expect(second?.superseded_at).toBeNull();
    expect(second?.superseded_by).toBeNull();
  });

  it("the database itself refuses a second current record for the same key", async () => {
    try {
      await db.insert(fieldRecords).values({
        profile_id: profileId,
        section: "revenue",
        field_key: "revenue.average_order_value",
        value: { amount_minor: 1, currency: "HUF" },
        status: "answered",
        confidence: "0.750",
        source: { kind: "owner_input" },
        observed_at: new Date().toISOString(),
      });
      expect.fail("insert of a second current record must violate the partial unique index");
    } catch (error) {
      // Drizzle wraps the pg error; 23505 = unique_violation.
      const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
      expect(cause?.code).toBe("23505");
      expect(cause?.constraint).toBe("field_records_current_idx");
    }
  });
});

describe("P0-27 — the default read is the newest non-superseded value", () => {
  it("returns the latest value as a typed Field", async () => {
    const current = await readCurrentField<Money>(profileId, "revenue.average_order_value");
    expect(current?.value).toEqual(money(575_000, "HUF"));
    expect(current?.status).toBe("answered");
    expect(current?.superseded_by).toBeNull();
  });

  it("returns null for a never-written key — absence, not a guess", async () => {
    expect(await readCurrentField(profileId, "revenue.monthly_revenue")).toBeNull();
  });
});

describe("P0-28 + P0-29 — three price changes: three records, full dated chain, newest returned", () => {
  it("holds the whole chain in order with every value preserved", async () => {
    // Third change on top of the two from P0-26.
    const thirdId = await writeField(profileId, priceField(600_000, "2026-08-15T00:00:00Z"));

    const history = await readFieldHistory<Money>(profileId, "revenue.average_order_value");
    expect(history).toHaveLength(3);

    // Oldest first, every historical value intact — price history for free.
    expect(history.map((h) => h.field.value?.amount_minor)).toEqual([500_000, 575_000, 600_000]);

    // Every non-final record is superseded and chains to its successor.
    for (let i = 0; i < history.length - 1; i++) {
      expect(history[i]?.superseded_at).not.toBeNull();
      expect(history[i]?.field.superseded_by).toBe(history[i + 1]?.record_id);
    }

    // The final record is current, and the default read agrees.
    expect(history[2]?.superseded_at).toBeNull();
    expect(history[2]?.record_id).toBe(thirdId);
    const current = await readCurrentField<Money>(profileId, "revenue.average_order_value");
    expect(current?.value).toEqual(money(600_000, "HUF"));

    // And the database still holds exactly one current row.
    const currentRows = await db
      .select()
      .from(fieldRecords)
      .where(
        and(
          eq(fieldRecords.profile_id, profileId),
          eq(fieldRecords.field_key, "revenue.average_order_value"),
          isNull(fieldRecords.superseded_at),
        ),
      );
    expect(currentRows).toHaveLength(1);
  });
});
