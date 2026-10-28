// P5-16 — follow-ups as drafted proposals. What must hold, each with a
// passing and a failing case:
//   · a stale open deal whose contact holds explicit consent is proposed,
//     once per deal per month, naming no one; nothing is executed or sent;
//   · implied, unsure, no-consent and suppressed contacts are refused by
//     name (rule 23), and so is a deal that isn't stale;
//   · b2c, the watch (rule 15) and the owner's 6.4b "no consent" hold it;
//   · drafting needs an approved follow-up, re-checks consent, and checks
//     both caps BEFORE any model call;
//   · the prompt carries no name, address, phone, company, deal name or
//     next-step text (rule 24's minimum); the disclosure is applied by code;
//     a second draft costs no call.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  contacts,
  dealFollowups,
  executions,
  llmCalls,
  modeDecisions,
  proposals,
} from "../../db/schema";
import type { DraftLlm } from "../content/draft";
import { disclosureLabel } from "../content/disclosure";
import { addContact, eraseContact } from "../crm/contacts";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal } from "../proposals/service";
import { addDeal } from "./deals";
import {
  FOLLOWUP,
  FOLLOWUP_KIND,
  NAME_SLOT,
  PIPELINE_MODULE,
  draftFollowUp,
  fillName,
  followUpBrief,
  proposeFollowUps,
} from "./followups";
import { answer, cleanupBusinesses, freshBusiness, ownerUser } from "./test-fixtures";

afterAll(cleanupBusinesses);

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const limitLlm: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

function fakeDraft(): DraftLlm & { calls: number; prompts: string[] } {
  const state = Object.assign(
    (async ({ system, user }) => {
      state.calls += 1;
      state.prompts.push(`${system}\n${user}`);
      return {
        text: `Hi ${NAME_SLOT},\n\nJust checking in on the proposal — happy to answer anything, or to talk it through on a call this week.`,
      };
    }) as DraftLlm,
    { calls: 0, prompts: [] as string[] },
  );
  return state;
}

/** A b2b business with one quiet deal: no next step, last spoke 23 days ago. */
async function quietDeal(
  consent: "explicit_consent" | "implied_consent" | "unsure" | "no_consent" = "explicit_consent",
) {
  const s = await freshBusiness("b2b");
  const tag = crypto.randomUUID().slice(0, 8);
  const contact = await addContact(s.account_id, {
    email: `aoife.${tag}@cafenua.example`,
    name: `Aoife Nua${tag}`,
    phone: "+353 1 555 0101",
    consent: { status: consent, source: "signed the trade-fair list, 2026-03-02" },
  });
  const deal = await addDeal(
    s.account_id,
    s.profile_id,
    {
      contact: { id: contact.id },
      company: `Café Nua ${tag}`,
      title: `Spring tableware ${tag}`,
      stage: "proposal_sent",
      value: { amount_minor: 480_000, currency: "EUR", basis: "quoted" },
      next_step: null,
      last_contact_at: daysAgo(23),
    },
    undefined,
    NOW,
  );
  return { s, contact, deal, tag };
}

describe("P5-16 — a quiet deal becomes a proposal", () => {
  it("proposes a follow-up naming no one, easy to undo, with nothing executed", async () => {
    const { s, contact, deal, tag } = await quietDeal();
    const out = await proposeFollowUps(s.profile_id, { now: NOW, limitLlm });
    expect(out.created).toHaveLength(1);
    const p = out.created[0]!;
    expect(p.module).toBe(PIPELINE_MODULE);
    const action = p.action as { kind: string; summary: string; detail: Record<string, unknown> };
    expect(action.kind).toBe(FOLLOWUP_KIND);
    expect(action.summary).toBe(
      "Follow up a quiet deal: proposal sent, 23 days since you last spoke",
    );
    expect(action.detail).toMatchObject({
      deal_id: deal.id,
      contact_id: contact.id,
      days_quiet: 23,
      stale: { why: "no_next_step" },
      value: { amount_minor: 480_000, currency: "EUR" },
    });
    // Ids only: nothing personal or of the deal's words on the proposal (rule 22).
    const everything = JSON.stringify([p.action, p.scenario, p.reversibility]);
    for (const leak of [tag, "Aoife", "cafenua", "555 0101", "Spring tableware"]) {
      expect(everything).not.toContain(leak);
    }
    expect(p.reversibility).toMatchObject({ level: "easy" });
    expect(JSON.stringify(p.action)).toMatch(/Nothing sends/);
    expect(await db.select().from(executions).where(eq(executions.proposal_id, p.id))).toEqual([]);
  });

  it("once per deal per month: a second run proposes nothing new", async () => {
    const { s } = await quietDeal();
    expect((await proposeFollowUps(s.profile_id, { now: NOW, limitLlm })).created).toHaveLength(1);
    const again = await proposeFollowUps(s.profile_id, { now: NOW, limitLlm });
    expect(again.created).toHaveLength(0);
    expect(again.skipped[0]?.reason).toBe("already proposed this month");
  });

  it("refuses every contact the consent gate refuses, by name, and a deal that isn't stale", async () => {
    for (const consent of ["implied_consent", "unsure", "no_consent"] as const) {
      const { s } = await quietDeal(consent);
      const out = await proposeFollowUps(s.profile_id, { now: NOW, limitLlm });
      expect(out.created, consent).toHaveLength(0);
      expect(out.skipped[0]?.reason).toMatch(new RegExp(consent.replace(/_/g, " ")));
      expect(out.skipped[0]?.reason).toMatch(/Call them/);
    }
    // Suppressed: the address unsubscribed and is still on the books.
    const { s, contact } = await quietDeal();
    const { emailHash } = await import("../crm/contacts");
    const { contactSuppressions } = await import("../../db/schema");
    await db.insert(contactSuppressions).values({
      account_id: s.account_id,
      email_hash: emailHash(contact.email!),
      reason: "unsubscribed",
    });
    const out = await proposeFollowUps(s.profile_id, { now: NOW, limitLlm });
    expect(out.created).toHaveLength(0);
    expect(out.skipped[0]?.reason).toMatch(/suppressed \(unsubscribed\)/);

    // A next step due next week is not stale: nothing to follow up.
    const fresh = await freshBusiness("both");
    const c = await addContact(fresh.account_id, {
      email: `ok-${crypto.randomUUID()}@firm.example`,
      consent: { status: "explicit_consent", source: "test" },
    });
    await addDeal(fresh.account_id, fresh.profile_id, {
      contact: { id: c.id },
      title: "On track",
      next_step: "Send samples",
      next_step_due: new Date(NOW.getTime() + 7 * 86_400_000).toISOString().slice(0, 10),
    });
    const none = await proposeFollowUps(fresh.profile_id, { now: NOW, limitLlm });
    expect(none.created).toHaveLength(0);
    expect(none.skipped).toEqual([{ deal_id: null, reason: "no deal has gone quiet" }]);
  });

  it("b2c gets nothing; the watch holds it; the owner's 6.4b 'no consent' switches it off", async () => {
    const consumer = await freshBusiness("b2c");
    expect((await proposeFollowUps(consumer.profile_id, { now: NOW })).skipped[0]?.reason).toMatch(
      /sell to consumers/,
    );

    const watched = await quietDeal();
    await db.insert(modeDecisions).values({
      profile_id: watched.s.profile_id,
      mode: "watching",
      watch_weeks: 4,
      inputs: {},
      reasoning: "fixture",
      confidence: "0.800",
      review_at: new Date(NOW.getTime() + 10 * 86_400_000).toISOString(),
    });
    const held = await proposeFollowUps(watched.s.profile_id, { now: NOW, limitLlm });
    expect(held.created).toHaveLength(0);
    expect(held.skipped[0]?.reason).toMatch(/I'm watching until/);

    const off = await quietDeal();
    await answer(off.s.profile_id, "customers.marketing_consent_status", { code: "no_consent" });
    const refused = await proposeFollowUps(off.s.profile_id, { now: NOW, limitLlm });
    expect(refused.created).toHaveLength(0);
    expect(refused.skipped[0]?.reason).toMatch(/no consent/);
  });
});

describe("P5-16 — drafting the follow-up", () => {
  async function approved() {
    const q = await quietDeal();
    const out = await proposeFollowUps(q.s.profile_id, { now: NOW, limitLlm });
    const p = out.created[0]!;
    const userId = await ownerUser(q.s.account_id);
    await approveProposal({ proposalId: p.id, userId, profileId: q.s.profile_id });
    return { ...q, proposal: p };
  }

  it("drafts in the owner's voice with nobody named in the prompt, disclosure by code, once", async () => {
    const { s, proposal, contact, tag } = await approved();
    const llm = fakeDraft();
    const { draft, fresh } = await draftFollowUp(proposal.id, {
      draftLlm: llm,
      limitLlm,
      expectedProfileId: s.profile_id,
      now: NOW,
    });
    expect(fresh).toBe(true);
    expect(llm.calls).toBe(1);
    const prompt = llm.prompts[0]!;
    for (const leak of [tag, "Aoife", contact.email!, "555 0101", "Café", "Spring tableware"]) {
      expect(prompt).not.toContain(leak);
    }
    expect(prompt).toContain(`Hi ${NAME_SLOT},`);
    expect(prompt).toMatch(/23 days since we last spoke/);
    expect(draft.body.endsWith(disclosureLabel("email"))).toBe(true);
    expect(draft.body).toContain(NAME_SLOT); // the name is never stored either
    expect(fillName(draft.body, contact.name)).toMatch(/^Hi Aoife,/);

    // Idempotent: the second click is the same draft and no model call.
    const again = await draftFollowUp(proposal.id, { draftLlm: llm, limitLlm, now: NOW });
    expect(again).toMatchObject({ fresh: false, draft: { id: draft.id } });
    expect(llm.calls).toBe(1);

    // And the draft goes with the contact (rule 22).
    await eraseContact(s.account_id, contact.id);
    expect(
      await db.select().from(dealFollowups).where(eq(dealFollowups.id, draft.id)),
    ).toHaveLength(0);
    await expect(draftFollowUp(proposal.id, { draftLlm: llm, limitLlm })).rejects.toMatchObject({
      status: 410,
    });
  });

  it("refuses a pending proposal, a withdrawn consent and a closed deal — with no model call", async () => {
    const q = await quietDeal();
    const pending = (await proposeFollowUps(q.s.profile_id, { now: NOW, limitLlm })).created[0]!;
    const llm = fakeDraft();
    await expect(draftFollowUp(pending.id, { draftLlm: llm, limitLlm })).rejects.toMatchObject({
      status: 409,
    });

    const a = await approved();
    await db
      .update(contacts)
      .set({ consent_status: "implied_consent" })
      .where(eq(contacts.id, a.contact.id));
    await expect(draftFollowUp(a.proposal.id, { draftLlm: llm, limitLlm })).rejects.toThrow(
      /can't draft an email to them now/,
    );

    const b = await approved();
    const { updateDeal } = await import("./deals");
    await updateDeal(b.s.account_id, b.deal.id, { stage: "won" });
    await expect(draftFollowUp(b.proposal.id, { draftLlm: llm, limitLlm })).rejects.toThrow(
      /won now/,
    );
    expect(llm.calls).toBe(0);
  });

  it("checks both caps before the call: the month's spend, and the month's count", async () => {
    const llm = fakeDraft();
    const spent = await approved();
    await db.insert(llmCalls).values({
      account_id: spent.s.account_id,
      workload: FOLLOWUP.workload,
      model: "claude-sonnet-5",
      duration_ms: 1,
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cost_eur: String(FOLLOWUP.monthly_cap_eur),
      at: NOW.toISOString(),
    });
    await expect(
      draftFollowUp(spent.proposal.id, { draftLlm: llm, limitLlm, now: NOW }),
    ).rejects.toMatchObject({ status: 429 });

    const busy = await approved();
    const fillers = await db
      .insert(proposals)
      .values(
        Array.from({ length: FOLLOWUP.drafts_per_month }, () => ({
          profile_id: busy.s.profile_id,
          module: "pipeline",
          action: { kind: FOLLOWUP_KIND, summary: "filler" },
          scenario: {},
          reversibility: { level: "easy", if_you_change_your_mind: "n/a" },
          expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
        })),
      )
      .returning({ id: proposals.id });
    await db.insert(dealFollowups).values(
      fillers.map((f) => ({
        account_id: busy.s.account_id,
        profile_id: busy.s.profile_id,
        deal_id: busy.deal.id,
        proposal_id: f.id,
        body: "x",
        disclosure: disclosureLabel("email"),
        provenance: {},
        created_at: NOW.toISOString(),
      })),
    );
    await expect(
      draftFollowUp(busy.proposal.id, { draftLlm: llm, limitLlm, now: NOW }),
    ).rejects.toThrow(/my limit/);
    expect(llm.calls).toBe(0);
    await db.delete(proposals).where(
      inArray(
        proposals.id,
        fillers.map((f) => f.id),
      ),
    );
  });

  it("the brief is pure and names no one, whatever the stage", () => {
    const brief = followUpBrief({
      stage: "qualified",
      age: { days_in_stage: 4, days_quiet: 1, quiet_from: "added" },
      stale: { why: "no_next_step" },
    });
    expect(brief).toMatch(/1 day with no word/);
    expect(brief).toMatch(/never write a name/);
    expect(fillName(`Hi ${NAME_SLOT},`, null)).toBe("Hi there,");
  });
});
