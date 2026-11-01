// L-2 (TASKS-LANGUAGES.md): the intake asks in the person's language —
// the deterministic interviewer, every language, no model call — while the
// answers stay codes and values exactly as before (plan rule 4).

import "dotenv/config";
import { readFileSync } from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pickNextQuestion = vi.hoisted(() => vi.fn());
vi.mock("../interviewer/interviewer", () => ({ pickNextQuestion }));

const { db } = await import("../../db");
const { accounts, businessProfiles, fieldRecords } = await import("../../db/schema");
const { loadBank } = await import("../bank/loader");
const { LOCALES } = await import("../i18n/locales");
const { bootstrapIntake, getIntakeState, IntakeError, submitAnswer } = await import("./service");

type Overlay = {
  questions: Record<string, { prompt: string; help_text?: string }>;
  vocabularies: Record<string, Record<string, string>>;
  entity_schemas: Record<string, { label: string; fields: Record<string, string> }>;
};
const overlay = (l: string): Overlay =>
  JSON.parse(readFileSync(`specs/question-bank-v1.${l}.json`, "utf8")) as Overlay;

const made: { account_id: string; profile_id: string }[] = [];

beforeAll(async () => {
  vi.stubEnv("INTERVIEWER_MODE", "deterministic");
  await loadBank("specs/question-bank-v1.json");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  for (const s of made) {
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

async function fresh() {
  const s = await bootstrapIntake();
  made.push(s);
  return s;
}

describe("the deterministic intake in every language", () => {
  for (const locale of LOCALES.filter((l) => l !== "en")) {
    it(`${locale}: asks, helps and labels from the overlay, and stores the code`, async () => {
      const words = overlay(locale);
      const s = await fresh();
      const first = await getIntakeState(s.account_id, s.profile_id, undefined, undefined, locale);
      expect(first.question?.id).toBe("1.1");
      expect(first.question?.prompt).toBe(words.questions["1.1"]?.prompt);
      expect(first.on_deck).not.toBeNull();

      // 1.1b carries help text; then 1.2 is a select whose options are the overlay's words.
      const second = await submitAnswer(
        s.account_id,
        s.profile_id,
        "1.1",
        { kind: "value", wire: "Szörp Kft." },
        undefined,
        locale,
      );
      expect(second.state.question?.id).toBe("1.1b");
      expect(second.state.question?.help).toBe(words.questions["1.1b"]?.help_text);
      const third = await submitAnswer(
        s.account_id,
        s.profile_id,
        "1.1b",
        { kind: "value", wire: "Hungary" },
        undefined,
        locale,
      );
      const q = third.state.question;
      expect(q?.id).toBe("1.2");
      const restaurant = q?.options.find((o) => o.code === "restaurant");
      expect(restaurant?.label).toBe(words.vocabularies.business_type?.restaurant);

      await submitAnswer(
        s.account_id,
        s.profile_id,
        "1.2",
        { kind: "value", wire: "restaurant" },
        undefined,
        locale,
      );
      // Facts don't change language: the record holds the code, never the label.
      const [row] = await db
        .select({ value: fieldRecords.value })
        .from(fieldRecords)
        .where(
          and(
            eq(fieldRecords.profile_id, s.profile_id),
            eq(fieldRecords.field_key, "identity.business_type"),
            isNull(fieldRecords.superseded_at),
          ),
        );
      expect(row?.value).toEqual({ code: "restaurant" });
    });
  }

  it("never asks the model in deterministic mode, whatever the language", () => {
    expect(pickNextQuestion).not.toHaveBeenCalled();
  });

  it("shows the same profile in English to an English reader (the words are presentation)", async () => {
    const s = await fresh();
    const de = await getIntakeState(s.account_id, s.profile_id, undefined, undefined, "de-DE");
    const en = await getIntakeState(s.account_id, s.profile_id);
    expect(de.question?.id).toBe(en.question?.id);
    expect(en.question?.prompt).toBe("What is the name of the business?");
    expect(de.question?.prompt).not.toBe(en.question?.prompt);
  });

  it("words an entity list's fields and options in the language", async () => {
    const s = await fresh();
    const words = overlay("fr-FR");
    const state = await getIntakeState(s.account_id, s.profile_id, "3.1", undefined, "fr-FR");
    expect(state.question?.id).toBe("3.1");
    const price = state.question?.entity_fields?.find((f) => f.key === "price");
    expect(price?.prompt).toBe(words.entity_schemas.offer?.fields.price);
    const kind = state.question?.entity_fields?.find((f) => f.key === "kind");
    expect(kind?.options.find((o) => o.code === "service")?.label).toBe(
      (words.vocabularies.offer_kind as Record<string, string>).service,
    );
    const unlocks = state.question?.unlocks ?? [];
    for (const u of unlocks) expect(u.prompt).toBe(words.questions[u.id]?.prompt);
  });

  it("refuses with a code the screen can word, and the English beside it", async () => {
    const s = await fresh();
    await getIntakeState(s.account_id, s.profile_id, undefined, undefined, "ru-RU");
    const refused = await submitAnswer(
      s.account_id,
      s.profile_id,
      "1.1",
      { kind: "unknown" },
      undefined,
      "ru-RU",
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(IntakeError);
    expect((refused as InstanceType<typeof IntakeError>).code).toBe("needs_answer");
    expect((refused as Error).message).toBe("this question needs an answer");
  });
});
