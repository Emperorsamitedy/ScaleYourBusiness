// I-54.1 — the forecast record against live Postgres (migration 0067): a
// claim is recorded ungraded, graded once, and never changed after; a
// forecast leaves the record only with its business.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, forecastChecks } from "../../db/schema";

let accountId: string;
let profileId: string;

function pgError(error: unknown): { code?: string; message?: string } {
  return (error as { cause?: { code?: string; message?: string } }).cause ?? {};
}

async function expectRefused(run: () => Promise<unknown>, message: RegExp): Promise<void> {
  try {
    await run();
    expect.fail("the database must refuse this");
  } catch (error) {
    expect(pgError(error).message ?? String(error)).toMatch(message);
  }
}

const claim = (key: string) => ({
  account_id: accountId,
  profile_id: profileId,
  kind: "season_week",
  forecast_key: key,
  made_at: "2026-10-26T09:00:00.000Z",
  subject: "revenue",
  subject_ref: { connection_id: "c", metric: "revenue.daily", currency: "EUR" },
  metric: "revenue.daily",
  unit: "money",
  window_start: "2026-11-02",
  window_end: "2026-11-08",
  low_minor: 370_000,
  high_minor: 450_000,
  currency: "EUR",
  claim: "Week of 2 Nov: about €3,700–€4,500 of revenue.",
  basis: "Last year the same week ran 1.9–2.3× your normal week.",
});

const grade = {
  graded_at: "2026-11-10T06:00:00.000Z",
  verdict: "inside",
  actual_minor: 412_000,
  actual_note: "It came to €4,120, measured by Shopify: inside the range.",
  actual_source: { table: "metric_observations", ids: ["x"] },
};

async function insert(key: string): Promise<string> {
  const [row] = await db
    .insert(forecastChecks)
    .values(claim(key))
    .returning({ id: forecastChecks.id });
  return row!.id;
}

beforeAll(async () => {
  const [account] = await db.insert(accounts).values({ reporting_currency: "EUR" }).returning();
  accountId = account!.id;
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: accountId, schema_version: "1.0.0" })
    .returning();
  profileId = profile!.id;
});

afterAll(async () => {
  // The rows go with the business: the cascade is the one way out.
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

describe("I-54.1 — a forecast is recorded when it is made", () => {
  it("records an ungraded claim once per window", async () => {
    await insert("guard|once");
    const again = await db
      .insert(forecastChecks)
      .values(claim("guard|once"))
      .onConflictDoNothing()
      .returning({ id: forecastChecks.id });
    expect(again).toHaveLength(0);
  });

  it("refuses a claim inserted already graded", async () => {
    await expectRefused(
      () => db.insert(forecastChecks).values({ ...claim("guard|pregraded"), ...grade }),
      /recorded ungraded/,
    );
  });

  it("refuses money without its currency (rule 1)", async () => {
    await expectRefused(
      () => db.insert(forecastChecks).values({ ...claim("guard|nocur"), currency: null }),
      /forecast_checks_money/,
    );
  });
});

describe("I-54.1 — graded once, never changed", () => {
  it("grades an ungraded claim once", async () => {
    const id = await insert("guard|grade");
    await db.update(forecastChecks).set(grade).where(eq(forecastChecks.id, id));
    const [row] = await db.select().from(forecastChecks).where(eq(forecastChecks.id, id));
    expect(row!.verdict).toBe("inside");
  });

  it("refuses a second grading", async () => {
    const id = await insert("guard|twice");
    await db.update(forecastChecks).set(grade).where(eq(forecastChecks.id, id));
    await expectRefused(
      () =>
        db
          .update(forecastChecks)
          .set({ verdict: "above", graded_at: "2026-11-11T06:00:00.000Z" })
          .where(eq(forecastChecks.id, id)),
      /already graded/,
    );
  });

  it("refuses any change to a claim, graded or not", async () => {
    const id = await insert("guard|claim");
    await expectRefused(
      () => db.update(forecastChecks).set({ high_minor: 990_000 }).where(eq(forecastChecks.id, id)),
      /claim is never changed/,
    );
    await expectRefused(
      () =>
        db
          .update(forecastChecks)
          .set({ ...grade, basis: "rewritten" })
          .where(eq(forecastChecks.id, id)),
      /claim is never changed/,
    );
  });

  it("refuses an update that isn't the grading", async () => {
    const id = await insert("guard|nograde");
    await expectRefused(
      () =>
        db
          .update(forecastChecks)
          .set({ actual_note: "half a grade" })
          .where(eq(forecastChecks.id, id)),
      /only change is the grading|forecast_checks_graded_whole/,
    );
  });

  it("refuses a right or wrong verdict with no measured source", async () => {
    const id = await insert("guard|nosource");
    await expectRefused(
      () =>
        db
          .update(forecastChecks)
          .set({ ...grade, actual_source: null })
          .where(eq(forecastChecks.id, id)),
      /forecast_checks_actual_measured/,
    );
    // "Can't tell" needs no source: there was nothing measured to cite.
    await db
      .update(forecastChecks)
      .set({ ...grade, verdict: "cant_tell", actual_minor: null, actual_source: null })
      .where(eq(forecastChecks.id, id));
  });
});

describe("I-54.1 — a forecast leaves the record only with its business", () => {
  it("refuses deleting a forecast on its own", async () => {
    const id = await insert("guard|delete");
    await expectRefused(
      () => db.delete(forecastChecks).where(eq(forecastChecks.id, id)),
      /not deleted on its own/,
    );
  });

  it("refuses TRUNCATE", async () => {
    await expectRefused(() => db.execute("TRUNCATE forecast_checks"), /TRUNCATE is not permitted/);
  });

  it("goes with its business through the cascade", async () => {
    const [a] = await db.insert(accounts).values({ reporting_currency: "EUR" }).returning();
    const [p] = await db
      .insert(businessProfiles)
      .values({ account_id: a!.id, schema_version: "1.0.0" })
      .returning();
    await db
      .insert(forecastChecks)
      .values({ ...claim("guard|cascade"), account_id: a!.id, profile_id: p!.id });
    await db.delete(businessProfiles).where(eq(businessProfiles.id, p!.id));
    await db.delete(accounts).where(eq(accounts.id, a!.id));
    const left = await db
      .select({ id: forecastChecks.id })
      .from(forecastChecks)
      .where(eq(forecastChecks.profile_id, p!.id));
    expect(left).toHaveLength(0);
  });
});
