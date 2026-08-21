// Session K — completeness scorer.
// P0-45 weighting · P0-46 core_complete with explicit unknown · P0-47 blocking_gaps.
// Pure tests first; one live end-to-end at the bottom.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords } from "../../db/schema";
import { loadBank } from "../bank/loader";
import { enumValue } from "../core/enum-value";
import type { EnumValue } from "../core/enum-value";
import { createField } from "../core/field";
import type { FieldStatus } from "../core/field-status";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";
import type { ScorableQuestion } from "./completeness";
import { computeCompleteness, PRIORITY_WEIGHTS, scoreQuestions } from "./completeness";

const AT = isoDateTime("2026-08-21T09:00:00.000Z");

function q(
  priority: ScorableQuestion["priority"],
  responded: boolean,
  writes_to = `x.${priority}.${Math.abs(responded ? 1 : 0)}`,
  section: ScorableQuestion["section"] = "identity",
): ScorableQuestion {
  return { priority, section, writes_to, responded };
}

describe("P0-45 — weighted score, core heavy, optional near-zero", () => {
  it("core answers dominate: the important 25 alone score high, not 8%", () => {
    // 25 core answered; 100 important + 9 deep + 20 optional all unanswered.
    const questions = [
      ...Array.from({ length: 25 }, () => q("core", true)),
      ...Array.from({ length: 100 }, () => q("important", false)),
      ...Array.from({ length: 9 }, () => q("deep", false)),
      ...Array.from({ length: 20 }, () => q("optional", false)),
    ];
    const score = scoreQuestions(questions, AT);
    // 125 / (125 + 200 + 9 + 2) ≈ 0.372 — vs 25/154 ≈ 16% unweighted.
    expect(score.overall).toBeGreaterThan(0.35);
    expect(score.overall).toBeGreaterThan(25 / 154 + 0.15);
  });

  it("optional questions barely move the score in either direction", () => {
    const base = [...Array.from({ length: 10 }, () => q("core", true))];
    const withOptionals = [...base, ...Array.from({ length: 30 }, () => q("optional", false))];
    const s1 = scoreQuestions(base, AT).overall;
    const s2 = scoreQuestions(withOptionals, AT).overall;
    expect(s1).toBe(1);
    expect(s2).toBeGreaterThan(0.9); // 30 unanswered optionals cost < 0.1
  });

  it("by_section scores independently", () => {
    const score = scoreQuestions(
      [
        q("core", true, "identity.a", "identity"),
        q("core", true, "identity.b", "identity"),
        q("core", false, "revenue.a", "revenue"),
      ],
      AT,
    );
    expect(score.by_section.get("identity")).toBe(1);
    expect(score.by_section.get("revenue")).toBe(0);
  });

  it("weights are what §8.2 promises", () => {
    expect(PRIORITY_WEIGHTS.core).toBeGreaterThanOrEqual(2 * PRIORITY_WEIGHTS.important);
    expect(PRIORITY_WEIGHTS.optional).toBeLessThanOrEqual(0.1);
  });
});

describe("P0-46 — core_complete when the always-asked are answered or explicitly unknown", () => {
  it("true when every core question has a response — unknown counts", () => {
    const score = scoreQuestions(
      [q("core", true), q("core", true), q("important", false), q("deep", false)],
      AT,
    );
    expect(score.core_complete).toBe(true);
  });

  it("false while any core question is unresponded", () => {
    expect(scoreQuestions([q("core", true), q("core", false)], AT).core_complete).toBe(false);
  });
});

describe("P0-47 — blocking_gaps lists exactly the unresponded core targets", () => {
  it("names core gaps and nothing else", () => {
    const score = scoreQuestions(
      [
        q("core", false, "identity.sells"),
        q("core", true, "identity.legal_name"),
        q("important", false, "marketing.budget"),
        q("deep", false, "operations.process_docs"),
      ],
      AT,
    );
    expect(score.blocking_gaps).toEqual(["identity.sells"]);
  });
});

describe("end to end against a live profile", () => {
  let accountId: string;
  let profileId: string;

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
    await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
    await db.delete(accounts).where(eq(accounts.id, accountId));
  });

  it("an empty profile: zero score, the 25 always-asked core gaps + one not-gate", async () => {
    const score = await computeCompleteness(profileId);
    expect(score.overall).toBe(0);
    expect(score.core_complete).toBe(false);
    // 25 unconditioned core, plus 1.5b (identity.founded): its gate is
    // not(eq(stage, "idea")), and under missing-value-false semantics an
    // unknown stage means "not known to be an idea" — the question exists
    // until the owner says otherwise. Deliberate, not drift.
    expect(score.blocking_gaps).toHaveLength(26);
    expect(score.blocking_gaps).toContain("identity.founded");
  });

  it("answers and explicit unknowns both raise the score and shrink the gaps", async () => {
    const write = (key: string, value: EnumValue[] | string | null, status: FieldStatus) =>
      writeField(
        profileId,
        createField<EnumValue[] | string>({
          id: fieldId(key),
          value,
          status,
          confidence: 0.75,
          source: { kind: "owner_input" },
          observed_at: AT,
          recorded_at: AT,
          note: null,
        }),
      );
    await write("identity.sells", [enumValue("services")], "answered");
    await write("identity.legal_name", "Szörp Kft.", "answered");
    await write("revenue.monthly_revenue", null, "unknown"); // honest gap, still progress

    const score = await computeCompleteness(profileId);
    expect(score.overall).toBeGreaterThan(0);
    expect(score.blocking_gaps).not.toContain("identity.sells");
    expect(score.blocking_gaps).not.toContain("identity.legal_name");
    expect(score.blocking_gaps).not.toContain("revenue.monthly_revenue");
    expect(score.core_complete).toBe(false); // plenty of core still open
    expect(score.by_section.get("identity")).toBeGreaterThan(0);
  });
});
