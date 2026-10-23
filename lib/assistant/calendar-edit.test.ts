// A calendar change approved from chat does what it said — review
// 2026-10-23, #8. "Move Friday's reel to Saturday" is drafted in chat, put in
// the approval queue on the click, and APPROVING it moves the item, once,
// through lib/content/calendar.ts, logged as the proposal's execution. An
// item that moved in between is refused, and the approval with it.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  assistantChanges,
  businessProfiles,
  contentItems,
  decisionLog,
  fieldRecords,
  intakeEvents,
  modeDecisions,
  proposals,
  users,
  utterances,
} from "../../db/schema";
import type { IntentLlm } from "../chat/service";
import { postMessage } from "../chat/service";
import { bootstrapIntake } from "../intake/service";
import type { LimitLlm } from "../proposals/hard-limits";
import { ProposalError, approveProposal, createProposal } from "../proposals/service";
import { calendarEditFrom, confirmChange } from "./changes";

const created: { account_id: string; profile_id: string }[] = [];
const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

const contentIntent: IntentLlm = async () => ({
  text: JSON.stringify({
    intent: "request",
    change: {
      kind: "content_item",
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
    },
  }),
  calls: [],
});

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);
/** A Friday at least a week out, so its Saturday is in the future too. */
const FRIDAY = (() => {
  let d = addDays(TODAY, 7);
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 5) d = addDays(d, 1);
  return d;
})();

async function business() {
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
  const [owner] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `calendar-${crypto.randomUUID()}@test.local`,
      display_name: "Owner",
      role: "owner",
    })
    .returning();
  const plan = await createProposal({
    profile_id: s.profile_id,
    module: "content",
    action: { kind: "content_publishing", summary: "fixture plan", detail: { items: [] } },
    scenario: {} as never,
    reversibility: { level: "easy", if_you_change_your_mind: "fixture" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const [item] = await db
    .insert(contentItems)
    .values({
      profile_id: s.profile_id,
      proposal_id: plan.id,
      kind: "post",
      channel_label: "Instagram",
      scheduled_for: FRIDAY,
      title: "Autumn reel — Instagram",
      body: "Draft body. Written with AI assistance.",
      disclosure: "Written with AI assistance.",
      provenance: {},
    })
    .returning();
  return { ...s, userId: owner!.id, itemId: item!.id };
}

async function draftAndQueue(b: Awaited<ReturnType<typeof business>>, text: string) {
  const out = await postMessage(b.profile_id, b.account_id, text, {
    intentLlm: contentIntent,
    limitLlm: noLimits,
  });
  expect(out.change?.status).toBe("prepared");
  const queued = await confirmChange({
    profileId: b.profile_id,
    accountId: b.account_id,
    changeId: out.change?.id as string,
    signedIn: true,
    seams: { limitLlm: noLimits },
  });
  expect(queued.status).toBe("queued");
  return { out, proposalId: (queued.result_ref as string).replace(/^proposal:/, "") };
}

const itemOf = async (id: string) =>
  (await db.select().from(contentItems).where(eq(contentItems.id, id)))[0]!;

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(assistantChanges).where(inArray(assistantChanges.profile_id, ids));
    await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(utterances).where(inArray(utterances.profile_id, ids));
    await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) {
    await db.delete(users).where(eq(users.account_id, s.account_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("approve → the item changed", () => {
  it("moves Friday's reel to Saturday on approval, once, and logs it as the execution", async () => {
    const b = await business();
    const { out, proposalId } = await draftAndQueue(b, "Move Friday's reel to Saturday");
    const saturday = addDays(FRIDAY, 1);
    expect(out.change?.proposed_text).toBe(`“Autumn reel — Instagram” on ${saturday}`);
    // The click queued it; the calendar hasn't moved.
    expect((await itemOf(b.itemId)).scheduled_for).toBe(FRIDAY);

    const approved = await approveProposal({
      proposalId,
      userId: b.userId,
      profileId: b.profile_id,
    });
    expect(approved.status).toBe("executed");
    expect(approved.execution_result).toEqual({
      content_item_id: b.itemId,
      op: "reschedule",
      from: FRIDAY,
      to: saturday,
    });
    expect((await itemOf(b.itemId)).scheduled_for).toBe(saturday);
    const log = await db
      .select({ kind: decisionLog.kind })
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, b.profile_id), eq(decisionLog.ref_id, proposalId)));
    expect(log.map((l) => l.kind).sort()).toEqual(["approval", "execution", "proposal"]);
    // A second approval changes nothing.
    await expect(
      approveProposal({ proposalId, userId: b.userId, profileId: b.profile_id }),
    ).rejects.toThrow(/already executed/);
  });

  it("renames an item on approval", async () => {
    const b = await business();
    const { proposalId } = await draftAndQueue(b, "Rename Friday's post to Autumn colours");
    await approveProposal({ proposalId, userId: b.userId, profileId: b.profile_id });
    expect((await itemOf(b.itemId)).title).toBe("Autumn colours");
  });

  it("an item that moved since the card is refused, and nothing is approved or changed", async () => {
    const b = await business();
    const { proposalId } = await draftAndQueue(b, "Move Friday's reel to Saturday");
    const elsewhere = addDays(FRIDAY, 3);
    await db
      .update(contentItems)
      .set({ scheduled_for: elsewhere })
      .where(eq(contentItems.id, b.itemId));
    const refusal = approveProposal({ proposalId, userId: b.userId, profileId: b.profile_id });
    await expect(refusal).rejects.toBeInstanceOf(ProposalError);
    await expect(
      approveProposal({ proposalId, userId: b.userId, profileId: b.profile_id }),
    ).rejects.toThrow(/has changed since this was proposed/);
    expect((await itemOf(b.itemId)).scheduled_for).toBe(elsewhere);
    const [p] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
    expect(p?.status).toBe("pending");
  });
});

describe("reading the edit from the owner's words", () => {
  const item = { title: "Autumn reel", scheduled_for: "2026-10-30" }; // a Friday
  it("lands a weekday in the item's own week, and an ISO day exactly", () => {
    expect(calendarEditFrom("move it to Saturday", item, "2026-10-23")).toMatchObject({
      edit: { op: "reschedule", from: "2026-10-30", to: "2026-10-31" },
    });
    expect(calendarEditFrom("move it to Monday", item, "2026-10-23")).toMatchObject({
      edit: { to: "2026-10-26" },
    });
    expect(calendarEditFrom("put it on 2026-11-04", item, "2026-10-23")).toMatchObject({
      edit: { to: "2026-11-04" },
    });
    expect(calendarEditFrom("move it to 2026-10-01", item, "2026-10-23")).toEqual({
      past: "2026-10-01",
    });
  });

  it("reads a rename, and nothing it can't do", () => {
    expect(calendarEditFrom("rename it to “Autumn colours”", item, "2026-10-23")).toMatchObject({
      edit: { op: "retitle", from: "Autumn reel", to: "Autumn colours" },
    });
    expect(calendarEditFrom("make it funnier", item, "2026-10-23")).toBeNull();
  });
});
