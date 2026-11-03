// P4-12 — Session D's done-when: three real questions cluster into one
// proposed entry, approval publishes it, and the chat answers the
// fourth asker from it. Plus the guardrails: fewer than three questions
// costs no model call; a cluster nobody answered is reported, never
// drafted; junk from the model is dropped; folded tickets stay folded.

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
  llmCalls,
  proposals,
  supportConversations,
  supportSettings,
  supportTickets,
  users,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { customerLanguageLine } from "../llm/language";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal } from "../proposals/service";
import type { SupportAnswerLlm, SupportIntentLlm } from "../support/chat";
import { postCustomerMessage, startConversation } from "../support/chat";
import { publicKnowledge } from "../support/knowledge";
import { listTickets, resolveTicket } from "../support/tickets";
import type { FaqLlm } from "./faq";
import {
  FAQ_MIN_CLUSTER,
  FAQ_TICKET_SOURCE,
  clusterQuestions,
  coerceClusters,
  openQuestions,
} from "./faq";
import { entriesOf, publishKnowledgeFromProposal } from "./knowledge";
import { ensureSupportSettings } from "./support-settings";

const created: { account_id: string; profile_id: string }[] = [];
const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  const settings = await ensureSupportSettings(s.profile_id);
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p4-d-${crypto.randomUUID()}@test.local`,
      display_name: "Session D owner",
      role: "owner",
    })
    .returning({ id: users.id });
  return { ...s, user_id: u!.id, site_key: settings.site_key };
}

/** A ticket the way the chat creates one: a question nobody had an approved answer for. */
async function asked(b: { profile_id: string; account_id: string }, question: string) {
  const [t] = await db
    .insert(supportTickets)
    .values({
      profile_id: b.profile_id,
      account_id: b.account_id,
      reason: "no_answer",
      summary: question,
    })
    .returning();
  return t!;
}

const clustersAs =
  (clusters: { question: string; members: string[] }[]): FaqLlm =>
  async () => ({ text: JSON.stringify({ clusters }), calls: [] });

const neverCalled: FaqLlm = async () => {
  throw new Error("the clustering model must not be called");
};

const intentAs =
  (intent: string): SupportIntentLlm =>
  async () => ({ text: JSON.stringify({ intent }), calls: [] });

afterAll(async () => {
  const profileIds = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (profileIds.length > 0) {
    await db.delete(supportTickets).where(inArray(supportTickets.profile_id, profileIds));
    await db
      .delete(supportConversations)
      .where(inArray(supportConversations.profile_id, profileIds));
    await db.delete(knowledgeEntries).where(inArray(knowledgeEntries.profile_id, profileIds));
    await db.delete(supportSettings).where(inArray(supportSettings.profile_id, profileIds));
    await db.delete(proposals).where(inArray(proposals.profile_id, profileIds));
    await db.delete(llmCalls).where(inArray(llmCalls.account_id, accountIds));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, profileIds));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, profileIds));
  }
  for (const s of created) await db.delete(users).where(eq(users.account_id, s.account_id));
  if (profileIds.length > 0)
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("P4-12 — coercion", () => {
  it("keeps only clusters of known ids, each id once, each cluster big enough", () => {
    const valid = new Set(["a", "b", "c", "d", "e"]);
    expect(coerceClusters("junk", valid)).toEqual([]);
    expect(
      coerceClusters(
        JSON.stringify({
          clusters: [
            { question: "Hours?", members: ["a", "b", "c", "zzz", "a"] },
            { question: "Too small", members: ["d", "e"] },
            { question: "Reused", members: ["a", "b", "d"] },
            { question: "", members: ["c", "d", "e"] },
          ],
        }),
        valid,
      ),
    ).toEqual([{ question: "Hours?", members: ["a", "b", "c"] }]);
  });
});

describe("P4-12 — the loop", () => {
  it("fewer than three open questions: no model call, nothing proposed", async () => {
    const b = await business();
    await asked(b, "Do you do gift wrapping?");
    await asked(b, "Gift wrap available?");
    const out = await clusterQuestions(b.profile_id, b.account_id, {
      llm: neverCalled,
      limitLlm: noLimits,
    });
    expect(out.questions).toBe(2);
    expect(out.proposal_id).toBeNull();
    expect(FAQ_MIN_CLUSTER).toBe(3);
  });

  it("three askers cluster into one proposed entry in the OWNER'S words, approval publishes it, the fourth asker is answered from it", async () => {
    const b = await business();
    const t1 = await asked(b, "What time do you open on Saturdays?");
    const t2 = await asked(b, "Are you open at the weekend?");
    const t3 = await asked(b, "saturday opening hours??");
    const stray = await asked(b, "Do you sell gift cards?");
    // The owner answered one of them, on its ticket, in their words.
    await resolveTicket(
      b.profile_id,
      t2.id,
      "answered",
      "Yes — Saturdays 10 to 16, closed Sundays.",
    );

    const out = await clusterQuestions(b.profile_id, b.account_id, {
      llm: clustersAs([
        { question: "Are you open on Saturdays, and when?", members: [t1.id, t2.id, t3.id] },
      ]),
      limitLlm: noLimits,
    });
    expect(out.questions).toBe(4);
    expect(out.clusters).toHaveLength(1);
    expect(out.unanswered).toEqual([]);
    expect(out.proposal_id).not.toBeNull();

    const [proposal] = await db.select().from(proposals).where(eq(proposals.id, out.proposal_id!));
    expect(proposal?.status).toBe("pending");
    const entries = entriesOf(proposal!);
    expect(entries).toEqual([
      {
        question: "Are you open on Saturdays, and when?",
        answer: "Yes — Saturdays 10 to 16, closed Sundays.",
        source_keys: [t1.id, t2.id, t3.id].map((id) => `${FAQ_TICKET_SOURCE}${id}`),
      },
    ]);
    expect(await publicKnowledge(b.profile_id)).toEqual([]);

    // The three are folded; the stray is still open to a future cluster.
    expect((await openQuestions(b.profile_id)).map((q) => q.id)).toEqual([stray.id]);

    await approveProposal({ proposalId: out.proposal_id!, userId: b.user_id });
    await publishKnowledgeFromProposal(out.proposal_id!);
    const live = await publicKnowledge(b.profile_id);
    expect(live.map((e) => e.question)).toEqual(["Are you open on Saturdays, and when?"]);

    // The fourth asker: grounded on the new entry, no ticket.
    const { token } = await startConversation(b.site_key);
    const seen: string[] = [];
    const answerLlm: SupportAnswerLlm = async ({ system }) => {
      seen.push(system);
      return {
        text: JSON.stringify({
          answer: "Yes — Saturdays 10 to 16, closed Sundays.",
          grounded: true,
          used: [live[0]!.id],
        }),
        calls: [],
      };
    };
    // Folding a question into the FAQ does NOT close the people who asked it:
    // they are still waiting for a person until the owner says otherwise.
    const openBefore = (await listTickets(b.profile_id)).filter((t) => t.status === "open");
    expect(openBefore.map((t) => t.id).sort()).toEqual([t1.id, t3.id, stray.id].sort());

    const reply = await postCustomerMessage(token, "are you open saturday?", {
      intentLlm: intentAs("question"),
      answerLlm,
    });
    expect(reply.escalated).toBe(false);
    expect(reply.reply.text).toContain("Saturdays 10 to 16");
    expect(seen[0]).toContain("Saturdays 10 to 16");
    // The fourth asker was answered from the FAQ: no new ticket.
    const openAfter = (await listTickets(b.profile_id)).filter((t) => t.status === "open");
    expect(openAfter).toHaveLength(openBefore.length);
  });

  it("a cluster nobody answered is reported for the owner, never drafted into an answer", async () => {
    const b = await business();
    const ids = [
      await asked(b, "Do you deliver to Vienna?"),
      await asked(b, "Can you ship to Austria?"),
      await asked(b, "delivery to vienna possible?"),
    ].map((t) => t.id);
    const out = await clusterQuestions(b.profile_id, b.account_id, {
      llm: clustersAs([{ question: "Do you deliver to Austria?", members: ids }]),
      limitLlm: noLimits,
    });
    expect(out.proposal_id).toBeNull();
    expect(out.unanswered).toEqual([{ question: "Do you deliver to Austria?", members: ids }]);
    expect(await publicKnowledge(b.profile_id)).toEqual([]);
    expect(await db.select().from(proposals).where(eq(proposals.profile_id, b.profile_id))).toEqual(
      [],
    );
  });

  it("L-5: the canonical question is worded in the business's own language", async () => {
    const b = await business();
    await db
      .update(businessProfiles)
      .set({ language: "hu-HU" })
      .where(eq(businessProfiles.id, b.profile_id));
    for (const q of ["Szállítanak Bécsbe?", "Can you ship to Austria?", "Lieferung nach Wien?"]) {
      await asked(b, q);
    }
    const seen: string[] = [];
    await clusterQuestions(b.profile_id, b.account_id, {
      llm: async ({ system }) => (seen.push(system), { text: '{"clusters":[]}', calls: [] }),
      limitLlm: noLimits,
    });
    expect(seen[0]!.endsWith(customerLanguageLine("hu-HU"))).toBe(true);
    expect(seen[0]).not.toContain("customers' own language");
  });

  it("recording an answer keeps the owner's words, trimmed, and refuses an essay", async () => {
    const b = await business();
    const t = await asked(b, "Do you take cards?");
    await expect(
      resolveTicket(b.profile_id, t.id, "answered", "x".repeat(2001)),
    ).rejects.toMatchObject({ status: 422 });
    const row = await resolveTicket(b.profile_id, t.id, "answered", "  Yes, all major cards.  ");
    expect(row.answer).toBe("Yes, all major cards.");
    expect(row.status).toBe("answered");
  });
});
