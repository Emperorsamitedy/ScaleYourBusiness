// P5-16b — the owner approves the exact follow-up email, and SYB sends it
// (rule 29 amended by the owner on 2026-11-16). What must hold, each with a
// passing and a failing case:
//   · the approval names the body as it is now (sha256) under a one-line
//     subject; a changed body, a bad subject, an unapproved proposal and a
//     follow-up labelled undoable (proposed before 2026-11-16) are refused;
//   · approving writes the approval onto the draft, sets the schedule floor
//     once, and appends one `followup_approval` decision-log row of hashes;
//   · the due runner's route takes a follow-up and nothing else;
//   · the backend's readiness names what holds it, in order: the email not
//     approved yet, then email not set up;
//   · the screen's state: approved and held while real sending is off.

import "dotenv/config";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { dealFollowups, decisionLog, proposals } from "../../db/schema";
import type { DraftLlm } from "../content/draft";
import { addContact } from "../crm/contacts";
import type { LawReviewVerdict } from "../crm/law-review";
import type { LimitLlm } from "../proposals/hard-limits";
import { approveProposal } from "../proposals/service";
import { FOLLOWUP_NAME_SLOT } from "../execution/providers/followup-email";
import { addDeal } from "./deals";
import {
  approveFollowUpEmail,
  dbFollowUpBackend,
  followUpPlanFor,
  hashFollowUpApproval,
} from "./followup-send";
import { NAME_SLOT, draftFollowUp, followUpsFor, proposeFollowUps } from "./followups";
import { cleanupBusinesses, freshBusiness, ownerUser } from "./test-fixtures";

afterAll(cleanupBusinesses);

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const limitLlm: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });
const draftLlm: DraftLlm = async () => ({
  text: `Hi ${NAME_SLOT},\n\nJust checking in on the proposal — happy to answer anything.`,
});
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const CURRENT: () => Promise<LawReviewVerdict> = async () => ({
  state: "current",
  words: "reviewed",
  reviewed_on: "2026-10-20",
});

/** A quiet deal, its follow-up approved and drafted, and the owner who approved it. */
async function drafted() {
  const s = await freshBusiness("b2b");
  const tag = crypto.randomUUID().slice(0, 8);
  const contact = await addContact(s.account_id, {
    email: `aoife.${tag}@cafenua.example`,
    name: `Aoife Nua${tag}`,
    consent: { status: "explicit_consent", source: "signed the trade-fair list, 2026-03-02" },
  });
  await addDeal(
    s.account_id,
    s.profile_id,
    {
      contact: { id: contact.id },
      company: `Café Nua ${tag}`,
      title: `Spring tableware ${tag}`,
      stage: "proposal_sent",
      next_step: null,
      last_contact_at: daysAgo(23),
    },
    undefined,
    NOW,
  );
  const proposal = (await proposeFollowUps(s.profile_id, { now: NOW, limitLlm })).created[0]!;
  const userId = await ownerUser(s.account_id);
  await approveProposal({ proposalId: proposal.id, userId, profileId: s.profile_id });
  const { draft } = await draftFollowUp(proposal.id, { draftLlm, limitLlm, now: NOW });
  return { s, proposal, userId, draft };
}

describe("P5-16b — the owner approves the exact email", () => {
  it("records the approval, sets the floor once, and logs hashes only", async () => {
    const { s, proposal, userId, draft } = await drafted();
    expect(proposal.reversibility).toMatchObject({ level: "hard" });
    const before = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(before[0]!.execute_not_before).toBeNull();

    const out = await approveFollowUpEmail({
      profileId: s.profile_id,
      proposalId: proposal.id,
      userId,
      subject: "Checking in",
      bodySha256: sha(draft.body),
      now: NOW,
    });
    expect(out.fresh).toBe(true);
    const [row] = await db.select().from(dealFollowups).where(eq(dealFollowups.id, draft.id));
    expect(row).toMatchObject({
      approved_by: userId,
      approved_sha256: sha(draft.body),
      approved_subject: "Checking in",
    });
    const [after] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(after!.execute_not_before).not.toBeNull();

    const logged = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.ref_id, proposal.id), eq(decisionLog.kind, "followup_approval")));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.payload_hash).toBe(
      hashFollowUpApproval({
        proposal_id: proposal.id,
        draft_id: draft.id,
        approved_by: userId,
        approved_at: out.approved_at,
        body_sha256: sha(draft.body),
        subject: "Checking in",
      }),
    );

    // The same approval again is a no-op: no second log row.
    const again = await approveFollowUpEmail({
      profileId: s.profile_id,
      proposalId: proposal.id,
      userId,
      subject: "Checking in",
      bodySha256: sha(draft.body),
    });
    expect(again.fresh).toBe(false);
    expect(
      await db
        .select()
        .from(decisionLog)
        .where(and(eq(decisionLog.ref_id, proposal.id), eq(decisionLog.kind, "followup_approval"))),
    ).toHaveLength(1);

    // The screen: approved, and held while real sending is off (no switch in tests).
    const state = (await followUpsFor(s.profile_id)).find((f) => f.proposal_id === proposal.id)!;
    expect(state).toMatchObject({
      email_approved: true,
      sendable: true,
      approved_subject: "Checking in",
      send: "waiting",
      body_sha256: sha(draft.body),
    });
  });

  it("refuses a changed body, a bad subject, and a follow-up labelled undoable", async () => {
    const { s, proposal, userId, draft } = await drafted();
    await expect(
      approveFollowUpEmail({
        profileId: s.profile_id,
        proposalId: proposal.id,
        userId,
        subject: "Checking in",
        bodySha256: sha(`${draft.body} `),
      }),
    ).rejects.toMatchObject({ status: 409 });
    for (const subject of ["", "two\nlines", "x".repeat(201)]) {
      await expect(
        approveFollowUpEmail({
          profileId: s.profile_id,
          proposalId: proposal.id,
          userId,
          subject,
          bodySha256: sha(draft.body),
        }),
      ).rejects.toMatchObject({ status: 422 });
    }
    // Proposed before 2026-11-16: labelled "easy", so a send would be a lie.
    await db
      .update(proposals)
      .set({ reversibility: { level: "easy", if_you_change_your_mind: "old" } })
      .where(eq(proposals.id, proposal.id));
    await expect(
      approveFollowUpEmail({
        profileId: s.profile_id,
        proposalId: proposal.id,
        userId,
        subject: "Checking in",
        bodySha256: sha(draft.body),
      }),
    ).rejects.toThrow(/sent email can't be recalled/);
    const [row] = await db.select().from(dealFollowups).where(eq(dealFollowups.id, draft.id));
    expect(row!.approved_at).toBeNull();
  });

  it("refuses a follow-up that isn't approved, and another business's", async () => {
    const s = await freshBusiness("b2b");
    const contact = await addContact(s.account_id, {
      email: `p-${crypto.randomUUID()}@firm.example`,
      consent: { status: "explicit_consent", source: "test" },
    });
    await addDeal(s.account_id, s.profile_id, {
      contact: { id: contact.id },
      title: "Quiet",
      stage: "qualified",
      last_contact_at: daysAgo(30),
    });
    const pending = (await proposeFollowUps(s.profile_id, { now: NOW, limitLlm })).created[0]!;
    const userId = await ownerUser(s.account_id);
    await expect(
      approveFollowUpEmail({
        profileId: s.profile_id,
        proposalId: pending.id,
        userId,
        subject: "Hi",
        bodySha256: sha("x"),
      }),
    ).rejects.toMatchObject({ status: 409 });
    const other = await freshBusiness("b2b");
    await expect(
      approveFollowUpEmail({
        profileId: other.profile_id,
        proposalId: pending.id,
        userId,
        subject: "Hi",
        bodySha256: sha("x"),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("P5-16b — the route and the readiness", () => {
  it("the sender fills the same greeting slot the drafter writes", () => {
    expect(FOLLOWUP_NAME_SLOT).toBe(NAME_SLOT);
  });

  it("routes a follow-up to followup_email and nothing else", () => {
    const id = crypto.randomUUID();
    expect(followUpPlanFor({ id, module: "pipeline", action: { kind: "deal_followup" } })).toEqual({
      provider: "followup_email",
      op: "send_followup",
      params: { proposal_id: id },
    });
    expect(followUpPlanFor({ id, module: "pipeline", action: { kind: "other" } })).toBeNull();
    expect(followUpPlanFor({ id, module: "crm", action: { kind: "deal_followup" } })).toBeNull();
  });

  it("names what holds it: the email not approved, then email not set up", async () => {
    const { s, proposal, userId, draft } = await drafted();
    const backend = dbFollowUpBackend({ lawReview: CURRENT });
    const ctx = { profile_id: s.profile_id, account_id: s.account_id };
    expect(await backend.readiness(proposal.id, ctx)).toMatch(
      /^You haven't approved the email itself yet\. Nothing was sent; this stays approved\.$/,
    );
    await approveFollowUpEmail({
      profileId: s.profile_id,
      proposalId: proposal.id,
      userId,
      subject: "Checking in",
      bodySha256: sha(draft.body),
    });
    const prior = { key: process.env.RESEND_API_KEY, url: process.env.APP_URL };
    delete process.env.RESEND_API_KEY;
    try {
      expect(await backend.readiness(proposal.id, ctx)).toMatch(/^Email isn't set up yet/);
      process.env.RESEND_API_KEY = "re_test";
      process.env.APP_URL = "https://syb.test";
      expect(await backend.readiness(proposal.id, ctx)).toBeNull();
      const plan = await backend.plan(proposal.id, ctx);
      expect(plan).toMatchObject({
        proposal_id: proposal.id,
        subject: "Checking in",
        body: draft.body,
        base_url: "https://syb.test",
      });
    } finally {
      if (prior.key === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prior.key;
      if (prior.url === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prior.url;
    }
    // Someone else's profile sees nothing to send.
    expect(
      await backend.readiness(proposal.id, { profile_id: crypto.randomUUID(), account_id: "x" }),
    ).toMatch(/isn't one of your follow-ups/);
  });
});
