// Session C — P3-14..17, P3-19. What must hold: goals read/write/refine
// through supersession with suggestions never auto-written; the voice
// card's every trait names its source and carries the 13.5 boundaries;
// the calendar and shot list arrive as proposals with evidence and
// draft NOTHING before approval; production puts disclosed, provenance-
// carrying items in the queue and marks the plan executed; and the
// disclosure module has no off switch — asserted against its exports.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import * as disclosureModule from "./disclosure";
import {
  accounts,
  businessProfiles,
  channels,
  contentItems,
  fieldRecords,
  goals as goalsTable,
  intakeEvents,
  offers,
  proposals,
  users,
  utterances,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import { readFieldHistory } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal } from "../proposals/service";
import type { DraftLlm } from "./draft";
import { draftItem } from "./draft";
import { disclosureLabel, withDisclosure } from "./disclosure";
import { addGoal, listGoals, suggestGoalsFromReport, updateGoal } from "./goals";
import { proposeContentPlan } from "./plan";
import { contentQueue, produceFromProposal } from "./produce";
import { proposeShotList } from "./shotlist";
import { buildVoiceCard, renderVoiceCard } from "./voice";

const created: { account_id: string; profile_id: string }[] = [];

async function owner(profileId: string, key: string, value: unknown) {
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

/** A profile with a channel, an offer, an utterance and 13.5 boundaries. */
async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  const [ch] = await db
    .insert(channels)
    .values({ profile_id: s.profile_id })
    .returning({ id: channels.id });
  await owner(s.profile_id, `channels.${ch!.id}.type`, "social_organic");
  await owner(s.profile_id, `channels.${ch!.id}.platform`, "instagram");
  const [offer] = await db
    .insert(offers)
    .values({ profile_id: s.profile_id, kind: "physical" })
    .returning({ id: offers.id });
  await owner(s.profile_id, `offers.${offer!.id}.name`, "Ember Candle");
  await owner(s.profile_id, `offers.${offer!.id}.volume_period`, 120);
  await owner(s.profile_id, "identity.business_name", "Emberworks");
  await owner(s.profile_id, "goals.owner_boundaries", "We never discount. Never sound corporate.");
  await db.insert(utterances).values({
    profile_id: s.profile_id,
    thread_id: crypto.randomUUID(),
    role: "owner",
    text: "Honestly we just make candles that smell like a real fireplace, none of that perfume-counter stuff, and people keep coming back for the same two scents.",
    at: new Date().toISOString(),
  });
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-c-${crypto.randomUUID()}@test.local`,
      display_name: "Session C owner",
      role: "owner",
    })
    .returning({ id: users.id });
  return { ...s, user_id: u!.id, channel_id: ch!.id, offer_id: offer!.id };
}

const limitsLlm: LimitLlm = async () => ({
  text: JSON.stringify({
    limits: [
      { code: "no_discounts", quote: "we never discount" },
      { code: "tone", quote: "never sound corporate" },
    ],
  }),
  calls: [],
});

const fakeDraft: DraftLlm = async ({ system }) => ({
  text: `Real fireplace, not perfume counter. The Ember Candle is back on the bench this week. [voice:${system.includes("Emberworks") ? "card" : "missing"}]`,
});

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(utterances).where(inArray(utterances.profile_id, ids));
    await db.delete(goalsTable).where(inArray(goalsTable.profile_id, ids));
    await db.delete(channels).where(inArray(channels.profile_id, ids));
    await db.delete(offers).where(inArray(offers.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  }
  for (const s of created) {
    await db.delete(users).where(eq(users.account_id, s.account_id));
  }
  if (ids.length > 0) await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) {
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P3-14 — goals, end to end", () => {
  it("adds, lists and refines a goal through supersession — history keeps the original", async () => {
    const s = await business();
    const goal = await addGoal(s.profile_id, {
      statement: "Reach 200 candles a month",
      horizon: "6_months",
      target_value: "200/month",
    });
    expect(goal.statement).toBe("Reach 200 candles a month");

    await updateGoal(s.profile_id, goal.goal_id, { statement: "Reach 250 candles a month" });
    const [listed] = (await listGoals(s.profile_id)).filter((g) => g.goal_id === goal.goal_id);
    expect(listed?.statement).toBe("Reach 250 candles a month");

    const history = await readFieldHistory<string>(s.profile_id, `goals.${goal.goal_id}.statement`);
    expect(history).toHaveLength(2);
    expect(history[0]?.field.value).toBe("Reach 200 candles a month");
    expect(history[0]?.superseded_at).not.toBeNull();
  });

  it("refuses an empty statement and an off-vocabulary horizon", async () => {
    const s = await business();
    await expect(addGoal(s.profile_id, { statement: "  " })).rejects.toThrow(/statement/);
    await expect(addGoal(s.profile_id, { statement: "Grow", horizon: "someday" })).rejects.toThrow(
      /horizon must be one of/,
    );
  });

  it("suggestions come from the report and are never auto-written", async () => {
    const s = await business();
    expect(await suggestGoalsFromReport(s.profile_id)).toEqual([]); // no report, no invention
    expect(await listGoals(s.profile_id)).toHaveLength(0);
  });
});

describe("P3-16 — the voice card", () => {
  it("every trait names its source, exemplars are the owner's words, boundaries ride along", async () => {
    const s = await business();
    const card = await buildVoiceCard(s.profile_id, limitsLlm);
    expect(card.traits.some((t) => t.source === "identity.business_name")).toBe(true);
    for (const t of card.traits) expect(t.source).not.toBe("");
    expect(card.exemplars[0]?.text).toContain("real fireplace");
    expect(card.exemplars[0]?.source).toMatch(/^utterance:/);
    expect(card.boundaries).toContain("never sound corporate");
    const rendered = renderVoiceCard(card);
    expect(rendered).toContain("never cross these");
  });
});

describe("P3-19 — disclosure with no off switch", () => {
  it("labels every kind, applies idempotently, and the module exports no disable", () => {
    expect(disclosureLabel("video")).toContain("No AI-generated imagery");
    const once = withDisclosure("post", "A fine post.");
    expect(once).toContain("Written with AI assistance.");
    expect(withDisclosure("post", once)).toBe(once); // no stacking
    // The absence of an off switch, asserted: nothing exported looks like one.
    for (const name of Object.keys(disclosureModule)) {
      expect(name).not.toMatch(/disable|skip|opt|without|raw/i);
    }
  });
});

describe("P3-15 — the calendar proposal", () => {
  it("plans only onto existing channels, carries evidence, drafts nothing before approval", async () => {
    const s = await business();
    await addGoal(s.profile_id, { statement: "Reach 200 candles a month" });
    const proposal = await proposeContentPlan(s.profile_id, {
      weeks: 2,
      now: new Date("2026-09-22T10:00:00Z"),
      limitLlm: limitsLlm,
    });
    expect(proposal.status).toBe("pending");
    const detail = (
      proposal.action as {
        detail: { items: { date: string; evidence: string[] }[]; manual_limits: string[] };
      }
    ).detail;
    expect(detail.items).toHaveLength(6); // one social channel × 3/wk × 2 wks
    expect(detail.items[0]?.date).toBe("2026-09-29"); // next Monday (the 22nd is itself a Monday)
    for (const item of detail.items) expect(item.evidence.length).toBeGreaterThan(0);
    expect(detail.manual_limits).toContain("never sound corporate");
    expect(await contentQueue(s.profile_id)).toHaveLength(0); // nothing drafted yet
  });

  it("a profile with no plannable channels is a 422, not an invented calendar", async () => {
    const bare = await bootstrapIntake();
    created.push(bare);
    await expect(proposeContentPlan(bare.profile_id, { limitLlm: limitsLlm })).rejects.toThrow(
      /no plannable channels/,
    );
  });
});

describe("P3-17 — the shot list proposal", () => {
  it("targets the strongest offer with evidence, and every shot says why", async () => {
    const s = await business();
    const proposal = await proposeShotList(s.profile_id, { limitLlm: limitsLlm });
    const detail = (
      proposal.action as { detail: { shots: { shot: string; why: string; evidence: string[] }[] } }
    ).detail;
    expect(detail.shots).toHaveLength(7);
    for (const shot of detail.shots) {
      expect(shot.why.length).toBeGreaterThan(10);
      expect(shot.evidence.length).toBeGreaterThan(0);
    }
    expect((proposal.action as { summary: string }).summary).toContain("Ember Candle");
  });
});

describe("Session C — production from an approved plan", () => {
  it("approved plan → disclosed items with goals and provenance; proposal flips to executed", async () => {
    const s = await business();
    const goal = await addGoal(s.profile_id, { statement: "Reach 200 candles a month" });
    const proposal = await proposeContentPlan(s.profile_id, {
      weeks: 1,
      now: new Date("2026-09-22T10:00:00Z"),
      limitLlm: limitsLlm,
    });

    // Before approval: refuses.
    await expect(
      produceFromProposal(proposal.id, { draftLlm: fakeDraft, limitLlm: limitsLlm }),
    ).rejects.toThrow(/only an approved proposal/);

    await approveProposal({ proposalId: proposal.id, userId: s.user_id });
    const { items } = await produceFromProposal(proposal.id, {
      draftLlm: fakeDraft,
      limitLlm: limitsLlm,
    });
    expect(items).toHaveLength(3); // 1 wk × 3 social slots → shot lists (short_video)
    for (const item of items) {
      expect(item.disclosure).not.toBe("");
      expect(item.goal_id).toBe(goal.goal_id);
      expect(item.provenance).toBeTruthy();
      expect(item.body).toMatch(/AI assistance/);
    }
    const [prop] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(prop?.status).toBe("executed");
    expect(await contentQueue(s.profile_id)).toHaveLength(3);
  });

  it("drafted posts speak from the voice card and end disclosed", async () => {
    const s = await business();
    const card = await buildVoiceCard(s.profile_id, limitsLlm);
    const result = await draftItem({
      card,
      item: {
        date: "2026-09-28",
        channel_id: s.channel_id,
        channel_label: "instagram",
        format: "post",
        goal_id: null,
        focus: "Ember Candle",
        brief: "A post about the Ember Candle.",
        evidence: [],
      },
      kind: "post",
      accountId: s.account_id,
      llm: fakeDraft,
    });
    expect(result.body).toContain("[voice:card]"); // the card reached the prompt
    expect(result.body.trimEnd()).toMatch(/Written with AI assistance\.$/);
    expect(result.provenance.voice_card.boundaries).toContain("never sound corporate");
  });
});
