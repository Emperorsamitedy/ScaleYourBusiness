// Outside signals, against the database: the only thing read is the
// business's own country, from its fact sheet. A name as the owner typed it
// is a country; a country with no calendar gets none; and a business that
// never said where it is gets nothing assumed. No network, no model.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords, intakeEvents } from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import { businessCountry, loadOutside } from "./outside";

const created: { account_id: string; profile_id: string }[] = [];

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network was called");
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const s of created) {
    await db.delete(intakeEvents).where(eq(intakeEvents.profile_id, s.profile_id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

async function business(country?: unknown, status: "answered" | "unknown" = "answered") {
  const s = await bootstrapIntake();
  created.push(s);
  if (country !== undefined) {
    const at = isoDateTime(new Date().toISOString());
    await writeField(
      s.profile_id,
      createField<unknown>({
        id: fieldId("legal.country"),
        value: status === "answered" ? country : null,
        status,
        confidence: confidence(status === "answered" ? 0.75 : 0),
        source: { kind: "owner_input" },
        observed_at: at,
        recorded_at: at,
      }),
    );
  }
  return s;
}

describe("the business's own country decides which calendar is read", () => {
  it("reads a country as the owner typed it, in their own language too", async () => {
    expect(await businessCountry((await business("Hungary")).profile_id)).toBe("HU");
    expect(await businessCountry((await business("Magyarország")).profile_id)).toBe("HU");
    expect(await businessCountry((await business("hu")).profile_id)).toBe("HU");
  });

  it("gives a Hungarian business its public holidays, with the law", async () => {
    const s = await business("Hungary");
    const view = await loadOutside(s.profile_id, "2026-12-21", 7);
    expect(view.country).toBe("HU");
    expect(view.holidays.covered).toBe(true);
    if (!view.holidays.covered) return;
    expect(view.holidays.days.map((d) => d.date)).toEqual([
      "2026-12-24",
      "2026-12-25",
      "2026-12-26",
    ]);
    expect(view.holidays.source.law).toContain("102. § (1)");
  });

  it("gives a business in a country with no calendar none, and says which country", async () => {
    const s = await business("Germany");
    expect(await loadOutside(s.profile_id, "2026-12-21", 7)).toMatchObject({
      country: "DE",
      holidays: { covered: false },
    });
  });

  it("assumes no country for a business that never said, or said it does not know", async () => {
    const never = await business();
    expect(await businessCountry(never.profile_id)).toBeNull();
    expect(await loadOutside(never.profile_id, "2026-12-21", 7)).toMatchObject({
      country: null,
      holidays: { covered: false },
    });
    const unknown = await business(null, "unknown");
    expect(await businessCountry(unknown.profile_id)).toBeNull();
  });

  it("makes no country of words that are not one", async () => {
    const s = await business("somewhere warm");
    expect(await businessCountry(s.profile_id)).toBeNull();
  });
});
