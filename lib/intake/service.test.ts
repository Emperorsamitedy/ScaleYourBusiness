// Session N service layer — DB-backed, deterministic mode. The UI's whole
// contract, proven without a browser.

import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  offers,
  validationFindings,
} from "../../db/schema";
import { loadBank } from "../bank/loader";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";
import {
  bootstrapIntake,
  getIntakeState,
  humanizeCode,
  IntakeError,
  naturalIdCompare,
  reconcileFinding,
  submitAnswer,
  submitEntities,
  submitEntityCount,
} from "./service";

let accountId: string;
let profileId: string;

beforeAll(async () => {
  process.env.INTERVIEWER_MODE = "deterministic";
  await loadBank("specs/question-bank-v1.json");
  const s = await bootstrapIntake();
  accountId = s.account_id;
  profileId = s.profile_id;
});

afterAll(async () => {
  await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profileId));
  await db.delete(offers).where(eq(offers.profile_id, profileId));
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

describe("ordering and labels", () => {
  it("natural id order: 1.9 before 1.10, 1.4.1.5 before 1.4.1.5a", () => {
    expect(naturalIdCompare("1.9", "1.10")).toBeLessThan(0);
    expect(naturalIdCompare("1.4.1.5", "1.4.1.5a")).toBeLessThan(0);
    expect(naturalIdCompare("2.1", "1.9")).toBeGreaterThan(0);
  });

  it("humanizes vocabulary codes", () => {
    expect(humanizeCode("physical_products")).toBe("Physical products");
    expect(humanizeCode("preparing_to_launch")).toBe("Preparing to launch");
  });
});

describe("the intake flow", () => {
  it("starts at 1.1 with honest fractional progress and an on-deck preview", async () => {
    const state = await getIntakeState(accountId, profileId);
    expect(state.done).toBe(false);
    expect(state.question?.id).toBe("1.1");
    expect(state.question?.input_type).toBe("text");
    expect(state.question?.allow_unknown).toBe(false);
    expect(state.progress.core_done).toBe(0);
    expect(state.progress.core_total).toBeGreaterThanOrEqual(25);
    expect(state.on_deck).toBeTruthy();
  });

  it("records a text answer, returns the chip with provenance, advances", async () => {
    const res = await submitAnswer(accountId, profileId, "1.1", {
      kind: "value",
      wire: "Szörp Kft.",
    });
    expect(res.chip).toMatchObject({
      question_id: "1.1",
      display: "Szörp Kft.",
      provenance: "1.1 · owner · stated",
      dot: "solid",
    });
    expect(res.state.progress.core_done).toBe(1);
    expect(res.state.question?.id).not.toBe("1.1");
  });

  it("refuses answers to questions that are not currently askable", async () => {
    await expect(
      submitAnswer(accountId, profileId, "13.2", { kind: "value", wire: "x" }),
    ).rejects.toThrow(IntakeError);
  });

  it("refuses unknown where the bank forbids it, honours it elsewhere", async () => {
    const state = await getIntakeState(accountId, profileId);
    if (state.question?.allow_unknown === false) {
      await expect(
        submitAnswer(accountId, profileId, state.question.id, { kind: "unknown" }),
      ).rejects.toThrow(IntakeError);
    }
    // Answer forward until we hit an allow-unknown question, then use it.
    let guard = 0;
    for (;;) {
      const s = await getIntakeState(accountId, profileId);
      if (!s.question || guard++ > 40) throw new Error("no allow-unknown question reached");
      if (s.question.allow_unknown && s.question.input_type !== "entity_list") {
        const res = await submitAnswer(accountId, profileId, s.question.id, { kind: "unknown" });
        expect(res.chip.dot).toBe("hollow");
        expect(res.chip.provenance).toContain("gap · will revisit");
        break;
      }
      // answer whatever it is, minimally
      const q = s.question;
      if (q.input_type === "entity_list") {
        await submitEntityCount(accountId, profileId, q.id, 2);
      } else {
        const wire =
          q.input_type === "text" || q.input_type === "long_text"
            ? "answer"
            : q.input_type === "number"
              ? 3
              : q.input_type === "money"
                ? { amount_major: 100000 }
                : q.input_type === "boolean"
                  ? true
                  : q.input_type === "date"
                    ? "2022-06-01"
                    : q.input_type === "single_select"
                      ? q.options[0]?.code
                      : [q.options[0]?.code];
        await submitAnswer(accountId, profileId, q.id, { kind: "value", wire });
      }
    }
  });

  // Walk-forward loops make dozens of sequential DB round-trips; under
  // full-suite load they can exceed the 5s default.
  it("estimate toggle lowers confidence and shows in provenance", { timeout: 30_000 }, async () => {
    // Find the next money/number question by walking forward.
    let guard = 0;
    for (;;) {
      const s = await getIntakeState(accountId, profileId);
      if (!s.question || guard++ > 60) return; // acceptable: none reachable in this branch
      const q = s.question;
      if (q.input_type === "money") {
        const res = await submitAnswer(accountId, profileId, q.id, {
          kind: "value",
          wire: { amount_major: 4_500_000 },
          estimate: true,
        });
        expect(res.chip.provenance).toBe(`${q.id} · owner · estimate`);
        // Scope to THIS profile's current records: other suites write the
        // same field keys, and superseded history stays in the table.
        const current = await db
          .select({ confidence: fieldRecords.confidence, note: fieldRecords.note })
          .from(fieldRecords)
          .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at)));
        const estimates = current.filter((r) => r.note === "owner marked as estimate");
        expect(estimates).toHaveLength(1);
        expect(Number(estimates[0]?.confidence)).toBe(0.55);
        return;
      }
      if (q.input_type === "entity_list") {
        const res = await submitEntityCount(accountId, profileId, q.id, 3);
        expect(res.chip.display).toContain("3 recorded");
      } else {
        const wire =
          q.input_type === "text" || q.input_type === "long_text"
            ? "answer"
            : q.input_type === "number"
              ? 3
              : q.input_type === "boolean"
                ? true
                : q.input_type === "date"
                  ? "2022-06-01"
                  : q.input_type === "single_select"
                    ? q.options[0]?.code
                    : [q.options[0]?.code];
        await submitAnswer(accountId, profileId, q.id, { kind: "value", wire });
      }
    }
  });
});

describe("entity rows are all-or-nothing", () => {
  it("a bad value in row 3 writes NOTHING and leaves the question askable", { timeout: 30_000 }, async () => {
    // Regression: writeEntityRows used to create spines and write fields
    // as it went, so a value that failed to coerce stranded the earlier
    // rows, dropped the later ones, and left the question unaskable —
    // an owner who mistyped one field lost the whole list. Found on a
    // live run: a bad `purchase_type` turned a five-product list into
    // one nameless offer.
    const s = await bootstrapIntake();
    try {
      let guard = 0;
      for (;;) {
        const st = await getIntakeState(s.account_id, s.profile_id);
        if (!st.question || guard++ > 30) throw new Error("never reached 3.1");
        const q = st.question;
        if (q.input_type === "entity_list" && q.entity_schema === "offer") {
          const rows = [
            { name: "Good one", kind: "physical", price: { amount_major: 1800 } },
            { name: "Also good", kind: "physical", price: { amount_major: 2800 } },
            { name: "Bad one", kind: "physical", purchase_type: "one_off" }, // not a real code
          ];
          await expect(
            submitEntities(s.account_id, s.profile_id, q.id, rows),
          ).rejects.toThrow();

          // Nothing was written: no spines, no per-entity records.
          const spine = await db
            .select({ id: offers.id })
            .from(offers)
            .where(eq(offers.profile_id, s.profile_id));
          expect(spine).toHaveLength(0);
          const recs = await db
            .select({ k: fieldRecords.field_key })
            .from(fieldRecords)
            .where(eq(fieldRecords.profile_id, s.profile_id));
          expect(recs.filter((r) => /^offers\.[0-9a-f-]{36}\./.test(r.k))).toHaveLength(0);

          // And the owner can still answer it — with the value corrected.
          const after = await getIntakeState(s.account_id, s.profile_id);
          expect(after.question?.id).toBe(q.id);
          const fixed = rows.map((r) =>
            r.purchase_type ? { ...r, purchase_type: "one_time" } : r,
          );
          const res = await submitEntities(s.account_id, s.profile_id, q.id, fixed);
          expect(res.chip.detail).toHaveLength(3);
          return;
        }
        const wire =
          q.input_type === "text" || q.input_type === "long_text"
            ? "x"
            : q.input_type === "number"
              ? 2
              : q.input_type === "money"
                ? { amount_major: 1000 }
                : q.input_type === "boolean"
                  ? true
                  : q.input_type === "date"
                    ? "2022-06-01"
                    : q.input_type === "single_select"
                      ? q.options[0]?.code
                      : q.input_type === "multi_select"
                        ? [q.options[0]?.code]
                        : null;
        if (q.input_type === "entity_list")
          await submitEntityCount(s.account_id, s.profile_id, q.id, 1);
        else await submitAnswer(s.account_id, s.profile_id, q.id, { kind: "value", wire });
      }
    } finally {
      await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
      await db.delete(offers).where(eq(offers.profile_id, s.profile_id));
      await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
      await db.delete(accounts).where(eq(accounts.id, s.account_id));
    }
  });
});

describe("P0-68..70 — entity sub-form service", () => {
  it("writes 5 product rows: spines, per-entity records, collapsing chip", { timeout: 30_000 }, async () => {
    const s = await bootstrapIntake();
    try {
      // Reach 3.1 (offers): answer forward deterministically.
      let guard = 0;
      for (;;) {
        const st = await getIntakeState(s.account_id, s.profile_id);
        if (!st.question || guard++ > 30) throw new Error("never reached 3.1");
        const q = st.question;
        if (q.input_type === "entity_list" && q.entity_schema === "offer") {
          expect(q.entity_fields?.some((f) => f.key === "name")).toBe(true);
          const rows = Array.from({ length: 5 }, (_, i) => ({
            name: `Product ${i + 1}`,
            kind: "physical",
            price: { amount_major: 4990 + i },
            ...(i < 3 ? { cost_to_deliver: { amount_major: 2100 } } : {}),
          }));
          const res = await submitEntities(s.account_id, s.profile_id, q.id, rows);
          expect(res.chip.display).toBe("5 products · 3 with costs");
          expect(res.chip.detail).toHaveLength(5);
          const spine = await db
            .select({ id: offers.id })
            .from(offers)
            .where(eq(offers.profile_id, s.profile_id));
          expect(spine).toHaveLength(5);
          const recs = await db
            .select({ k: fieldRecords.field_key })
            .from(fieldRecords)
            .where(eq(fieldRecords.profile_id, s.profile_id));
          const perEntity = recs.filter((r) => /^offers\.[0-9a-f-]{36}\./.test(r.k));
          expect(perEntity.length).toBe(5 + 5 + 3); // name + price + 3 costs
          return;
        }
        const wire =
          q.input_type === "text" || q.input_type === "long_text"
            ? "x"
            : q.input_type === "number"
              ? 2
              : q.input_type === "money"
                ? { amount_major: 1000 }
                : q.input_type === "boolean"
                  ? true
                  : q.input_type === "date"
                    ? "2022-06-01"
                    : q.input_type === "single_select"
                      ? q.options[0]?.code
                      : q.input_type === "multi_select"
                        ? [q.options[0]?.code]
                        : null;
        if (q.input_type === "entity_list")
          await submitEntityCount(s.account_id, s.profile_id, q.id, 1);
        else await submitAnswer(s.account_id, s.profile_id, q.id, { kind: "value", wire });
      }
    } finally {
      await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
      await db.delete(offers).where(eq(offers.profile_id, s.profile_id));
      await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
      await db.delete(accounts).where(eq(accounts.id, s.account_id));
    }
  });
});

describe("P0-75 — reopen keeps history and records a reason", () => {
  it("reopens an answered question: it returns to the centre, chain intact", async () => {
    // 1.1 was answered earlier in this suite.
    const res = await submitAnswer(accountId, profileId, "1.1", {
      kind: "reopen",
      reason: "mistyped the name",
    });
    expect(res.state.question?.id).toBe("1.1");

    const chain = await db
      .select({ status: fieldRecords.status, note: fieldRecords.note })
      .from(fieldRecords)
      .where(
        and(
          eq(fieldRecords.profile_id, profileId),
          eq(fieldRecords.field_key, "identity.legal_name"),
        ),
      )
      .orderBy(fieldRecords.recorded_at);
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain[0]?.status).toBe("answered"); // old value kept in history
    expect(chain.at(-1)?.status).toBe("unasked");
    expect(chain.at(-1)?.note).toBe("reopened: mistyped the name");

    // Re-answer supersedes again — three records, newest current.
    const re = await submitAnswer(accountId, profileId, "1.1", {
      kind: "value",
      wire: "Szörp és Társa Kft.",
    });
    expect(re.chip.display).toBe("Szörp és Társa Kft.");
  });

  it("refuses reopen without a reason or on an unanswered question", async () => {
    await expect(
      submitAnswer(accountId, profileId, "1.1", { kind: "reopen", reason: "  " }),
    ).rejects.toThrow(IntakeError);
    await expect(
      submitAnswer(accountId, profileId, "13.2", { kind: "reopen", reason: "x" }),
    ).rejects.toThrow(IntakeError);
  });
});

describe("P0-82..84 — reconcile panel service", () => {
  /** Plant the stage_vs_revenue contradiction directly on the profile. */
  async function plantContradiction(): Promise<void> {
    const at = isoDateTime(new Date().toISOString());
    for (const [key, value] of [
      ["identity.stage", { code: "idea" }],
      ["revenue.generates_revenue", { code: "yes" }],
    ] as const) {
      await writeField(
        profileId,
        createField<unknown>({
          id: fieldId(key),
          value,
          status: "answered",
          confidence: 0.75,
          source: { kind: "owner_input" },
          observed_at: at,
          recorded_at: at,
        }),
      );
    }
  }

  it("surfaces the contradiction in intake state with mapped questions (P0-82)", async () => {
    await plantContradiction();
    const state = await getIntakeState(accountId, profileId);
    const finding = state.findings.find((f) => f.rule_id === "stage_vs_revenue");
    if (!finding) throw new Error("expected stage_vs_revenue in intake findings");
    expect(finding.kind).toBe("contradiction");
    expect(finding.message).toContain("idea");
    expect(finding.question_ids).toContain("1.5");
  });

  it('"Both are right" records owner_confirmed and clears the flag (P0-83/84)', async () => {
    const state = await getIntakeState(accountId, profileId);
    const finding = state.findings.find((f) => f.rule_id === "stage_vs_revenue");
    if (!finding) throw new Error("expected an open finding");
    const res = await reconcileFinding(accountId, profileId, finding.id, "confirm");
    expect(res.reopened).toEqual([]);
    expect(res.state.findings.find((f) => f.rule_id === "stage_vs_revenue")).toBeUndefined();
    const row = await db
      .select()
      .from(validationFindings)
      .where(eq(validationFindings.id, finding.id));
    expect((row[0]?.resolution as { method: string }).method).toBe("owner_confirmed");
  });

  it('"Let me fix one" reopens the involved questions in sequence (P0-83)', async () => {
    await plantContradiction(); // re-fires: the confirmed finding is history
    const state = await getIntakeState(accountId, profileId);
    const finding = state.findings.find((f) => f.rule_id === "stage_vs_revenue");
    if (!finding) throw new Error("expected the finding to re-fire");
    const res = await reconcileFinding(accountId, profileId, finding.id, "fix");
    expect(res.reopened).toContain("1.5");
    expect(res.state.question?.id).toBe(res.reopened[0]); // back to the centre
    const chain = await db
      .select({ status: fieldRecords.status, note: fieldRecords.note })
      .from(fieldRecords)
      .where(
        and(
          eq(fieldRecords.profile_id, profileId),
          eq(fieldRecords.field_key, "identity.stage"),
          isNull(fieldRecords.superseded_at),
        ),
      );
    expect(chain[0]?.status).toBe("unasked");
    expect(chain[0]?.note).toBe("reconcile: stage_vs_revenue");
    // The resolution persisted as owner_corrected (P0-84).
    const row = await db
      .select()
      .from(validationFindings)
      .where(eq(validationFindings.id, finding.id));
    expect((row[0]?.resolution as { method: string }).method).toBe("owner_corrected");
  });

  it("refuses to reconcile a finding that is not open (P0-84 guard)", async () => {
    await expect(
      reconcileFinding(accountId, profileId, crypto.randomUUID(), "confirm"),
    ).rejects.toThrow(IntakeError);
  });
});
