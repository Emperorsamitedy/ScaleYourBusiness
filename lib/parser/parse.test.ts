// Session M — the parser's deterministic behaviors, proven offline via
// the injectable LLM seam. The live-Haiku path is verify-parser.ts
// (P0-58), deferred to the credits batch with Session L's runs.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords } from "../../db/schema";
import { loadBank } from "../bank/loader";
import { money } from "../core/money";
import type { InputSpec } from "../interviewer/harness/answers";
import { readCurrentField } from "../profile/field-store";
import type { ApplicableQuestion } from "../resolver/applicability";
import { applicableQuestions } from "../resolver/applicability";
import { selectCandidates } from "../interviewer/select";
import { coerceParsedValue } from "./coerce";
import type { ExtractionLlm } from "./parse";
import { CONFIDENCE_ESTIMATED, CONFIDENCE_PRECISE, parseAndWriteAnswer } from "./parse";

const HUF = "HUF";

function q(id: string, writes_to: string, input: InputSpec): ApplicableQuestion {
  return {
    id,
    bank_version: "1.0.0",
    section: "revenue",
    writes_to,
    priority: "core",
    cost: 1,
    prompt: { en: `Question ${id}` },
    help_text: null,
    input,
    unlocks: null,
    already_answered: false,
  };
}

/** Canned-response LLM: returns a fixed extraction, records the prompt. */
function fakeLlm(fields: unknown): { llm: ExtractionLlm; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    llm: ({ user }) => {
      prompts.push(user);
      return Promise.resolve({ text: JSON.stringify({ fields }), calls: [] });
    },
  };
}

describe("coercion — P0-58's arithmetic, deterministic", () => {
  it('"about 4 and a half million a month" wire form → exact HUF minor units', () => {
    // Haiku's wire form for the canonical sentence:
    const wire = { amount_major: 4_500_000 };
    const result = coerceParsedValue({ type: "money" }, wire, [], HUF);
    expect(result).toEqual({ ok: true, value: money(450_000_000_00 / 100, HUF) });
    if (result.ok) expect(result.value).toEqual(money(450_000_000, HUF));
  });

  it("money without a currency inherits the reporting currency; named currency wins", () => {
    const inherit = coerceParsedValue({ type: "money" }, { amount_major: 250 }, [], HUF);
    if (!inherit.ok) throw new Error(inherit.reason);
    expect(inherit.value).toEqual(money(25_000, "HUF"));
    const named = coerceParsedValue(
      { type: "money" },
      { amount_major: 250, currency: "eur" },
      [],
      HUF,
    );
    if (!named.ok) throw new Error(named.reason);
    expect(named.value).toEqual(money(25_000, "EUR"));
  });

  it("refuses codes outside the vocabulary and non-finite numbers", () => {
    expect(coerceParsedValue({ type: "single_select" }, "banana", ["a", "b"], HUF).ok).toBe(false);
    expect(coerceParsedValue({ type: "number" }, Number.NaN, [], HUF).ok).toBe(false);
    expect(coerceParsedValue({ type: "date" }, "2026-02-30", [], HUF).ok).toBe(false);
  });

  it("never fabricates entities or files from text", () => {
    expect(coerceParsedValue({ type: "entity_list" }, [], [], HUF).ok).toBe(false);
    expect(coerceParsedValue({ type: "file" }, "x", [], HUF).ok).toBe(false);
  });
});

describe("parser behaviors over a live profile (fake LLM)", () => {
  let accountId: string;
  let profileId: string;

  beforeAll(async () => {
    await loadBank("specs/question-bank-v1.json");
    const [account] = await db
      .insert(accounts)
      .values({ reporting_currency: HUF, locale: "hu-HU" })
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

  it("P0-55+58 shape: estimate lowers confidence to 0.55 and keeps the wording in note", async () => {
    const asked = q("4.2", "revenue.monthly_revenue", { type: "money" });
    const { llm } = fakeLlm([
      {
        field_key: "revenue.monthly_revenue",
        value: { amount_major: 4_500_000 },
        is_estimate: true,
        estimate_wording: "about 4 and a half million a month, before tax",
      },
    ]);
    const outcome = await parseAndWriteAnswer({
      accountId,
      profileId,
      asked,
      otherOpen: [],
      rawText: "about 4 and a half million a month, before tax",
      reportingCurrency: HUF,
      llm,
    });
    expect(outcome.written).toEqual([
      {
        field_key: "revenue.monthly_revenue",
        confidence: CONFIDENCE_ESTIMATED,
        note: "about 4 and a half million a month, before tax",
      },
    ]);
    const field = await readCurrentField<{ amount_minor: number; currency: string }>(
      profileId,
      "revenue.monthly_revenue",
    );
    expect(field?.value).toEqual(money(450_000_000, HUF));
    expect(field?.confidence).toBe(CONFIDENCE_ESTIMATED);
    expect(field?.note).toBe("about 4 and a half million a month, before tax");
  });

  it("P0-56: one paragraph fills several fields; precise ones enter at 0.75", async () => {
    const asked = q("1.6", "identity.team_size", { type: "number" });
    const others = [
      q("4.4", "revenue.order_count_monthly", { type: "number" }),
      q("4.5", "revenue.repeat_customer_rate", { type: "number" }),
    ];
    const { llm, prompts } = fakeLlm([
      { field_key: "identity.team_size", value: 3, is_estimate: false, estimate_wording: null },
      {
        field_key: "revenue.order_count_monthly",
        value: 120,
        is_estimate: true,
        estimate_wording: "maybe 120 orders",
      },
    ]);
    const outcome = await parseAndWriteAnswer({
      accountId,
      profileId,
      asked,
      otherOpen: others,
      rawText: "we're three people, doing maybe 120 orders a month",
      reportingCurrency: HUF,
      llm,
    });
    expect(outcome.written).toHaveLength(2);
    expect(outcome.written[0]?.confidence).toBe(CONFIDENCE_PRECISE);
    expect(outcome.written[1]?.confidence).toBe(CONFIDENCE_ESTIMATED);
    // The prompt offered the other open questions to the extractor.
    expect(prompts[0]).toContain("revenue.repeat_customer_rate");
    // The unanswered other question was NOT written.
    expect(await readCurrentField(profileId, "revenue.repeat_customer_rate")).toBeNull();
  });

  it("rejects extractions for keys that were never offered, and malformed values — nothing enters the profile", async () => {
    const asked = q("1.1", "identity.legal_name", { type: "text" });
    const { llm } = fakeLlm([
      { field_key: "costs.debt", value: 999, is_estimate: false, estimate_wording: null },
      { field_key: "identity.legal_name", value: 42, is_estimate: false, estimate_wording: null },
    ]);
    const outcome = await parseAndWriteAnswer({
      accountId,
      profileId,
      asked,
      otherOpen: [],
      rawText: "irrelevant",
      reportingCurrency: HUF,
      llm,
    });
    expect(outcome.written).toEqual([]);
    expect(outcome.rejected.map((r) => r.field_key).sort()).toEqual([
      "costs.debt",
      "identity.legal_name",
    ]);
    expect(await readCurrentField(profileId, "costs.debt")).toBeNull();
  });

  it("P0-57: fields the paragraph answered are no longer candidates for the interviewer", async () => {
    // team_size and order_count were parser-written above. Recompute the
    // candidate set exactly as pickNextQuestion does.
    const applicable = await applicableQuestions(profileId);
    const responded = new Set(
      (
        await db
          .select({ field_key: fieldRecords.field_key })
          .from(fieldRecords)
          .where(eq(fieldRecords.profile_id, profileId))
      ).map((r) => r.field_key),
    );
    const selection = selectCandidates(applicable, responded, new Set());
    const candidateKeys = new Set(selection.candidates.map((c) => c.writes_to));
    expect(candidateKeys.has("identity.team_size")).toBe(false);
    expect(candidateKeys.has("revenue.monthly_revenue")).toBe(false);
    expect(candidateKeys.has("revenue.order_count_monthly")).toBe(false);
    // Untouched questions are still open.
    expect(candidateKeys.size).toBeGreaterThan(0);
  });
});
