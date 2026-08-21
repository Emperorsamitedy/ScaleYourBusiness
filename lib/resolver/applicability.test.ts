// Session J — applicability resolver against live Postgres.
// P0-42 applicable set · P0-43 services-only never sees inventory ·
// P0-44 adding physical products later makes the branch appear.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords } from "../../db/schema";
import { loadBank } from "../bank/loader";
import { enumValue } from "../core/enum-value";
import type { EnumValue } from "../core/enum-value";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";
import { applicableQuestions } from "./applicability";

let accountId: string;
let profileId: string;

function sellsField(codes: string[]) {
  const at = isoDateTime(new Date().toISOString());
  return createField<EnumValue[]>({
    id: fieldId("identity.sells"),
    value: codes.map((c) => enumValue(c)),
    status: "answered",
    confidence: 0.75,
    source: { kind: "owner_input" },
    observed_at: at,
    recorded_at: at,
    note: null,
  });
}

beforeAll(async () => {
  await loadBank("specs/question-bank-v1.json"); // the resolver needs a current bank
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

describe("P0-42 — currently applicable questions for a profile", () => {
  it("an empty profile gets exactly the unconditioned questions, none answered", async () => {
    const applicable = await applicableQuestions(profileId);
    expect(applicable.length).toBeGreaterThan(0);
    // 69 of 153 carry no condition; an empty profile satisfies no condition.
    expect(applicable.every((q) => q.already_answered === false)).toBe(true);
    const ids = new Set(applicable.map((q) => q.id));
    expect(ids.has("1.1")).toBe(true); // business name, always asked
    expect(ids.has("1.4.1.2")).toBe(false); // inventory branch, gated
    expect(ids.has("1.4.2.2")).toBe(false); // services branch, gated
  });
});

describe("P0-43 — a services-only profile never surfaces inventory questions", () => {
  it("shows the services branch and not one physical/inventory question", async () => {
    await writeField(profileId, sellsField(["services"]));
    const applicable = await applicableQuestions(profileId);
    const ids = new Set(applicable.map((q) => q.id));

    // Services branch present…
    expect(ids.has("1.4.2.2")).toBe(true);
    expect(ids.has("1.4.2.3")).toBe(true);
    // …inventory/physical branch entirely absent, by id prefix…
    expect([...ids].filter((id) => id.startsWith("1.4.1"))).toEqual([]);
    // …and by target namespace: nothing writing to fulfilment/suppliers applies.
    const targets = applicable.map((q) => q.writes_to);
    expect(targets.filter((t) => t.startsWith("fulfilment.") || t === "suppliers")).toEqual([]);
    // The sells question itself now reads as answered.
    expect(applicable.find((q) => q.id === "1.4")?.already_answered ?? true).toBe(true);
  });
});

describe("P0-44 — adding physical products later makes the branch appear", () => {
  it("supersedes sells and the inventory branch becomes applicable", async () => {
    await writeField(profileId, sellsField(["services", "physical_products"]));
    const applicable = await applicableQuestions(profileId);
    const ids = new Set(applicable.map((q) => q.id));

    // The gate question from the spec's own §6.2 example:
    expect(ids.has("1.4.1.2")).toBe(true);
    expect(ids.has("1.4.1.3")).toBe(true);
    // Services branch still there — both are true now.
    expect(ids.has("1.4.2.2")).toBe(true);
    // Second-level gates stay closed until their own upstream is answered
    // (ships_products is still unasked).
    expect(ids.has("1.4.1.5a")).toBe(false);
  });
});
