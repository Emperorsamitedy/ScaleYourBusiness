// Area tiles against the real bank and database: the state carries the
// areas, the record and the business name, and a chosen area steers the
// next question. Deterministic interviewer mode.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords, offers } from "../../db/schema";
import { loadBank } from "../bank/loader";
import { bootstrapIntake, getIntakeState, parseSection, submitAnswer } from "./service";

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

describe("a fresh profile", () => {
  it("names no business, holds no facts, and asks the first area's first question", async () => {
    const state = await getIntakeState(accountId, profileId);
    expect(state.business_name).toBeNull();
    expect(state.record.fact_count).toBe(0);
    expect(state.record.facts).toEqual([]);
    expect(state.question).toMatchObject({ section: "identity", area_position: 1 });
    expect(state.question?.already_read).toBeNull();
    const identity = state.areas.find((a) => a.section === "identity");
    expect(identity?.status).toBe("in_progress"); // being asked now
  });

  it("every area starts askable: each bank section has an unconditional question", async () => {
    const state = await getIntakeState(accountId, profileId);
    expect(state.areas.filter((a) => a.status === "blocked")).toEqual([]);
    expect(state.areas.find((a) => a.section === "goals")?.status).toBe("not_started");
  });
});

describe("after the first answer", () => {
  it("the masthead name, the record row and the area position follow the record", async () => {
    const res = await submitAnswer(accountId, profileId, "1.1", {
      kind: "value",
      wire: "Fernhill Ceramics",
    });
    const state = res.state;
    expect(state.business_name).toBe("Fernhill Ceramics");
    expect(state.record.fact_count).toBe(1);
    expect(state.record.facts[0]).toMatchObject({
      key: "identity.legal_name",
      value: "Fernhill Ceramics",
      source_kind: "owner_input",
      question_id: "1.1",
    });
    expect(state.record.sources).toEqual([{ kind: "owner_input", provider: null, count: 1 }]);
    if (state.question?.section === "identity") {
      expect(state.question.area_position).toBe(2);
    }
  });
});

describe("choosing an area", () => {
  it("asks the next question from the chosen area, and keeps to it across answers", async () => {
    const state = await getIntakeState(accountId, profileId, undefined, "goals");
    expect(state.question?.section).toBe("goals");
    expect(state.areas.find((a) => a.section === "goals")?.status).toBe("in_progress");

    const first = state.question;
    if (!first) throw new Error("no goals question");
    // A skip, not an unknown: it stays distinct on the record (rule 5).
    const res = await submitAnswer(accountId, profileId, first.id, { kind: "skip" }, "goals");
    expect(res.state.question?.section).toBe("goals");
    expect(res.state.question?.id).not.toBe(first.id);
    expect(res.state.question?.area_position).toBe(2);
    expect(res.state.record.skipped).toBe(1);
    expect(res.state.record.not_known).toBe(0);
  });

  it("without a choice, default order resumes", async () => {
    const state = await getIntakeState(accountId, profileId);
    expect(state.question?.section).toBe("identity");
  });

  it("an area whose rest waits on revenue reads blocked, needing revenue", async () => {
    // Channels: 7.4 and 7.5 are unconditional; 7.1 waits on
    // revenue.generates_revenue, 7.3a/b on the channel list 7.1 writes.
    for (let guard = 0; guard < 3; guard++) {
      const s = await getIntakeState(accountId, profileId, undefined, "channels");
      const q = s.question;
      if (!q || q.section !== "channels") break;
      await submitAnswer(accountId, profileId, q.id, { kind: "unknown" }, "channels");
    }
    const state = await getIntakeState(accountId, profileId);
    expect(state.areas.find((a) => a.section === "channels")).toMatchObject({
      status: "blocked",
      needs: "revenue",
      answered: 2,
      open: 0,
    });
  });

  it("a blocked area has nothing to ask, so the default question stands", async () => {
    const before = await getIntakeState(accountId, profileId);
    const state = await getIntakeState(accountId, profileId, undefined, "channels");
    expect(state.question?.id).toBe(before.question?.id);
  });

  it("only real sections pass the wire check", () => {
    expect(parseSection("goals")).toBe("goals");
    expect(parseSection("competition")).toBeUndefined(); // bank name, not a profile section
    expect(parseSection("nope")).toBeUndefined();
    expect(parseSection(7)).toBeUndefined();
  });
});
