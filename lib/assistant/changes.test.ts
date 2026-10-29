// Feature 33 — the assistant acts, end to end on a real database with
// fake model clients. The guardrails as tests:
//   · a drafted change writes NOTHING until the owner's click, then
//     exactly one superseding fact (or one setting), sourced to the
//     owner's message, with a decision-log entry (rules 3, 7, 12)
//   · a second click changes nothing; a value that moved since the draft
//     is refused, never overwritten unseen
//   · an ambiguous request is a question ("Which day?"), and the owner's
//     short answer completes it
//   · something customers would see becomes a PROPOSAL on the click,
//     never an action; a request out in the world stays a proposal
//   · link-only rows offer nothing to confirm

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  assistantChanges,
  businessProfiles,
  decisionLog,
  executions,
  fieldRecords,
  goals,
  intakeEvents,
  knowledgeEntries,
  modeDecisions,
  profileSnapshots,
  proposals,
  snapshotRecords,
  supportSettings,
  utterances,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { addGoal } from "../content/goals";
import { haltState, resumeExecutions } from "../execution/engine";
import type { ScheduleLlm } from "../hours/schedule";
import { HOURS_KEY, SCHEDULE_KEY } from "../hours/schedule";
import { bootstrapIntake } from "../intake/service";
import { readFieldHistory, writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { BOUNDARIES_KEY } from "../proposals/hard-limits";
import type { ChatSeams, IntentLlm } from "../chat/service";
import { postMessage } from "../chat/service";
import { confirmChange } from "./changes";

const created: { account_id: string; profile_id: string }[] = [];

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: "instant",
    watch_weeks: null,
    inputs: { reasons: ["fixture"] },
    reasoning: "fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  return s;
}

async function ownerFact(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

/** A model that is never supposed to be called. */
const noModel: IntentLlm = async () => {
  throw new Error("the rules should have been enough — no model call expected");
};

const modelSays =
  (intent: string, change: Record<string, unknown> | null): IntentLlm =>
  async () => ({
    text: JSON.stringify({
      intent,
      change: {
        kind: "none",
        count: 1,
        day: "",
        open: "",
        close: "",
        closed: false,
        reply_hours: 0,
        band: "",
        on: "",
        provider: "",
        subject: "",
        value: "",
        ...(change ?? {}),
      },
    }),
    calls: [],
  });

const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

const schedule: ScheduleLlm = async () => ({
  text: JSON.stringify({
    days: [
      ...["mon", "tue", "wed", "thu", "fri"].map((day) => ({
        day,
        closed: false,
        periods: [{ open: "09:00", close: "17:00" }],
        quote: "Mon–Fri 9 to 5",
      })),
      { day: "sat", closed: false, periods: [{ open: "09:00", close: "14:00" }], quote: "Sat 9–2" },
      { day: "sun", closed: true, periods: [], quote: "Sun closed" },
    ],
    unparsed: [],
  }),
  calls: [],
});

async function changeLogEntries(profileId: string) {
  return db
    .select()
    .from(decisionLog)
    .where(and(eq(decisionLog.profile_id, profileId), eq(decisionLog.kind, "assistant_change")));
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    const props = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(inArray(proposals.profile_id, ids));
    if (props.length > 0) {
      await db.delete(executions).where(
        inArray(
          executions.proposal_id,
          props.map((p) => p.id),
        ),
      );
    }
    await db.delete(assistantChanges).where(inArray(assistantChanges.profile_id, ids));
    await db.delete(knowledgeEntries).where(inArray(knowledgeEntries.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(supportSettings).where(inArray(supportSettings.profile_id, ids));
    await db.delete(utterances).where(inArray(utterances.profile_id, ids));
    await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    const snaps = await db
      .select({ id: profileSnapshots.id })
      .from(profileSnapshots)
      .where(inArray(profileSnapshots.profile_id, ids));
    if (snaps.length > 0) {
      await db.delete(snapshotRecords).where(
        inArray(
          snapshotRecords.snapshot_id,
          snaps.map((x) => x.id),
        ),
      );
    }
    await db.delete(profileSnapshots).where(inArray(profileSnapshots.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(goals).where(inArray(goals.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) {
    await resumeExecutions(s.account_id);
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("opening hours — ambiguity, then one superseding fact on the click", () => {
  it("asks which day, reads the answer, quotes the current value, writes nothing until confirmed", async () => {
    const s = await fresh();
    await ownerFact(s.profile_id, HOURS_KEY, "Mon–Fri 9 to 5, Sat 9–2, Sun closed");
    const seams: ChatSeams = { intentLlm: noModel, scheduleLlm: schedule };

    const first = await postMessage(
      s.profile_id,
      s.account_id,
      "Change my opening hours to 10-4",
      seams,
    );
    expect(first.change?.status).toBe("asked");
    expect(first.reply.text).toBe("Which day?");

    const second = await postMessage(s.profile_id, s.account_id, "Saturday", seams);
    const card = second.change;
    expect(card?.status).toBe("prepared");
    expect(card?.kind).toBe("opening_hours");
    expect(card?.current_text).toBe("09:00–14:00");
    expect(card?.proposed_text).toBe("10:00–16:00");
    expect(second.reply.text).toContain("Your Saturday hours are 09:00–14:00 now");
    expect(second.reply.text).not.toMatch(/\bdone\b/i);
    expect(card?.link).toBe("/profile?focus=fact-presence.opening_hours");
    // The question is closed by its answer.
    const [question] = await db
      .select()
      .from(assistantChanges)
      .where(eq(assistantChanges.id, first.change?.id as string));
    expect(question?.status).toBe("superseded");

    // Drafting wrote nothing — not the answer, not even the parse cache.
    expect(await readFieldHistory(s.profile_id, HOURS_KEY)).toHaveLength(1);
    expect(await readFieldHistory(s.profile_id, SCHEDULE_KEY)).toHaveLength(0);
    expect(await changeLogEntries(s.profile_id)).toHaveLength(0);

    // Idea 52: the click asks for the role the screen's own route asks for —
    // a manager can't change the business's facts from the chat either.
    await expect(
      confirmChange({
        profileId: s.profile_id,
        accountId: s.account_id,
        changeId: card?.id as string,
        signedIn: true,
        role: "manager",
      }),
    ).rejects.toThrow("Only an owner can change the business's facts, goals or limits.");
    expect(await readFieldHistory(s.profile_id, HOURS_KEY)).toHaveLength(1);

    const done = await confirmChange({
      profileId: s.profile_id,
      accountId: s.account_id,
      changeId: card?.id as string,
      signedIn: false,
      role: "owner",
    });
    expect(done.status).toBe("applied");
    expect(done.result_text).toMatch(/^Changed\./);

    const history = await readFieldHistory<string>(s.profile_id, HOURS_KEY);
    expect(history).toHaveLength(2); // superseded, never overwritten
    expect(history[0]?.superseded_at).not.toBeNull();
    const now = history[1]?.field;
    expect(now?.value).toContain("Sat 10:00–16:00");
    expect(now?.value).toContain("Mon 09:00–17:00");
    expect(now?.value).toContain("Sun closed");
    expect(now?.source).toEqual({ kind: "conversation", utterance_id: second.owner.id });
    expect(now?.confidence).toBe(0.7);
    expect(await changeLogEntries(s.profile_id)).toHaveLength(1);

    // A second click changes nothing.
    const again = await confirmChange({
      profileId: s.profile_id,
      accountId: s.account_id,
      changeId: card?.id as string,
      signedIn: false,
    });
    expect(again.status).toBe("applied");
    expect(await readFieldHistory(s.profile_id, HOURS_KEY)).toHaveLength(2);
    expect(await changeLogEntries(s.profile_id)).toHaveLength(1);
  });

  it("two days in one message is a question, never two changes", async () => {
    const s = await fresh();
    const out = await postMessage(
      s.profile_id,
      s.account_id,
      "Set Saturday and Sunday hours to 10-4",
      { intentLlm: noModel, scheduleLlm: schedule },
    );
    expect(out.change?.status).toBe("asked");
    expect(out.reply.text).toContain("One day at a time");
    expect(out.reply.text).toContain("Saturday or Sunday");
  });

  it("more than one change named, as the model counts it, is asked about — no chaining", async () => {
    const s = await fresh();
    const out = await postMessage(
      s.profile_id,
      s.account_id,
      "Make the hours later and update the reply thing too",
      { intentLlm: modelSays("request", { kind: "opening_hours", count: 2 }) },
    );
    expect(out.change?.status).toBe("asked");
    expect(out.reply.text).toContain("more than one change");
  });
});

describe("a fact — prepared from 'change my X to Y', refused when it moved", () => {
  it("writes exactly one superseding fact on the click, sourced to the message", async () => {
    const s = await fresh();
    await ownerFact(s.profile_id, "identity.team_size", 3);
    const out = await postMessage(s.profile_id, s.account_id, "Change my team size to 5", {
      intentLlm: noModel,
    });
    expect(out.change?.status).toBe("prepared");
    expect(out.change?.current_text).toBe("3");
    expect(out.change?.proposed_text).toBe("5");
    expect(out.reply.text).toContain("Your team size is 3 now");
    expect(await readFieldHistory(s.profile_id, "identity.team_size")).toHaveLength(1);

    await confirmChange({
      profileId: s.profile_id,
      accountId: s.account_id,
      changeId: out.change?.id as string,
      signedIn: false,
    });
    const history = await readFieldHistory(s.profile_id, "identity.team_size");
    expect(history).toHaveLength(2);
    expect(history[1]?.field.value).toBe(5);
    expect(history[1]?.field.source.kind).toBe("conversation");
    const [owner] = await db.select().from(utterances).where(eq(utterances.id, out.owner.id));
    expect(owner?.confirmed).toBe(true);
    expect(owner?.extracted_fields).toEqual(["identity.team_size"]);
  });

  it("a value that moved between the draft and the click is not overwritten", async () => {
    const s = await fresh();
    await ownerFact(s.profile_id, "identity.team_size", 3);
    const out = await postMessage(s.profile_id, s.account_id, "Change my team size to 5", {
      intentLlm: noModel,
    });
    await ownerFact(s.profile_id, "identity.team_size", 4); // changed on the intake meanwhile
    const row = await confirmChange({
      profileId: s.profile_id,
      accountId: s.account_id,
      changeId: out.change?.id as string,
      signedIn: false,
    });
    expect(row.status).toBe("stale");
    expect(row.result_text).toContain("it's 4 now");
    const history = await readFieldHistory(s.profile_id, "identity.team_size");
    expect(history.map((h) => h.field.value)).toEqual([3, 4]);
    expect(await changeLogEntries(s.profile_id)).toHaveLength(0);
  });

  it("a value that isn't one is a question, not a guess", async () => {
    const s = await fresh();
    await ownerFact(s.profile_id, "identity.team_size", 3);
    const out = await postMessage(s.profile_id, s.account_id, "Change my team size to lots", {
      intentLlm: noModel,
    });
    expect(out.change?.status).toBe("asked");
    expect(out.reply.text).toContain("I need a number");
  });

  it("holds a percent to the bank's 0–100 and asks back on a fraction (review 2026-10-23, #13)", async () => {
    const s = await fresh();
    await ownerFact(s.profile_id, "revenue.generates_revenue", { code: "yes", label_raw: null });
    await ownerFact(s.profile_id, "revenue.repeat_customer_rate", 20);
    const say = (text: string) =>
      postMessage(s.profile_id, s.account_id, text, { intentLlm: noModel });

    const fraction = await say("Change my repeat customer rate to 0.35");
    expect(fraction.change?.status).toBe("asked");
    expect(fraction.reply.text).toContain("Did you mean 35 %?");

    const huge = await say("Change my repeat customer rate to 4000");
    expect(huge.change?.status).toBe("asked");
    expect(huge.reply.text).toContain("a number from 0 to 100");

    const fine = await say("Change my repeat customer rate to 35");
    expect(fine.change?.status).toBe("prepared");
    expect(fine.change?.proposed_text).toBe("35");
    // Nothing was written by any of the three.
    expect(await readFieldHistory(s.profile_id, "revenue.repeat_customer_rate")).toHaveLength(1);
  });
});

describe("a standing rule and a goal", () => {
  it("a limit is drafted, and only the click appends it", async () => {
    const s = await fresh();
    const out = await postMessage(s.profile_id, s.account_id, "We never discount", {
      intentLlm: noModel,
    });
    expect(out.intent).toBe("limit");
    expect(out.change?.status).toBe("prepared");
    expect(out.reply.text).toContain("can't be removed from chat");
    expect(await readFieldHistory(s.profile_id, BOUNDARIES_KEY)).toHaveLength(0);
    await confirmChange({
      profileId: s.profile_id,
      accountId: s.account_id,
      changeId: out.change?.id as string,
      signedIn: false,
    });
    const history = await readFieldHistory<string>(s.profile_id, BOUNDARIES_KEY);
    expect(history).toHaveLength(1);
    expect(history[0]?.field.value).toBe("We never discount");
  });

  it("removing a rule is link-only — nothing to confirm", async () => {
    const s = await fresh();
    await ownerFact(s.profile_id, BOUNDARIES_KEY, "We never discount");
    const out = await postMessage(s.profile_id, s.account_id, "Remove the discount rule", {
      intentLlm: noModel,
    });
    expect(out.change?.status).toBe("link_only");
    expect(out.change?.current_text).toContain("We never discount");
    await expect(
      confirmChange({
        profileId: s.profile_id,
        accountId: s.account_id,
        changeId: out.change?.id as string,
        signedIn: true,
      }),
    ).rejects.toThrow(/nothing to confirm/);
  });

  it("rewording the one goal supersedes its statement on the click", async () => {
    const s = await fresh();
    const goal = await addGoal(s.profile_id, { statement: "30 new customers a month" });
    const out = await postMessage(
      s.profile_id,
      s.account_id,
      "Change my goal to 40 new customers a month",
      { intentLlm: noModel },
    );
    expect(out.change?.status).toBe("prepared");
    expect(out.change?.current_text).toBe("30 new customers a month");
    expect(out.change?.link).toBe(`/progress?focus=goal-${goal.goal_id}`);
    const key = `goals.${goal.goal_id}.statement`;
    expect(await readFieldHistory(s.profile_id, key)).toHaveLength(1);
    await confirmChange({
      profileId: s.profile_id,
      accountId: s.account_id,
      changeId: out.change?.id as string,
      signedIn: false,
    });
    const history = await readFieldHistory(s.profile_id, key);
    expect(history).toHaveLength(2);
    expect(history[1]?.field.value).toBe("40 new customers a month");
  });
});

describe("settings and the stop", () => {
  it("the reply time needs a signed-in owner, as the Support page does, then sets one setting", async () => {
    const s = await fresh();
    const out = await postMessage(s.profile_id, s.account_id, "Change our reply time to 4 hours", {
      intentLlm: noModel,
    });
    expect(out.change?.status).toBe("prepared");
    expect(out.change?.current_text).toBe("no reply time set");
    const id = out.change?.id as string;
    await expect(
      confirmChange({
        profileId: s.profile_id,
        accountId: s.account_id,
        changeId: id,
        signedIn: false,
      }),
    ).rejects.toThrow(/signed in/);
    const before = await db
      .select()
      .from(supportSettings)
      .where(eq(supportSettings.profile_id, s.profile_id));
    expect(before[0]?.reply_hours ?? null).toBeNull();
    const done = await confirmChange({
      profileId: s.profile_id,
      accountId: s.account_id,
      changeId: id,
      signedIn: true,
    });
    expect(done.status).toBe("applied");
    const [after] = await db
      .select()
      .from(supportSettings)
      .where(eq(supportSettings.profile_id, s.profile_id));
    expect(after?.reply_hours).toBe(4);
    expect(await changeLogEntries(s.profile_id)).toHaveLength(1);
  });

  it("'pause everything' is one click — and not before it", async () => {
    const s = await fresh();
    const out = await postMessage(s.profile_id, s.account_id, "Pause everything", {
      intentLlm: noModel,
    });
    expect(out.change?.status).toBe("prepared");
    expect(out.change?.link).toBe("/proposals?focus=emergency-stop");
    expect((await haltState(s.account_id)).halted).toBe(false);
    await confirmChange({
      profileId: s.profile_id,
      accountId: s.account_id,
      changeId: out.change?.id as string,
      signedIn: false,
    });
    expect((await haltState(s.account_id)).halted).toBe(true);
  });

  it("connecting an account is link-only, quoting what is connected now", async () => {
    const s = await fresh();
    const out = await postMessage(s.profile_id, s.account_id, "Connect Stripe", {
      intentLlm: noModel,
    });
    expect(out.change?.status).toBe("link_only");
    expect(out.change?.current_text).toBe("not connected");
    expect(out.change?.link).toBe("/connections?focus=cn-src-stripe");
    expect(out.reply.text).toContain("your own login");
  });
});

describe("what customers would see becomes a proposal — never an action", () => {
  it("a knowledge answer is drafted, and the click queues a proposal, not an entry", async () => {
    const s = await fresh();
    const out = await postMessage(
      s.profile_id,
      s.account_id,
      "Change what the customer assistant says about parking to: free parking behind the shop",
      {
        intentLlm: modelSays("request", {
          kind: "knowledge_answer",
          subject: "Is there parking?",
          value: "Free parking behind the shop.",
        }),
        limitLlm: noLimits,
      },
    );
    expect(out.change?.status).toBe("prepared");
    const queued = () => db.select().from(proposals).where(eq(proposals.profile_id, s.profile_id));
    expect(await queued()).toHaveLength(0);
    const done = await confirmChange({
      profileId: s.profile_id,
      accountId: s.account_id,
      changeId: out.change?.id as string,
      signedIn: true,
      seams: { limitLlm: noLimits },
    });
    expect(done.status).toBe("queued");
    expect(done.result_text).toContain("approval queue");
    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    const entries = await db
      .select()
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.profile_id, s.profile_id));
    expect(entries).toHaveLength(0); // nothing public until approved in the queue
  });

  it("an action out in the world stays the request tier's proposal, with no execution", async () => {
    const s = await fresh();
    const out = await postMessage(
      s.profile_id,
      s.account_id,
      "Post on Instagram about the autumn sale",
      {
        intentLlm: modelSays("request", null),
        classifyLlm: async () => ({ text: JSON.stringify({ kind: "content_publishing" }) }),
        limitLlm: noLimits,
      },
    );
    expect(out.change).toBeNull();
    expect(out.proposal_id).not.toBeNull();
    const [p] = await db
      .select()
      .from(proposals)
      .where(eq(proposals.id, out.proposal_id as string));
    expect(p?.status).toBe("pending");
    const ran = await db
      .select()
      .from(executions)
      .where(eq(executions.proposal_id, out.proposal_id as string));
    expect(ran).toHaveLength(0);
  });
});
