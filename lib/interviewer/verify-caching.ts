// P0-50 / step 23 — live verification that the bank is served from cache.
//
// Two real interviewer turns on a scratch profile. Turn 1 writes the
// cache (cache_creation_input_tokens > 0 on a cold cache); turn 2 MUST
// show cache_read_input_tokens covering the bank, or rule 8 is being
// violated and the interviewer costs ~8x its model. Exits non-zero on
// failure. Run: npm run verify:caching

import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords } from "../../db/schema";
import { loadBank } from "../bank/loader";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";
import { pickNextQuestion } from "./interviewer";

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
    console.log("— turn 1 (cache cold or warm from a previous run) —");
    const t1 = await pickNextQuestion({ accountId: account.id, profileId: profile.id, asked: [] });
    if (!t1) throw new Error("turn 1 returned no question on an empty profile");
    const u1 = t1.calls[0];
    if (!u1) throw new Error("turn 1 made no call");
    console.log(`  picked ${t1.question.id} — ${t1.selection_reason}`);

    // Answer it so turn 2 is a genuinely different request suffix.
    const at = isoDateTime(new Date().toISOString());
    await writeField(
      profile.id,
      createField<string>({
        id: fieldId(t1.question.writes_to),
        value: "Cache Verification Kft.",
        status: "answered",
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: at,
        recorded_at: at,
        note: null,
      }),
    );

    console.log("— turn 2 (MUST read the bank from cache) —");
    const t2 = await pickNextQuestion({
      accountId: account.id,
      profileId: profile.id,
      asked: [{ question_id: t1.question.id, answer_repr: '"Cache Verification Kft."' }],
    });
    if (!t2) throw new Error("turn 2 returned no question");
    const u2 = t2.calls[0];
    if (!u2) throw new Error("turn 2 made no call");
    console.log(`  picked ${t2.question.id} — ${t2.selection_reason}`);

    console.log("\nusage:");
    console.table(
      [u1, u2].map((u, i) => ({
        turn: i + 1,
        input: u.input_tokens,
        cache_write: u.cache_creation_input_tokens,
        cache_read: u.cache_read_input_tokens,
        output: u.output_tokens,
        eur: u.cost_eur.toFixed(5),
      })),
    );

    const cachedPortion = u2.cache_read_input_tokens;
    const uncachedPortion = u2.input_tokens;
    if (cachedPortion < 1024) {
      throw new Error(
        `FAIL: turn 2 cache_read_input_tokens = ${cachedPortion} — the bank is not being served from cache`,
      );
    }
    if (uncachedPortion > 5000) {
      throw new Error(
        `FAIL: turn 2 uncached input = ${uncachedPortion} tokens — volatile content has leaked ahead of the breakpoint`,
      );
    }
    console.log(
      `\nPASS — turn 2 read ${cachedPortion} tokens from cache; only ${uncachedPortion} uncached (volatile turn state).`,
    );
  } finally {
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profile.id));
    // decision_log rows stay — append-only by design, and profile_id is
    // deliberately not an FK, so profile deletion is unblocked.
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
