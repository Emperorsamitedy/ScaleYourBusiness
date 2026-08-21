// P0-58 / step 24 — live verification of the Haiku parser on the spec's
// canonical sentence. Run with credits: npm run verify:parser
//
// "about 4 and a half million a month, before tax" must become
// Money(450_000_000 fillér, HUF) at confidence 0.55 with the owner's
// wording preserved in note. Exits non-zero otherwise.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords } from "../../db/schema";
import { loadBank } from "../bank/loader";
import { money } from "../core/money";
import { readCurrentField } from "../profile/field-store";
import { applicableQuestions } from "../resolver/applicability";
import { CONFIDENCE_ESTIMATED, parseAndWriteAnswer } from "./parse";

const SENTENCE = "about 4 and a half million a month, before tax";

async function main(): Promise<void> {
  await loadBank("specs/question-bank-v1.json");

  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: "HUF", locale: "hu-HU" })
    .returning();
  if (!account) throw new Error("account insert failed");
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: account.id, schema_version: "1.0.0" })
    .returning();
  if (!profile) throw new Error("profile insert failed");

  try {
    const applicable = await applicableQuestions(profile.id);
    const asked = applicable.find((q) => q.writes_to === "revenue.monthly_revenue");
    if (!asked) throw new Error("revenue.monthly_revenue is not applicable on an empty profile");
    const otherOpen = applicable.filter((q) => q.id !== asked.id).slice(0, 10);

    console.log(`parsing: "${SENTENCE}"`);
    const outcome = await parseAndWriteAnswer({
      accountId: account.id,
      profileId: profile.id,
      asked,
      otherOpen,
      rawText: SENTENCE,
      reportingCurrency: "HUF",
    });
    console.log("written :", outcome.written);
    console.log("rejected:", outcome.rejected);

    const field = await readCurrentField<{ amount_minor: number; currency: string }>(
      profile.id,
      "revenue.monthly_revenue",
    );
    if (!field) throw new Error("FAIL: nothing written to revenue.monthly_revenue");

    const expected = money(450_000_000, "HUF");
    const checks: [string, boolean][] = [
      [
        `value = 450,000,000 fillér HUF (got ${JSON.stringify(field.value)})`,
        JSON.stringify(field.value) === JSON.stringify(expected),
      ],
      [
        `confidence = ${CONFIDENCE_ESTIMATED} (got ${field.confidence})`,
        field.confidence === CONFIDENCE_ESTIMATED,
      ],
      [
        `note preserves wording (got ${JSON.stringify(field.note)})`,
        typeof field.note === "string" && field.note.toLowerCase().includes("about"),
      ],
    ];
    let failed = false;
    for (const [label, ok] of checks) {
      console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
      if (!ok) failed = true;
    }
    if (failed) throw new Error("P0-58 verification failed");
    console.log("\nP0-58 PASS — parser verified live.");
  } finally {
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profile.id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, profile.id));
    await db.delete(accounts).where(eq(accounts.id, account.id));
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
