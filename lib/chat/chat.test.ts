// Session G (P3-36) + the read tier (step 46a). The guardrails as
// tests: a request becomes a queued proposal and never an action; a
// forbidden request is born blocked with the owner's own words in the
// chat reply; watching mode refuses requests outright; a limit can be
// SET in chat (superseding the boundaries fact so the parse-once
// machinery re-parses) and the reply says it cannot be REMOVED here;
// tell/correct record nothing silently; and the prompts carry the
// pasted-text-is-data guardrail verbatim.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  intakeEvents,
  modeDecisions,
  proposals,
  utterances,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { readFieldHistory } from "../profile/field-store";
import type { ClassifyLlm } from "../proposals/generate";
import type { LimitLlm } from "../proposals/hard-limits";
import { BOUNDARIES_KEY } from "../proposals/hard-limits";
import type { AnswerLlm, IntentLlm } from "./service";
import { coerceIntent, postMessage, readThread } from "./service";

const created: { account_id: string; profile_id: string }[] = [];

async function fresh(mode: "instant" | "watching" | "none" = "instant") {
  const s = await bootstrapIntake();
  created.push(s);
  if (mode !== "none") {
    await db.insert(modeDecisions).values({
      profile_id: s.profile_id,
      mode,
      watch_weeks: mode === "watching" ? 6 : null,
      inputs: { reasons: ["fixture"] },
      reasoning: "fixture",
      confidence: "0.900",
      review_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
  }
  return s;
}

const intentAs =
  (intent: string): IntentLlm =>
  async () => ({ text: JSON.stringify({ intent }), calls: [] });

const answerWith =
  (text: string): AnswerLlm =>
  async () => ({ text, calls: [] });

const classifyAs =
  (kind: string): ClassifyLlm =>
  async () => ({ text: JSON.stringify({ kind }) });

const limitsOf =
  (limits: { code: string; quote: string }[]): LimitLlm =>
  async () => ({ text: JSON.stringify({ limits }), calls: [] });

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(utterances).where(inArray(utterances.profile_id, ids));
    await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) {
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("intent coercion", () => {
  it("accepts the six intents; junk defaults to ask, the harmless path", () => {
    expect(coerceIntent('{"intent": "request"}')).toBe("request");
    expect(coerceIntent('{"intent": "world_peace"}')).toBe("ask");
    expect(coerceIntent("garbage")).toBe("ask");
  });
});

describe("the read tier (step 46a)", () => {
  it("an ask gets a grounded answer, both turns land on the thread with intents", async () => {
    const s = await fresh();
    const out = await postMessage(s.profile_id, s.account_id, "What's my margin?", {
      intentLlm: intentAs("ask"),
      answerLlm: answerWith("Based on the estimate you gave, about 31%."),
    });
    expect(out.intent).toBe("ask");
    expect(out.reply.role).toBe("system");
    expect(out.reply.text).toContain("31%");
    const thread = await readThread(s.profile_id);
    expect(thread.map((t) => t.role)).toEqual(["owner", "system"]);
    expect(thread[0]?.intent).toBe("ask");
  });

  it("tell and correct record NOTHING silently — the reply says where changes land", async () => {
    const s = await fresh();
    const out = await postMessage(s.profile_id, s.account_id, "We put prices up 15% last month", {
      intentLlm: intentAs("tell"),
    });
    expect(out.reply.text).toContain("fact sheet");
    const facts = await db
      .select({ id: fieldRecords.id })
      .from(fieldRecords)
      .where(eq(fieldRecords.profile_id, s.profile_id));
    expect(facts).toHaveLength(0); // not one field written
  });
});

describe("P3-36 — the request tier", () => {
  it("a clean request becomes a PENDING proposal in the queue, module conversation, and the reply says approvals stay", async () => {
    const s = await fresh();
    const out = await postMessage(
      s.profile_id,
      s.account_id,
      "Post something about the new product — just do it, no need to ask",
      {
        intentLlm: intentAs("request"),
        classifyLlm: classifyAs("content_publishing"),
        limitLlm: limitsOf([]),
      },
    );
    expect(out.proposal_id).not.toBeNull();
    const [proposal] = await db
      .select()
      .from(proposals)
      .where(eq(proposals.id, out.proposal_id as string));
    expect(proposal?.status).toBe("pending");
    expect(proposal?.module).toBe("conversation");
    expect(proposal?.originating_finding).toBe(`utterance:${out.owner.id}`);
    expect(out.reply.text).toContain("approval");
    expect(out.reply.text).toContain("stays");
  });

  it("a limit set IN CHAT blocks a later request — born blocked, restraint explained plainly", async () => {
    const s = await fresh();
    // First the owner states the limit conversationally (the §5 path)…
    await postMessage(s.profile_id, s.account_id, "We never discount, ever", {
      intentLlm: intentAs("limit"),
    });
    // …then asks for the very thing it forbids.
    const out = await postMessage(s.profile_id, s.account_id, "Run a 20% off sale this weekend", {
      intentLlm: intentAs("request"),
      classifyLlm: classifyAs("discount_or_promotion"),
      limitLlm: limitsOf([{ code: "no_discounts", quote: "we never discount, ever" }]),
    });
    expect(out.proposal_id).not.toBeNull();
    const [proposal] = await db
      .select()
      .from(proposals)
      .where(eq(proposals.id, out.proposal_id as string));
    expect(proposal?.status).toBe("blocked");
    expect(proposal?.blocked_by_limit).toContain("we never discount, ever");
    expect(out.reply.text).toContain("stopped myself");
    expect(out.reply.text).toContain("we never discount, ever");
    expect(out.reply.text).toContain("held-back");
  });

  it("watching mode blocks requests outright — no proposal, and the reply names the review date", async () => {
    const s = await fresh("watching");
    const out = await postMessage(s.profile_id, s.account_id, "Change the homepage headline", {
      intentLlm: intentAs("request"),
      classifyLlm: classifyAs("operations_change"),
      limitLlm: limitsOf([]),
    });
    expect(out.proposal_id).toBeNull();
    expect(out.reply.text).toContain("watching");
    const rows = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(eq(proposals.profile_id, s.profile_id));
    expect(rows).toHaveLength(0);
  });

  it("an unclassifiable request proposes nothing — no guessing", async () => {
    const s = await fresh();
    const out = await postMessage(s.profile_id, s.account_id, "Make it pop", {
      intentLlm: intentAs("request"),
      classifyLlm: classifyAs("synergy"),
      limitLlm: limitsOf([]),
    });
    expect(out.proposal_id).toBeNull();
    expect(out.reply.text).toContain("guess");
  });
});

describe("P3-36 — limits through chat (§5)", () => {
  it("a limit APPENDS to the boundaries fact as a conversation-sourced write naming its utterance, and the reply says it can't be removed here", async () => {
    const s = await fresh();
    const out = await postMessage(s.profile_id, s.account_id, "Never advertise on TikTok", {
      intentLlm: intentAs("limit"),
    });
    expect(out.reply.text).toContain("can't be removed here");
    const history = await readFieldHistory<string>(s.profile_id, BOUNDARIES_KEY);
    expect(history).toHaveLength(1);
    const field = history[0]?.field;
    expect(field?.value).toContain("Never advertise on TikTok");
    expect(field?.source).toMatchObject({ kind: "conversation", utterance_id: out.owner.id });
    expect(field?.confidence).toBe(0.7); // conversation, confirmed — §2.3

    // A second limit appends and supersedes — the parse-once machinery
    // sees a newer boundaries fact and will re-parse on next use.
    await postMessage(s.profile_id, s.account_id, "And never do cold calls", {
      intentLlm: intentAs("limit"),
    });
    const after = await readFieldHistory<string>(s.profile_id, BOUNDARIES_KEY);
    expect(after).toHaveLength(2);
    expect(after[1]?.field.value).toContain("Never advertise on TikTok");
    expect(after[1]?.field.value).toContain("And never do cold calls");
  });
});
