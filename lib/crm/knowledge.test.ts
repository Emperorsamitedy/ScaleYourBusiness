// P4-05 — the knowledge base is seeded by PROPOSALS: candidates are
// rendered from an allowlist of public-safe facts (never margins, costs
// or staff), proposed as one item in the queue, published only once
// approved, retired on request, and superseded when the fact behind
// them changes. Nothing unapproved is ever a sayable row.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  intakeEvents,
  knowledgeEntries,
  offers,
  proposals,
  users,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal } from "../proposals/service";
import { publicKnowledge } from "../support/knowledge";
import {
  KNOWLEDGE_KIND,
  KNOWLEDGE_MODULE,
  PUBLIC_FACT_KEYS,
  entriesOf,
  knowledgeCandidates,
  listKnowledge,
  proposeCustomKnowledge,
  proposeKnowledgeEntries,
  publishKnowledgeFromProposal,
  retireKnowledgeEntry,
} from "./knowledge";

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

const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  await owner(s.profile_id, "identity.legal_name", "Ember & Oak");
  await owner(s.profile_id, "presence.opening_hours", "Mon–Sat 9–18");
  await owner(s.profile_id, "revenue.payment.refund_policy", "14 days, no questions asked.");
  await owner(s.profile_id, "fulfilment.ships_products", true);
  // Things a customer must never hear — present, and never proposed.
  await owner(s.profile_id, "costs.fixed_monthly", { amount_minor: 250000, currency: "EUR" });
  await owner(s.profile_id, "revenue.monthly_revenue", { amount_minor: 900000, currency: "EUR" });
  const [offer] = await db
    .insert(offers)
    .values({ profile_id: s.profile_id, kind: "physical" })
    .returning({ id: offers.id });
  await owner(s.profile_id, `offers.${offer!.id}.name`, "Ember Candle");
  await owner(s.profile_id, `offers.${offer!.id}.price`, { amount_minor: 2500, currency: "EUR" });
  await owner(s.profile_id, `offers.${offer!.id}.cost_to_deliver`, {
    amount_minor: 900,
    currency: "EUR",
  });
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p4-b-${crypto.randomUUID()}@test.local`,
      display_name: "Session B owner",
      role: "owner",
    })
    .returning({ id: users.id });
  return { ...s, user_id: u!.id, offer_id: offer!.id };
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(knowledgeEntries).where(inArray(knowledgeEntries.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(offers).where(inArray(offers.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  }
  for (const s of created) await db.delete(users).where(eq(users.account_id, s.account_id));
  if (ids.length > 0) await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("P4-05 — candidates from facts", () => {
  it("the allowlist holds nothing a customer must not hear", () => {
    for (const key of PUBLIC_FACT_KEYS) {
      expect(key).not.toMatch(/^costs\.|^revenue\.monthly|margin|debt|staff|supplier|cash/);
    }
  });

  it("renders public-safe facts and offers into plain Q&A, and nothing else", async () => {
    const b = await business();
    const candidates = await knowledgeCandidates(b.profile_id);
    const questions = candidates.map((c) => c.question);
    expect(questions).toContain("What is the business called?");
    expect(questions).toContain("What are your opening hours?");
    expect(questions).toContain("What is your refund policy?");
    expect(questions).toContain("Do you ship products?");
    expect(questions).toContain("What is Ember Candle and how much does it cost?");
    const flat = JSON.stringify(candidates);
    expect(flat).not.toContain("2500.00"); // monthly costs
    expect(flat).not.toContain("9000"); // revenue
    expect(flat).not.toContain("cost_to_deliver");
    const hours = candidates.find((c) => c.question === "What are your opening hours?");
    expect(hours?.answer).toContain("Mon–Sat 9–18");
    expect(hours?.source_keys).toEqual(["presence.opening_hours"]);
    const offer = candidates.find((c) => c.question.startsWith("What is Ember Candle"));
    expect(offer?.answer).toMatch(/Ember Candle costs/);
    expect(offer?.source_keys).toEqual([`offers.${b.offer_id}.name`, `offers.${b.offer_id}.price`]);
  });
});

describe("P4-05 — proposed, approved, published, retired, superseded", () => {
  it("one proposal in the queue; nothing is sayable until approval publishes it", async () => {
    const b = await business();
    const proposal = await proposeKnowledgeEntries(b.profile_id, { limitLlm: noLimits });
    expect(proposal.status).toBe("pending");
    expect(proposal.module).toBe(KNOWLEDGE_MODULE);
    expect((proposal.action as { kind: string }).kind).toBe(KNOWLEDGE_KIND);
    const entries = entriesOf(proposal);
    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect(await publicKnowledge(b.profile_id)).toEqual([]);

    // Already waiting: proposing again is a 422, not a duplicate.
    await expect(
      proposeKnowledgeEntries(b.profile_id, { limitLlm: noLimits }),
    ).rejects.toMatchObject({ status: 422 });
    // Not approved: publishing refuses.
    await expect(publishKnowledgeFromProposal(proposal.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(await publicKnowledge(b.profile_id)).toEqual([]);

    await approveProposal({ proposalId: proposal.id, userId: b.user_id });
    // Foreign profile: missing, never confirmed.
    await expect(
      publishKnowledgeFromProposal(proposal.id, { expectedProfileId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
    const published = await publishKnowledgeFromProposal(proposal.id, {
      expectedProfileId: b.profile_id,
    });
    expect(published).toHaveLength(entries.length);
    expect((await publicKnowledge(b.profile_id)).map((e) => e.question).sort()).toEqual(
      entries.map((e) => e.question).sort(),
    );
    const [row] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(row?.status).toBe("executed");

    // Everything public: nothing new to propose.
    await expect(proposeKnowledgeEntries(b.profile_id, { limitLlm: noLimits })).rejects.toThrow(
      /nothing new/,
    );
  });

  it("retiring takes an entry out of the sayable set at once and keeps the row", async () => {
    const b = await business();
    const proposal = await proposeKnowledgeEntries(b.profile_id, { limitLlm: noLimits });
    await approveProposal({ proposalId: proposal.id, userId: b.user_id });
    await publishKnowledgeFromProposal(proposal.id);
    const before = await publicKnowledge(b.profile_id);
    const hours = before.find((e) => e.question === "What are your opening hours?")!;
    const retired = await retireKnowledgeEntry(b.profile_id, hours.id);
    expect(retired.status).toBe("retired");
    expect(retired.retired_at).not.toBeNull();
    expect((await publicKnowledge(b.profile_id)).map((e) => e.id)).not.toContain(hours.id);
    const all = await listKnowledge(b.profile_id);
    expect(all.at(-1)?.id).toBe(hours.id);
    await expect(retireKnowledgeEntry(b.profile_id, hours.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("a changed fact is re-proposed alone, and publishing it retires the entry it replaces", async () => {
    const b = await business();
    const first = await proposeKnowledgeEntries(b.profile_id, { limitLlm: noLimits });
    await approveProposal({ proposalId: first.id, userId: b.user_id });
    await publishKnowledgeFromProposal(first.id);
    const old = (await publicKnowledge(b.profile_id)).find(
      (e) => e.question === "What are your opening hours?",
    )!;

    await owner(b.profile_id, "presence.opening_hours", "Mon–Fri 10–17");
    const second = await proposeKnowledgeEntries(b.profile_id, { limitLlm: noLimits });
    const entries = entriesOf(second);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.answer).toContain("Mon–Fri 10–17");
    await approveProposal({ proposalId: second.id, userId: b.user_id });
    await publishKnowledgeFromProposal(second.id);

    const now = await publicKnowledge(b.profile_id);
    const hours = now.filter((e) => e.question === "What are your opening hours?");
    expect(hours).toHaveLength(1);
    expect(hours[0]?.answer).toContain("Mon–Fri 10–17");
    const [stale] = await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, old.id));
    expect(stale?.status).toBe("retired");
  });

  it("an owner-written answer takes the same road: queue, approval, publish, with its source named", async () => {
    const b = await business();
    await expect(
      proposeCustomKnowledge(b.profile_id, { question: "?", answer: "" }, { limitLlm: noLimits }),
    ).rejects.toMatchObject({ status: 422 });
    const proposal = await proposeCustomKnowledge(
      b.profile_id,
      { question: "Do you do gift wrapping?", answer: "Yes, free on every order." },
      { limitLlm: noLimits },
    );
    expect(await publicKnowledge(b.profile_id)).toEqual([]);
    await approveProposal({ proposalId: proposal.id, userId: b.user_id });
    const [entry] = await publishKnowledgeFromProposal(proposal.id);
    expect(entry?.source_keys).toEqual(["owner:written"]);
    expect((await publicKnowledge(b.profile_id)).map((e) => e.question)).toEqual([
      "Do you do gift wrapping?",
    ]);
  });
});
