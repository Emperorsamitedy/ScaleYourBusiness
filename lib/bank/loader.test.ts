// Session H — bank loader against live Postgres.
// P0-36 full load · P0-37 versioning keeps answers · P0-38 lint gate refuses

import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  bankEntitySchemas,
  bankOverlays,
  bankQuestions,
  bankVersions,
  businessProfiles,
  fieldRecords,
} from "../../db/schema";
import { enumValue } from "../core/enum-value";
import type { EnumValue } from "../core/enum-value";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { readCurrentField, writeField } from "../profile/field-store";
import { BankLintError, loadBank, readBankOverlays } from "./loader";
import { loadBankWords } from "./words";

const SCRATCH = process.env.SCRATCHPAD_DIR ?? "/tmp";
const BANK_PATH = "specs/question-bank-v1.json";

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
  // Remove the synthetic test version; the real bank may stay loaded.
  await db.delete(bankQuestions).where(eq(bankQuestions.bank_version, "1.0.1-test"));
  await db.delete(bankEntitySchemas).where(eq(bankEntitySchemas.bank_version, "1.0.1-test"));
  await db.delete(bankOverlays).where(eq(bankOverlays.bank_version, "1.0.1-test"));
  await db.delete(bankVersions).where(eq(bankVersions.version, "1.0.1-test"));
  // Re-point is_current at the real bank.
  await loadBank(BANK_PATH);
});

describe("P0-36 — loads 160 questions, 57 vocabularies, 8 entity schemas", () => {
  it("loads the real bank with exact counts and marks it current", async () => {
    const result = await loadBank(BANK_PATH);
    expect(result).toEqual({
      bank_version: "1.9.0",
      questions: 160,
      vocabularies: 57,
      entity_schemas: 8,
      overlays: ["es-ES", "de-DE", "fr-FR", "hu-HU", "ru-RU", "zh-Hans"],
    });

    const [versionRow] = await db
      .select()
      .from(bankVersions)
      .where(eq(bankVersions.version, "1.9.0"));
    expect(versionRow?.is_current).toBe(true);
    expect(versionRow?.source_hash).toHaveLength(64);
  });

  it("stores a question faithfully, flow section mapped onto profile sections", async () => {
    const [q11] = await db
      .select()
      .from(bankQuestions)
      .where(and(eq(bankQuestions.bank_version, "1.9.0"), eq(bankQuestions.id, "1.1")));
    expect(q11?.writes_to).toBe("identity.legal_name");
    expect(q11?.priority).toBe("core");
    expect((q11?.prompt as { en: string }).en).toMatch(/name of the business/);

    // Bank flow-section "competition" lands as profile section competitors.
    const [q121] = await db
      .select()
      .from(bankQuestions)
      .where(and(eq(bankQuestions.bank_version, "1.9.0"), eq(bankQuestions.id, "12.1")));
    expect(q121?.section).toBe("competitors");
  });

  it("stores the eight entity schemas", async () => {
    const schemas = await db
      .select()
      .from(bankEntitySchemas)
      .where(eq(bankEntitySchemas.bank_version, "1.9.0"));
    expect(schemas.map((s) => s.key).sort()).toEqual([
      "channel",
      "competitor",
      "cost_item",
      "customer_segment",
      "goal",
      "offer",
      "staff_role",
      "supplier",
    ]);
  });
});

describe("P0-37 — a new bank version does not invalidate existing answers", () => {
  it("keeps old-version questions and old answers readable after loading a new version", async () => {
    // An answer recorded while 1.1.0 is current.
    await writeField(
      profileId,
      createField<EnumValue[]>({
        id: fieldId("identity.sells"),
        value: [enumValue("physical_products"), enumValue("services")],
        status: "answered",
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: isoDateTime("2026-08-20T10:00:00.000Z"),
        recorded_at: isoDateTime(new Date().toISOString()),
        note: null,
      }),
    );

    // A plausible next version: one question rewritten, one dropped.
    const bank = JSON.parse(readFileSync(BANK_PATH, "utf8")) as {
      bank_version: string;
      questions: { id: string; version: number; prompt: { en: string } }[];
    };
    bank.bank_version = "1.0.1-test";
    const q = bank.questions.find((x) => x.id === "1.1");
    if (!q) throw new Error("bank has no question 1.1");
    q.version = 2;
    q.prompt.en = "What is your business called?";
    bank.questions = bank.questions.filter((x) => x.id !== "14.1b");
    mkdirSync(SCRATCH, { recursive: true });
    const nextPath = `${SCRATCH}/bank-1.0.1-test.json`;
    writeFileSync(nextPath, JSON.stringify(bank));

    const result = await loadBank(nextPath);
    expect(result.questions).toBe(159);

    // Both versions coexist, current pointer moved.
    const versions = await db.select().from(bankVersions);
    expect(versions.find((v) => v.version === "1.9.0")?.is_current).toBe(false);
    expect(versions.find((v) => v.version === "1.0.1-test")?.is_current).toBe(true);
    const oldQuestions = await db
      .select()
      .from(bankQuestions)
      .where(eq(bankQuestions.bank_version, "1.9.0"));
    expect(oldQuestions).toHaveLength(160);

    // The answer written under 1.1.0 is untouched and fully readable.
    const answer = await readCurrentField<EnumValue[]>(profileId, "identity.sells");
    expect(answer?.value).toEqual([{ code: "physical_products" }, { code: "services" }]);
    expect(answer?.status).toBe("answered");
  });
});

describe("P0-38 — the loader refuses a bank that fails lint", () => {
  it("throws BankLintError and writes nothing", async () => {
    const bank = JSON.parse(readFileSync(BANK_PATH, "utf8")) as {
      questions: Record<string, unknown>[];
    };
    delete bank.questions[0]?.id;
    const brokenPath = `${SCRATCH}/bank-broken.json`;
    writeFileSync(brokenPath, JSON.stringify(bank));

    const before = (await db.select().from(bankVersions)).length;
    await expect(loadBank(brokenPath)).rejects.toThrow(BankLintError);
    const after = (await db.select().from(bankVersions)).length;
    expect(after).toBe(before);
  });
});

describe("L-2 — the language overlays load with their bank version", () => {
  it("stores one overlay per language under the version, words only", async () => {
    await loadBank(BANK_PATH);
    const rows = await db.select().from(bankOverlays).where(eq(bankOverlays.bank_version, "1.9.0"));
    expect(rows.map((r) => r.locale).sort()).toEqual(
      ["de-DE", "es-ES", "fr-FR", "hu-HU", "ru-RU", "zh-Hans"].sort(),
    );
    for (const r of rows) {
      expect(r.source_hash).toHaveLength(64);
      // Words only: no lint bookkeeping, and nothing structural travels.
      expect(Object.keys(r.words as object).sort()).toEqual([
        "entity_schemas",
        "questions",
        "vocabularies",
      ]);
      expect(JSON.stringify(r.words)).not.toMatch(
        /"(writes_to|condition|vocabulary_id|input|unlocks)"/,
      );
    }
  });

  it("serves a question's words in the language, and English as the bank itself", async () => {
    await loadBank(BANK_PATH);
    const de = await loadBankWords("de-DE");
    const en = await loadBankWords("en");
    expect(de.prompt("1.1", "What is the name of the business?")).toBe(
      "Wie heißt das Unternehmen?",
    );
    expect(en.prompt("1.1", "What is the name of the business?")).toBe(
      "What is the name of the business?",
    );
    // The question's own option labels win over the vocabulary's words.
    expect(de.option("business_size", "solo", "Just me", "1.6a")).toBe("Nur ich");
    expect(de.option("customer_type", "b2b", "B2b")).toBe("Geschäftskunden (B2B)");
  });

  it("refuses an overlay written for another bank version", async () => {
    const bank = JSON.parse(readFileSync(BANK_PATH, "utf8")) as { bank_version: string };
    bank.bank_version = "1.0.2-test";
    const dir = `${SCRATCH}/overlay-mismatch`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/bank.json`, JSON.stringify(bank));
    // Lint refuses it first (one linter, one truth)…
    writeFileSync(
      `${dir}/bank.de-DE.json`,
      readFileSync("specs/question-bank-v1.de-DE.json", "utf8"),
    );
    await expect(loadBank(`${dir}/bank.json`)).rejects.toThrow(BankLintError);
    // …and the loader reads which version each overlay names.
    expect(readBankOverlays(`${dir}/bank.json`).map((o) => o.bank_version)).toEqual(["1.9.0"]);
    const versions = await db.select().from(bankVersions);
    expect(versions.some((v) => v.version === "1.0.2-test")).toBe(false);
  });
});
