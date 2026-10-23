// The assistant's confirm — review 2026-10-23, #21. One transaction holds
// the claim, the write, its decision-log entry and the status, so a failure
// part-way leaves nothing behind and a retry queues exactly one proposal;
// and a card drafted before the watch began can't queue anything once the
// watch runs.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  assistantChanges,
  businessProfiles,
  decisionLog,
  fieldRecords,
  intakeEvents,
  modeDecisions,
  proposals,
  utterances,
} from "../../db/schema";

const failAfterProposal = vi.hoisted(() => ({ on: false }));

vi.mock("../proposals/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("../proposals/service")>();
  return {
    ...real,
    // The real insert runs; then, when asked, the confirm dies right after it.
    createProposal: async (...args: Parameters<typeof real.createProposal>) => {
      const row = await real.createProposal(...args);
      if (failAfterProposal.on) throw new Error("crash after the proposal insert");
      return row;
    },
  };
});

import type { IntentLlm } from "../chat/service";
import { postMessage } from "../chat/service";
import { bootstrapIntake } from "../intake/service";
import type { LimitLlm } from "../proposals/hard-limits";
import { confirmChange } from "./changes";

const created: { account_id: string; profile_id: string }[] = [];
const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

const knowledgeIntent: IntentLlm = async () => ({
  text: JSON.stringify({
    intent: "request",
    change: {
      kind: "knowledge_answer",
      count: 1,
      day: "",
      open: "",
      close: "",
      closed: false,
      reply_hours: 0,
      band: "",
      on: "",
      provider: "",
      subject: "Is there parking?",
      value: "Free parking behind the shop.",
    },
  }),
  calls: [],
});

async function fresh(mode: "instant" | "watching" = "instant") {
  const s = await bootstrapIntake();
  created.push(s);
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode,
    watch_weeks: mode === "watching" ? 4 : null,
    inputs: { reasons: ["fixture"] },
    reasoning: "fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  return s;
}

async function draftKnowledge(s: { account_id: string; profile_id: string }) {
  const out = await postMessage(
    s.profile_id,
    s.account_id,
    "Change what the customer assistant says about parking",
    { intentLlm: knowledgeIntent, limitLlm: noLimits },
  );
  expect(out.change?.status).toBe("prepared");
  return out.change?.id as string;
}

const proposalsOf = (profileId: string) =>
  db.select().from(proposals).where(eq(proposals.profile_id, profileId));
const changeLog = (profileId: string) =>
  db
    .select()
    .from(decisionLog)
    .where(and(eq(decisionLog.profile_id, profileId), eq(decisionLog.kind, "assistant_change")));

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(assistantChanges).where(inArray(assistantChanges.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(utterances).where(inArray(utterances.profile_id, ids));
    await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("the confirm is one transaction", () => {
  it("a crash after the proposal insert leaves no proposal, no log row, and the card confirmable", async () => {
    const s = await fresh();
    const changeId = await draftKnowledge(s);
    const confirm = () =>
      confirmChange({
        profileId: s.profile_id,
        accountId: s.account_id,
        changeId,
        signedIn: true,
        seams: { limitLlm: noLimits },
      });

    failAfterProposal.on = true;
    await expect(confirm()).rejects.toThrow(/crash after the proposal insert/);
    failAfterProposal.on = false;
    expect(await proposalsOf(s.profile_id)).toHaveLength(0);
    expect(await changeLog(s.profile_id)).toHaveLength(0);
    const [row] = await db.select().from(assistantChanges).where(eq(assistantChanges.id, changeId));
    expect(row?.status).toBe("prepared");
    expect(row?.decided_at).toBeNull();

    // The retry queues exactly one, and a second click changes nothing.
    expect((await confirm()).status).toBe("queued");
    expect((await confirm()).status).toBe("queued");
    expect(await proposalsOf(s.profile_id)).toHaveLength(1);
    expect(await changeLog(s.profile_id)).toHaveLength(1);
  });

  it("two clicks at once queue one proposal", async () => {
    const s = await fresh();
    const changeId = await draftKnowledge(s);
    const confirm = () =>
      confirmChange({
        profileId: s.profile_id,
        accountId: s.account_id,
        changeId,
        signedIn: true,
        seams: { limitLlm: noLimits },
      });
    const rows = await Promise.all([confirm(), confirm()]);
    expect(rows.map((r) => r.status)).toEqual(["queued", "queued"]);
    expect(await proposalsOf(s.profile_id)).toHaveLength(1);
    expect(await changeLog(s.profile_id)).toHaveLength(1);
  });
});

describe("the watch is re-checked at the click", () => {
  it("a knowledge card drafted before the watch began queues nothing once it runs", async () => {
    const s = await fresh();
    const changeId = await draftKnowledge(s);
    await db.insert(modeDecisions).values({
      profile_id: s.profile_id,
      mode: "watching",
      watch_weeks: 4,
      inputs: { reasons: ["fixture"] },
      reasoning: "fixture",
      confidence: "0.900",
      decided_at: new Date(Date.now() + 1_000).toISOString(),
      review_at: new Date(Date.now() + 28 * 86_400_000).toISOString(),
    });
    const row = await confirmChange({
      profileId: s.profile_id,
      accountId: s.account_id,
      changeId,
      signedIn: true,
      seams: { limitLlm: noLimits },
    });
    expect(row.status).toBe("stale");
    expect(row.result_text).toContain("I'm watching until");
    expect(await proposalsOf(s.profile_id)).toHaveLength(0);
    expect(await changeLog(s.profile_id)).toHaveLength(0);
  });
});
