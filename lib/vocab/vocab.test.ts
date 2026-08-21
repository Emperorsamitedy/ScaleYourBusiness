// Session F — vocabularies against live Postgres.
// P0-30 load from bank · P0-31 other/label_raw preserved · P0-32 recurring report

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords } from "../../db/schema";
import { enumValue } from "../core/enum-value";
import type { EnumValue } from "../core/enum-value";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField, readCurrentField } from "../profile/field-store";
import { loadVocabularies, readBankVocabularies } from "./loader";
import { foldEntityIds, recurringOthers } from "./recurring-others";
import { validateAgainstVocabulary, vocabularyCodes, VocabularyMembershipError } from "./validate";

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

describe("P0-30 — vocabulary tables loaded from the bank JSON", () => {
  it("loads all 55 vocabularies verbatim and is idempotent", async () => {
    const bank = readBankVocabularies("specs/question-bank-v1.json");
    const first = await loadVocabularies(bank);
    expect(first.vocabularies).toBe(55);
    expect(first.entries).toBeGreaterThan(55);

    // Reload replaces, never accumulates.
    const second = await loadVocabularies(bank);
    expect(second).toEqual(first);
  });

  it("preserves bank order and membership — sells_type ends in 'other', closed lists don't", async () => {
    const sells = await vocabularyCodes("sells_type");
    expect(sells[0]).toBe("physical_products");
    expect(sells).toContain("other");

    const stage = await vocabularyCodes("business_stage");
    expect(stage.length).toBeGreaterThan(0);
    expect(stage).not.toContain("other");
  });
});

describe("P0-31 — other + label_raw preservation, end to end", () => {
  it("accepts a vocabulary code, and 'other' where the vocabulary has it", async () => {
    const sells = await vocabularyCodes("sells_type");
    expect(validateAgainstVocabulary("sells_type", sells, enumValue("services"))).toEqual({
      code: "services",
    });
    const other = enumValue("other", "kézműves szörp");
    expect(validateAgainstVocabulary("sells_type", sells, other)).toEqual(other);
  });

  it("rejects codes outside the vocabulary, and 'other' on a closed list", async () => {
    const sells = await vocabularyCodes("sells_type");
    expect(() => validateAgainstVocabulary("sells_type", sells, enumValue("consulting"))).toThrow(
      VocabularyMembershipError,
    );
    const stage = await vocabularyCodes("business_stage");
    expect(() =>
      validateAgainstVocabulary("business_stage", stage, enumValue("other", "sort of growing")),
    ).toThrow(VocabularyMembershipError);
  });

  it("round-trips the owner's exact wording through the database", async () => {
    await writeField(
      profileId,
      createField<EnumValue>({
        id: fieldId("identity.business_type"),
        value: enumValue("other", "kézműves szörpkészítő műhely"),
        status: "answered",
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: isoDateTime("2026-08-20T10:00:00.000Z"),
        recorded_at: isoDateTime(new Date().toISOString()),
        note: null,
      }),
    );
    const restored = await readCurrentField<EnumValue>(profileId, "identity.business_type");
    expect(restored?.value).toEqual({ code: "other", label_raw: "kézműves szörpkészítő műhely" });
  });
});

describe("P0-32 — recurring 'other' values surface for promotion", () => {
  it("folds entity ids so the same conceptual question counts together", () => {
    expect(foldEntityIds("offers.a3c52c8e-6f3a-4d2b-9c1e-0f4b5a6d7e8f.problems")).toBe(
      "offers.*.problems",
    );
    expect(foldEntityIds("identity.business_type")).toBe("identity.business_type");
  });

  it("tallies wordings across records, case/whitespace-folded, threshold applied", async () => {
    const at = isoDateTime(new Date().toISOString());
    const write = (key: string, value: EnumValue | EnumValue[]) =>
      writeField(
        profileId,
        createField<EnumValue | EnumValue[]>({
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

    // Same wording, different casing, on two entity-scoped keys of the
    // same conceptual question — plus a multi-select carrying it once more.
    await write(
      "offers.11111111-1111-4111-8111-111111111111.problems",
      enumValue("other", "Utánvét visszaküldések"),
    );
    await write(
      "offers.22222222-2222-4222-8222-222222222222.problems",
      enumValue("other", "utánvét visszaküldések  "),
    );
    await write("marketing.channel_focus", [enumValue("other", "utánvét visszaküldések")]);
    // A one-off that must stay below the threshold.
    await write("identity.sells", [enumValue("other", "gépkölcsönzés")]);

    const report = await recurringOthers(2);
    const offers = report.find((r) => r.field_key === "offers.*.problems");
    expect(offers?.count).toBe(2);
    expect(offers?.normalized).toBe("utánvét visszaküldések");
    // Different field_key, same wording → separate row, below threshold.
    expect(report.find((r) => r.field_key === "identity.sells")).toBeUndefined();
  });
});
