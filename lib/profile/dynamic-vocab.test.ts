// Regression guard for the bug the P0-52 harness found: a question whose
// options are the owner's own entities ("which channel is primary?")
// crashed the intake because only __offers__ was implemented.
//
// The first test is the one that matters long-term: EVERY dynamic
// vocabulary the bank references must resolve. Add a question using
// __suppliers__ tomorrow and this fails until the resolver knows it.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, channels, fieldRecords, offers } from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { dynamicVocabularyOptions, isDynamicVocabulary } from "./dynamic-vocab";
import { writeField } from "./field-store";

interface BankQuestion {
  id: string;
  input: { vocabulary_id?: string };
}

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
  await db.delete(channels).where(eq(channels.profile_id, profileId));
  await db.delete(offers).where(eq(offers.profile_id, profileId));
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

describe("every dynamic vocabulary in the bank resolves", () => {
  it("no question references a dynamic vocabulary the resolver cannot serve", () => {
    const bank = JSON.parse(readFileSync("specs/question-bank-v1.json", "utf8")) as {
      questions: BankQuestion[];
    };
    const dynamic = new Set(
      bank.questions
        .map((q) => q.input.vocabulary_id)
        .filter((v): v is string => typeof v === "string" && v.startsWith("__")),
    );
    expect(dynamic.size).toBeGreaterThan(0);
    const unresolvable = [...dynamic].filter((v) => !isDynamicVocabulary(v));
    expect(unresolvable).toEqual([]);
  });
});

describe("options are the owner's own rows, labelled with what they told us", () => {
  it("labels a channel by its platform, and falls back only when nothing is recorded", async () => {
    const [named] = await db.insert(channels).values({ profile_id: profileId }).returning();
    const [bare] = await db.insert(channels).values({ profile_id: profileId }).returning();
    if (!named || !bare) throw new Error("channel insert failed");

    const at = isoDateTime(new Date().toISOString());
    await writeField(
      profileId,
      createField<unknown>({
        id: fieldId(`channels.${named.id}.platform`),
        value: "Weekend markets",
        status: "answered",
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: at,
        recorded_at: at,
      }),
    );

    const options = await dynamicVocabularyOptions(profileId, "__channels__");
    expect(options).toHaveLength(2);
    expect(options.find((o) => o.code === named.id)?.label).toBe("Weekend markets");
    // The unnamed row still gets a usable label rather than an empty one.
    expect(options.find((o) => o.code === bare.id)?.label).toMatch(/^Channel \d$/);
  });

  it("returns an empty list — never throws — when the profile has no rows", async () => {
    await expect(dynamicVocabularyOptions(profileId, "__goals__")).resolves.toEqual([]);
  });

  it("ignores unknown vocabulary ids instead of inventing options", async () => {
    expect(isDynamicVocabulary("business_stage")).toBe(false);
    await expect(dynamicVocabularyOptions(profileId, "__nope__")).resolves.toEqual([]);
  });
});
