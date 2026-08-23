// Session R — P0-87 telemetry: validation at the sink, honest aggregates,
// abandonment attributed to the last question a profile ever saw.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles } from "../../db/schema";
import { profileTrail, recordIntakeEvents, summarizeIntakeTelemetry } from "./telemetry";

let accountA: string;
let profileA: string;
let accountB: string;
let profileB: string;

async function mkProfile(): Promise<[string, string]> {
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
  return [account.id, profile.id];
}

beforeAll(async () => {
  [accountA, profileA] = await mkProfile();
  [accountB, profileB] = await mkProfile();
});

afterAll(async () => {
  for (const [account, profile] of [
    [accountA, profileA],
    [accountB, profileB],
  ] as const) {
    await db.delete(businessProfiles).where(eq(businessProfiles.id, profile)); // events cascade
    await db.delete(accounts).where(eq(accounts.id, account));
  }
});

describe("recordIntakeEvents — the sink validates hard", () => {
  it("accepts valid events, drops malformed ones, clamps outliers", async () => {
    const accepted = await recordIntakeEvents(profileA, [
      { kind: "question_shown", question_id: "1.1" },
      { kind: "first_input", question_id: "1.1", ms_since_shown: 1200 },
      { kind: "answer_recorded", question_id: "1.1", ms_since_shown: 5000 },
      { kind: "nonsense" }, // unknown kind — dropped
      "not an object", // dropped
      { kind: "question_shown", question_id: "4.2", ms_since_shown: 99_999_999 }, // clamped
    ]);
    expect(accepted).toBe(4);
    const rows = await profileTrail(profileA);
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)?.ms_since_shown).toBe(3_600_000); // one-hour clamp
  });

  it("refuses non-arrays outright", async () => {
    expect(await recordIntakeEvents(profileA, { kind: "question_shown" })).toBe(0);
    expect(await recordIntakeEvents(profileA, null)).toBe(0);
  });
});

describe("summarizeIntakeTelemetry — the P0-88 input", () => {
  it("aggregates per question and attributes abandonment to the trail's end", async () => {
    // Profile A's trail (above) ends at question_shown 4.2 → abandonment.
    // Profile B answers 1.1 slowly and skips 4.2 — no abandonment.
    await recordIntakeEvents(profileB, [
      { kind: "question_shown", question_id: "1.1" },
      { kind: "first_input", question_id: "1.1", ms_since_shown: 8000 },
      { kind: "answer_recorded", question_id: "1.1", ms_since_shown: 20_000 },
      { kind: "question_shown", question_id: "4.2" },
      { kind: "skipped", question_id: "4.2", ms_since_shown: 3000 },
      { kind: "page_hidden" },
    ]);

    const summary = await summarizeIntakeTelemetry([profileA, profileB]);
    const q11 = summary.find((r) => r.question_id === "1.1");
    const q42 = summary.find((r) => r.question_id === "4.2");
    if (!q11 || !q42) throw new Error("expected both questions in the summary");

    expect(q11.shown).toBe(2);
    expect(q11.answered).toBe(2);
    expect(q11.median_hesitation_ms).toBe(4600); // median of 1200, 8000
    expect(q11.median_dwell_ms).toBe(12_500); // median of 5000, 20000
    expect(q11.abandonments).toBe(0);

    expect(q42.shown).toBe(2);
    expect(q42.skipped).toBe(1);
    // A's trail ends at 4.2 question_shown; B's ends in a skip.
    expect(q42.abandonments).toBe(1);
    // Abandonment-heavy questions sort first — the rewrite queue.
    expect(summary[0]?.question_id).toBe("4.2");
  });
});
