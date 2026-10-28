// Cost rows are filed by the list they were entered on: 5.1's rows are
// fixed, 5.2's ("costs that go up when you sell more") are variable and
// scale with sales. Until 2026-10-28 every row was filed fixed, so unit
// economics counted per-sale costs among the monthly ones; migration 0065
// refiles the rows 5.2's answer names. No network, no model.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, costItems, fieldRecords, intakeEvents } from "../../db/schema";
import { COST_BUCKET_BY_TARGET, costBucketFor } from "./entities";
import { bootstrapIntake, submitEntities } from "./service";

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  for (const s of created) {
    await db.delete(intakeEvents).where(eq(intakeEvents.profile_id, s.profile_id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(costItems).where(eq(costItems.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

const money = (major: number) => ({ amount_major: major, currency: "EUR" });

async function costRows(profileId: string) {
  return db
    .select({ id: costItems.id, bucket: costItems.bucket, scales: costItems.scales_with_sales })
    .from(costItems)
    .where(eq(costItems.profile_id, profileId));
}

describe("a cost row's bucket follows the list it was entered on", () => {
  it("maps 5.1's target to fixed and 5.2's to variable", () => {
    expect(costBucketFor("costs.fixed_monthly")).toBe("fixed");
    expect(costBucketFor("costs.variable")).toBe("variable");
    expect(COST_BUCKET_BY_TARGET).toEqual({
      "costs.fixed_monthly": "fixed",
      "costs.variable": "variable",
    });
  });

  it("never files an unknown target as variable", () => {
    expect(costBucketFor("costs.something_else")).toBe("fixed");
    expect(costBucketFor("")).toBe("fixed");
  });

  it("files 5.1's rows fixed and 5.2's rows variable, scaling with sales", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const fixed = await submitEntities(s.account_id, s.profile_id, "5.1", [
      { category: "rent", label: "Studio rent", amount: money(1450), cadence: "monthly" },
    ]);
    const variable = await submitEntities(s.account_id, s.profile_id, "5.2", [
      { category: "shipping", label: "Courier label", amount: money(7.4), cadence: "per_job" },
      { category: "packaging", label: "Box", amount: money(1.2), cadence: "per_unit" },
    ]);
    expect(fixed).toBeTruthy();
    expect(variable).toBeTruthy();

    const rows = await costRows(s.profile_id);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.bucket === "fixed")).toEqual([
      expect.objectContaining({ scales: false }),
    ]);
    const vars = rows.filter((r) => r.bucket === "variable");
    expect(vars).toHaveLength(2);
    expect(vars.every((r) => r.scales)).toBe(true);
  });
});

describe("migration 0065 refiles the rows 5.2's answer names, and only those", () => {
  it("moves a 5.2 row filed fixed to variable, and leaves 5.1's alone", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await submitEntities(s.account_id, s.profile_id, "5.1", [
      { category: "rent", label: "Studio rent", amount: money(1450), cadence: "monthly" },
    ]);
    await submitEntities(s.account_id, s.profile_id, "5.2", [
      { category: "shipping", label: "Courier label", amount: money(7.4), cadence: "per_job" },
    ]);
    // As the intake filed them before the fix.
    await db
      .update(costItems)
      .set({ bucket: "fixed", scales_with_sales: false })
      .where(eq(costItems.profile_id, s.profile_id));
    expect((await costRows(s.profile_id)).every((r) => r.bucket === "fixed")).toBe(true);

    const migration = readFileSync("db/migrations/0065_cost_bucket_from_list.sql", "utf8");
    await db.execute(sql.raw(migration));

    const rows = await costRows(s.profile_id);
    expect(rows.filter((r) => r.bucket === "variable")).toHaveLength(1);
    expect(rows.filter((r) => r.bucket === "fixed")).toHaveLength(1);
    expect(rows.find((r) => r.bucket === "variable")?.scales).toBe(true);

    // Run again: nothing left to move.
    await db.execute(sql.raw(migration));
    expect((await costRows(s.profile_id)).filter((r) => r.bucket === "variable")).toHaveLength(1);
  });
});
