// Persona answer synthesis — DB-backed shape tests. Every input type must
// produce a correctly typed value the data layer accepts, respecting
// allow_unknown: false. No API calls here.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../../db";
import { accounts, businessProfiles, fieldRecords, offers } from "../../../db/schema";
import { loadBank } from "../../bank/loader";
import { readCurrentField } from "../../profile/field-store";
import type { ApplicableQuestion } from "../../resolver/applicability";
import { answerQuestion } from "./answers";
import { PERSONAS, rngFor } from "./personas";

let accountId: string;
let profileId: string;
const persona = PERSONAS[2]!; // hybrid-shop-classic

function question(partial: {
  id: string;
  writes_to: string;
  input: Record<string, unknown>;
  priority?: ApplicableQuestion["priority"];
}): ApplicableQuestion {
  return {
    id: partial.id,
    bank_version: "1.0.0",
    section: "identity",
    writes_to: partial.writes_to,
    priority: partial.priority ?? "core",
    cost: 1,
    prompt: {},
    help_text: null,
    input: partial.input,
    unlocks: null,
    already_answered: false,
  };
}

beforeAll(async () => {
  await loadBank("specs/question-bank-v1.json");
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
  await db.delete(offers).where(eq(offers.profile_id, profileId));
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

describe("persona answers, by input type", () => {
  const rng = rngFor(1);

  it("multi_select on identity.sells pins the persona's codes", async () => {
    await answerQuestion(
      profileId,
      persona,
      question({
        id: "1.4",
        writes_to: "identity.sells",
        input: { type: "multi_select", vocabulary_id: "sells_type", allow_unknown: false },
      }),
      rng,
    );
    const field = await readCurrentField<{ code: string }[]>(profileId, "identity.sells");
    expect(field?.value?.map((v) => v.code)).toEqual([...persona.sells]);
  });

  it("money answers are integer minor units in HUF — never a float", async () => {
    await answerQuestion(
      profileId,
      persona,
      question({ id: "4.2", writes_to: "revenue.monthly_revenue", input: { type: "money" } }),
      rng,
    );
    const field = await readCurrentField<{ amount_minor: number; currency: string }>(
      profileId,
      "revenue.monthly_revenue",
    );
    expect(field?.status).toBe("answered");
    if (field?.status === "answered") {
      expect(Number.isSafeInteger(field.value?.amount_minor)).toBe(true);
      expect(field.value?.currency).toBe("HUF");
    }
  });

  it("single_select picks a real vocabulary code, never 'other'", async () => {
    await answerQuestion(
      profileId,
      persona,
      question({
        id: "2.1",
        writes_to: "presence.type",
        input: { type: "single_select", vocabulary_id: "presence_type", allow_unknown: false },
      }),
      rng,
    );
    const field = await readCurrentField<{ code: string }>(profileId, "presence.type");
    expect(field?.value?.code).toBeTruthy();
    expect(field?.value?.code).not.toBe("other");
  });

  it("entity_list creates spine rows and a marker record", async () => {
    const outcome = await answerQuestion(
      profileId,
      persona,
      question({
        id: "3.1",
        writes_to: "offers",
        input: { type: "entity_list", entity_schema: "offer", allow_unknown: false },
      }),
      rng,
    );
    expect(outcome.entities_created).toBe(persona.sells.length);
    const spine = await db
      .select({ id: offers.id })
      .from(offers)
      .where(eq(offers.profile_id, profileId));
    expect(spine).toHaveLength(persona.sells.length);
    const marker = await readCurrentField<{ entity_ids: string[] }>(profileId, "offers");
    expect(marker?.value?.entity_ids).toHaveLength(persona.sells.length);
  });

  it("dynamic __offers__ vocabulary resolves to real offer ids", async () => {
    await answerQuestion(
      profileId,
      persona,
      question({
        id: "3.2",
        writes_to: "offers.best_seller_id",
        input: { type: "single_select", vocabulary_id: "__offers__" },
      }),
      rng,
    );
    const field = await readCurrentField<{ code: string }>(profileId, "offers.best_seller_id");
    const spine = await db
      .select({ id: offers.id })
      .from(offers)
      .where(eq(offers.profile_id, profileId));
    expect(spine.map((r) => r.id)).toContain(field?.value?.code);
  });

  it("file questions become an honest unknown, and a forced-unknown persona obeys allow_unknown: false", async () => {
    await answerQuestion(
      profileId,
      persona,
      question({ id: "14.1", writes_to: "assets.uploads", input: { type: "file" } }),
      rng,
    );
    const file = await readCurrentField(profileId, "assets.uploads");
    expect(file?.status).toBe("unknown");
    expect(file?.value).toBeNull();
    const unknownPersona = { ...persona, unknownRate: 1 };
    await answerQuestion(
      profileId,
      unknownPersona,
      question({
        id: "1.1",
        writes_to: "identity.legal_name",
        input: { type: "text", allow_unknown: false },
      }),
      rng,
    );
    const name = await readCurrentField<string>(profileId, "identity.legal_name");
    expect(name?.status).toBe("answered"); // unknownRate=1 overridden by allow_unknown:false
  });
});
