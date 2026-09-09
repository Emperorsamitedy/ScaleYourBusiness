// The interviewer is not re-run on every read (cost regression guard).
//
// getIntakeState runs on every page load, every poll and again after each
// answer. In "llm" mode it used to call pickNextQuestion — a Sonnet call —
// every single time, so reading the screen cost money. Measured on a live
// run: 192 calls for ~50 answers against a €50/month budget.
//
// These tests mock the interviewer and count calls, because that count IS
// the thing being fixed. Asserting on the returned question would pass just
// as happily with the bug present.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const pickNextQuestion = vi.hoisted(() => vi.fn());
vi.mock("../interviewer/interviewer", () => ({ pickNextQuestion }));

const { db } = await import("../../db");
const { accounts, businessProfiles, fieldRecords } = await import("../../db/schema");
const { loadBank } = await import("../bank/loader");
const { bootstrapIntake, getIntakeState, submitAnswer } = await import("./service");

const created: { account_id: string; profile_id: string }[] = [];

async function freshSession() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

beforeEach(async () => {
  await loadBank("specs/question-bank-v1.json");
  vi.stubEnv("INTERVIEWER_MODE", "llm");
  // Return the first candidate, whatever it is — this test is about how
  // often the interviewer is consulted, not which question it picks.
  pickNextQuestion.mockReset();
  pickNextQuestion.mockImplementation(({ asked }: { asked: { question: unknown }[] }) => {
    void asked;
    return Promise.resolve(null);
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  for (const s of created) {
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("reading the intake state does not re-run the interviewer", () => {
  it("consults the interviewer once, then serves repeat reads from the stored pick", async () => {
    const s = await freshSession();

    await getIntakeState(s.account_id, s.profile_id);
    expect(pickNextQuestion).toHaveBeenCalledTimes(1);

    // A refresh, a poll, a second tab. None of these are new information.
    await getIntakeState(s.account_id, s.profile_id);
    await getIntakeState(s.account_id, s.profile_id);
    await getIntakeState(s.account_id, s.profile_id);
    expect(pickNextQuestion).toHaveBeenCalledTimes(1);
  });

  it("re-picks exactly once after an answer, because the stored pick is no longer a candidate", async () => {
    const s = await freshSession();

    const first = await getIntakeState(s.account_id, s.profile_id);
    expect(pickNextQuestion).toHaveBeenCalledTimes(1);
    const asked = first.question?.id;
    expect(asked).toBeTruthy();

    // submitAnswer returns fresh state, which is one legitimate re-pick.
    await submitAnswer(s.account_id, s.profile_id, asked as string, {
      kind: "value",
      wire: "Cache Guard Co",
    });
    const afterAnswer = pickNextQuestion.mock.calls.length;
    expect(afterAnswer).toBe(2);

    // ...and reads after it are free again.
    await getIntakeState(s.account_id, s.profile_id);
    await getIntakeState(s.account_id, s.profile_id);
    expect(pickNextQuestion).toHaveBeenCalledTimes(afterAnswer);
  });

  it("never consults the interviewer in deterministic mode", async () => {
    vi.stubEnv("INTERVIEWER_MODE", "deterministic");
    const s = await freshSession();
    await getIntakeState(s.account_id, s.profile_id);
    await getIntakeState(s.account_id, s.profile_id);
    expect(pickNextQuestion).not.toHaveBeenCalled();
  });
});
