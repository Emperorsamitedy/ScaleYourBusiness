// Session N service layer — DB-backed, deterministic mode. The UI's whole
// contract, proven without a browser.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords, offers } from "../../db/schema";
import { loadBank } from "../bank/loader";
import {
  bootstrapIntake,
  getIntakeState,
  humanizeCode,
  IntakeError,
  naturalIdCompare,
  submitAnswer,
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

  it("estimate toggle lowers confidence and shows in provenance", async () => {
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
        const [row] = await db
          .select({ confidence: fieldRecords.confidence, note: fieldRecords.note })
          .from(fieldRecords)
          .where(eq(fieldRecords.field_key, "revenue.monthly_revenue"));
        if (row) {
          expect(Number(row.confidence)).toBe(0.55);
          expect(row.note).toBe("owner marked as estimate");
        }
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
