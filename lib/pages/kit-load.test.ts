// Guided page set-up, against the database: the kit is read from the fact
// sheet as it stands. An answered fact is a piece of the kit; a question
// skipped and one never asked are gaps, named with their question. No
// platform is asked anything, and no model is called.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords, intakeEvents } from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake, submitAnswer } from "../intake/service";
import { writeField } from "../profile/field-store";
import { loadKitFacts, loadPageSetup } from "./kit-load";

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

async function answer(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

describe("the kit is read from the fact sheet as it stands", () => {
  it("holds the owner's answers, and the business type in words", async () => {
    const s = await business();
    await answer(s.profile_id, "identity.legal_name", "Emberworks Candles");
    await answer(
      s.profile_id,
      "identity.description",
      "We pour small-batch candles that smell like a real fireplace. Two scents sell out every winter, and most of our customers come back for the same one.",
    );
    await answer(s.profile_id, "identity.business_type", { code: "ecommerce_store" });
    await answer(s.profile_id, "presence.website_url", "https://emberworks.example");

    const facts = await loadKitFacts(s.profile_id, "en");
    expect(facts.name).toBe("Emberworks Candles");
    expect(facts.website).toBe("https://emberworks.example");
    // Words, not the code on file.
    expect(facts.business_type).not.toBeNull();
    expect(facts.business_type).not.toContain("_");
    expect((facts.business_type ?? "").toLowerCase()).toMatch(/store|shop|commerce/);

    const view = await loadPageSetup(s.account_id, s.profile_id, "en");
    expect(view.kit.name?.value).toBe("Emberworks Candles");
    expect(view.kit.short_line).toMatchObject({
      value: "We pour small-batch candles that smell like a real fireplace.",
      derived_from: "identity.description",
      formula: "first_sentence",
    });
    expect(view.kit.username?.value).toBe("emberworks.candles");
    expect(view.kit.gaps).toEqual([]);
    // Nothing is connected for publishing: the guide's last step says so.
    expect(view.connected).toEqual({ page: false, instagram: false });
  });

  it("words the business type in the reader's language", async () => {
    const s = await business();
    await answer(s.profile_id, "identity.business_type", { code: "cafe" });
    const english = await loadKitFacts(s.profile_id, "en");
    const hungarian = await loadKitFacts(s.profile_id, "hu-HU");
    expect(english.business_type).toBeTruthy();
    expect(hungarian.business_type).toBeTruthy();
    expect(hungarian.business_type).not.toContain("_");
  });

  it("treats a skipped question and one never asked as gaps, with the question that fills each", async () => {
    const s = await business();
    // The name is asked and skipped for now; nothing else is asked at all.
    await submitAnswer(s.account_id, s.profile_id, "1.1", { kind: "skip" });
    const view = await loadPageSetup(s.account_id, s.profile_id, "en");
    expect(view.kit.name).toBeNull();
    expect(view.kit.short_line).toBeNull();
    expect(view.kit.about).toBeNull();
    expect(view.kit.username).toBeNull();
    expect(view.kit.gaps.map((g) => `${g.key}:${g.question}`)).toEqual([
      "name:1.1",
      "business_type:1.2",
      "description:1.3",
    ]);
  });
});
