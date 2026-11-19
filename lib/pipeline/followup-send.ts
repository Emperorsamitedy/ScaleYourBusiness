// The deal follow-up send, owner side and database side — P5-16b; rule 29
// amended by the owner on 2026-11-16 ("make all these automatic all the owner
// should do is just approve"); rules 12, 22, 23.
//
// lib/execution/providers/followup-email.ts sends; this file remembers, as
// lib/crm/campaign-send.ts does for campaigns. It holds:
//
//   approval      the owner approves the exact email (its sha256 and the
//                 subject line they gave it) — the second, separate yes the
//                 P3-21 design asks for: what goes out is what was seen. A
//                 decision-log `followup_approval` entry, ids and hashes only.
//                 It sets the proposal's schedule floor, so the due runner
//                 sends it on its next pass
//   the backend   what the executor reads and writes (FollowUpBackend): the
//                 readiness sentences, the plan, THE consent check at the
//                 moment of the send, and the one campaign_sends row
//   the route     followUpPlanFor: the due runner's route
//
// Nothing here stores an address, a name or a body beside a send: the row
// holds the contact id (nulled on erasure), the address's keyed hash, codes
// and the email service's id.

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  campaignSends,
  contacts,
  dealFollowups,
  deals,
  decisionLog,
  proposals,
  users,
} from "../../db/schema";
import { appUrl, resendApiKey } from "../env";
import type { DispatchPlan } from "../execution/due";
import { ExecutionRefused, executeProposal } from "../execution/engine";
import type { ExecutionContext, ExecutionProvider } from "../execution/providers/fixture";
import { executionProvider } from "../execution/providers/index";
import type {
  FollowUpBackend,
  FollowUpCheck,
  FollowUpPlan,
} from "../execution/providers/followup-email";
import {
  FOLLOWUP_OP,
  FOLLOWUP_PROVIDER,
  followUpIdempotencyKey,
} from "../execution/providers/followup-email";
import { sha256 } from "../execution/providers/email-campaign";
import { COUNTRY_KEY } from "../hours/timezone";
import { readCurrentField } from "../profile/field-store";
import type { ProposalRow } from "../proposals/service";
import { campaignFromHeader, sendingAddress, unsubscribeBase } from "../crm/campaign-send";
import { POSTAL_ADDRESS_KEY } from "../crm/campaign-draft";
import type { ContactRow } from "../crm/contacts";
import { emailHash, normalizeEmail, outboundPosture } from "../crm/contacts";
import { canSendMarketing } from "../crm/jurisdiction";
import type { LawReviewVerdict } from "../crm/law-review";
import { currentLawReview } from "../crm/law-review";
import { BUSINESS_NAME_KEY } from "../crm/support-settings";
import { FOLLOWUP_KIND, PIPELINE_MODULE } from "./followups";
import { STAGE_LABELS, isOpenStage } from "./stages";

export class FollowUpSendError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "FollowUpSendError";
    this.status = status;
  }
}

const STILL_APPROVED = "Nothing was sent; this stays approved.";

export const FOLLOWUP_GATE_WORDS = {
  not_followup: "This isn't one of your follow-ups. Nothing was sent.",
  not_approved: "This follow-up isn't approved, so it doesn't go out.",
  labelled_undoable:
    "This follow-up was approved as something that could be undone, and a sent email can't be recalled. Decline it and propose it again.",
  no_draft: "There's no email drafted for this follow-up yet.",
  draft_not_approved: "You haven't approved the email itself yet.",
  draft_changed:
    "The email changed after you approved it. Approve it again as it is now before it sends.",
  draft_incomplete: "The email is missing its AI disclosure, so it can't be sent as approved.",
  deal_gone: "That deal is gone, so the follow-up isn't sent.",
  outbound_off:
    'Your own answer on customer consent was "no consent", so outbound email is off until your data says otherwise.',
  email_not_set_up:
    "Email isn't set up yet: ScaleX's sending key or its public web address is missing, so there's nowhere for an unsubscribe link to point.",
  no_reply_to:
    "The person who approved this email has no address on file for replies, so it isn't sent.",
} as const;

/* ── is it a follow-up ── */

export function isFollowUpProposal(p: Pick<ProposalRow, "module" | "action">): boolean {
  return p.module === PIPELINE_MODULE && (p.action as { kind?: unknown })?.kind === FOLLOWUP_KIND;
}

/** The due runner's route for a follow-up (P5-16b): one op, the proposal's own id. */
export function followUpPlanFor(
  proposal: Pick<ProposalRow, "id" | "module" | "action">,
): DispatchPlan | null {
  if (!isFollowUpProposal(proposal)) return null;
  return { provider: FOLLOWUP_PROVIDER, op: FOLLOWUP_OP, params: { proposal_id: proposal.id } };
}

type DraftRow = typeof dealFollowups.$inferSelect;

/** Pure: where the owner's approval of the draft stands. */
export function draftState(
  draft: Pick<DraftRow, "body" | "disclosure" | "approved_at" | "approved_sha256"> | null,
): "none" | "unapproved" | "changed" | "incomplete" | "approved" {
  if (!draft) return "none";
  if (!draft.body.includes(draft.disclosure)) return "incomplete";
  if (!draft.approved_at || !draft.approved_sha256) return "unapproved";
  return sha256(draft.body) === draft.approved_sha256 ? "approved" : "changed";
}

async function draftFor(proposalId: string): Promise<DraftRow | null> {
  const [row] = await db
    .select()
    .from(dealFollowups)
    .where(eq(dealFollowups.proposal_id, proposalId));
  return row ?? null;
}

async function answered(profileId: string, key: string): Promise<string | null> {
  const f = await readCurrentField<string>(profileId, key);
  return f && f.status === "answered" && typeof f.value === "string" && f.value.trim() !== ""
    ? f.value.trim()
    : null;
}

function dealIdOf(proposal: ProposalRow): string | null {
  const id = (proposal.action as { detail?: { deal_id?: unknown } } | null)?.detail?.deal_id;
  return typeof id === "string" ? id : null;
}

/* ── the gates, in words ── */

interface Ready {
  proposal: ProposalRow;
  draft: DraftRow;
  deal: typeof deals.$inferSelect;
  reply_to: string;
}

async function ready(
  proposalId: string,
  ctx: Pick<ExecutionContext, "profile_id">,
  lawReview: () => Promise<LawReviewVerdict>,
): Promise<Ready | { refused: string }> {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
  if (!proposal || proposal.profile_id !== ctx.profile_id || !isFollowUpProposal(proposal)) {
    return { refused: FOLLOWUP_GATE_WORDS.not_followup };
  }
  const held = (words: string) => ({ refused: `${words} ${STILL_APPROVED}` });
  if (proposal.status !== "approved") return { refused: FOLLOWUP_GATE_WORDS.not_approved };
  if ((proposal.reversibility as { level?: string } | null)?.level !== "hard") {
    return held(FOLLOWUP_GATE_WORDS.labelled_undoable);
  }
  const draft = await draftFor(proposal.id);
  const state = draftState(draft);
  if (state === "none") return held(FOLLOWUP_GATE_WORDS.no_draft);
  if (state === "incomplete") return held(FOLLOWUP_GATE_WORDS.draft_incomplete);
  if (state === "unapproved") return held(FOLLOWUP_GATE_WORDS.draft_not_approved);
  if (state === "changed") return held(FOLLOWUP_GATE_WORDS.draft_changed);
  const dealId = dealIdOf(proposal);
  const [deal] = dealId
    ? await db
        .select()
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.profile_id, proposal.profile_id)))
    : [];
  if (!deal) return { refused: FOLLOWUP_GATE_WORDS.deal_gone };
  if (!isOpenStage(deal.stage)) {
    return {
      refused: `That deal is ${STAGE_LABELS[deal.stage].toLowerCase()} now, so the follow-up isn't sent.`,
    };
  }
  if ((await outboundPosture(proposal.profile_id)) === "disabled") {
    return held(FOLLOWUP_GATE_WORDS.outbound_off);
  }
  const review = await lawReview();
  if (review.state !== "current") return held(review.words);
  if (!resendApiKey() || unsubscribeBase(appUrl()) === null) {
    return held(FOLLOWUP_GATE_WORDS.email_not_set_up);
  }
  const [approver] = draft!.approved_by
    ? await db.select({ email: users.email }).from(users).where(eq(users.id, draft!.approved_by))
    : [];
  const replyTo = approver?.email ? normalizeEmail(approver.email) : null;
  if (!replyTo) return held(FOLLOWUP_GATE_WORDS.no_reply_to);
  return { proposal, draft: draft!, deal, reply_to: replyTo };
}

/* ── the database backend ── */

export interface FollowUpBackendOptions {
  /** Tests: stand in for the recorded law review (a global fact). */
  lawReview?: () => Promise<LawReviewVerdict>;
  now?: () => Date;
}

export function dbFollowUpBackend(opts: FollowUpBackendOptions = {}): FollowUpBackend {
  const now = opts.now ?? (() => new Date());
  const lawReview = opts.lawReview ?? currentLawReview;
  const rowOf = async (proposalId: string) => {
    const [row] = await db
      .select({ id: campaignSends.id, status: campaignSends.status })
      .from(campaignSends)
      .where(eq(campaignSends.idempotency_key, followUpIdempotencyKey(proposalId)));
    return row ?? null;
  };

  return {
    async readiness(proposalId, ctx) {
      const r = await ready(proposalId, ctx, lawReview);
      return "refused" in r ? r.refused : null;
    },

    async plan(proposalId, ctx): Promise<FollowUpPlan | { refused: string }> {
      const r = await ready(proposalId, ctx, lawReview);
      if ("refused" in r) return r;
      const base = unsubscribeBase(appUrl());
      if (!base || !r.draft.approved_subject) {
        return { refused: `${FOLLOWUP_GATE_WORDS.email_not_set_up} ${STILL_APPROVED}` };
      }
      const senderName = (await answered(r.proposal.profile_id, BUSINESS_NAME_KEY)) ?? "";
      const address = sendingAddress();
      return {
        proposal_id: r.proposal.id,
        from: campaignFromHeader(senderName, address),
        from_address: address,
        sender_name: senderName.trim() || "A business",
        reply_to: r.reply_to,
        subject: r.draft.approved_subject,
        body: r.draft.body,
        disclosure: r.draft.disclosure,
        postal_address: await answered(r.proposal.profile_id, POSTAL_ADDRESS_KEY),
        base_url: base,
      };
    },

    async prior(proposalId) {
      const row = await rowOf(proposalId);
      return row ? { send_id: row.id, status: row.status } : null;
    },

    async settleInterrupted(proposalId) {
      await db
        .update(campaignSends)
        .set({ status: "unknown" })
        .where(
          and(
            eq(campaignSends.idempotency_key, followUpIdempotencyKey(proposalId)),
            eq(campaignSends.status, "sending"),
          ),
        );
    },

    async check(proposalId, plan, message, ctx): Promise<FollowUpCheck> {
      const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
      const dealId = proposal ? dealIdOf(proposal) : null;
      const [deal] = dealId
        ? await db
            .select({ contact_id: deals.contact_id })
            .from(deals)
            .where(and(eq(deals.id, dealId), eq(deals.account_id, ctx.account_id)))
        : [];
      const [contact] = deal
        ? await db
            .select()
            .from(contacts)
            .where(and(eq(contacts.id, deal.contact_id), eq(contacts.account_id, ctx.account_id)))
        : [];
      if (!contact) return { ok: false, codes: ["contact_gone"], words: "the contact is gone" };
      const country = await answered(ctx.profile_id, COUNTRY_KEY);
      // The message as it will be sent: a disclosure or an address counts only if it is IN the body.
      const verdict = await canSendMarketing({
        contact: contact as ContactRow,
        businessCountry: country,
        message: {
          sender_name: plan.sender_name,
          sender_email: plan.from_address,
          postal_address:
            plan.postal_address !== null && message.body.includes(plan.postal_address)
              ? plan.postal_address
              : null,
          unsubscribe_url: message.unsubscribe_url,
          disclosure: message.body.includes(plan.disclosure) ? plan.disclosure : "",
        },
      });
      if (!verdict.allowed || !contact.email) {
        return {
          ok: false,
          codes: verdict.codes.length > 0 ? verdict.codes : ["no_email"],
          words: verdict.allowed ? "the contact has no email address" : verdict.reason,
        };
      }
      const email = normalizeEmail(contact.email);
      return {
        ok: true,
        contact_id: contact.id,
        email,
        email_hash: emailHash(email),
        name: contact.name,
      };
    },

    async refuse(proposalId, contactId, codes, ctx) {
      const key = followUpIdempotencyKey(proposalId);
      await db
        .insert(campaignSends)
        .values({
          id: randomUUID(),
          proposal_id: proposalId,
          execution_id: ctx.execution_id!,
          profile_id: ctx.profile_id,
          account_id: ctx.account_id,
          contact_id: contactId,
          status: "refused",
          refused_reasons: codes,
          idempotency_key: key,
        })
        .onConflictDoNothing();
      await db
        .update(campaignSends)
        .set({ status: "refused", refused_reasons: codes })
        .where(and(eq(campaignSends.idempotency_key, key), eq(campaignSends.status, "pending")));
    },

    async claim(proposalId, c, ctx) {
      const key = followUpIdempotencyKey(proposalId);
      await db
        .insert(campaignSends)
        .values({
          id: randomUUID(),
          proposal_id: proposalId,
          execution_id: ctx.execution_id!,
          profile_id: ctx.profile_id,
          account_id: ctx.account_id,
          contact_id: c.contact_id,
          status: "pending",
          idempotency_key: key,
        })
        .onConflictDoNothing();
      const rows = await db
        .update(campaignSends)
        .set({
          status: "sending",
          execution_id: ctx.execution_id!,
          contact_id: c.contact_id,
          email_hash: c.email_hash,
          unsubscribe_token_hash: c.token_hash,
          sender_name: c.sender_name,
          body_sha256: c.body_sha256,
          claimed_at: now().toISOString(),
        })
        .where(and(eq(campaignSends.idempotency_key, key), eq(campaignSends.status, "pending")))
        .returning({ id: campaignSends.id });
      return rows[0] ? { send_id: rows[0].id, idempotency_key: key } : null;
    },

    async record(sendId, outcome) {
      const at = now().toISOString();
      const set =
        outcome.kind === "sent"
          ? { status: "sent" as const, provider_message_id: outcome.provider_id, sent_at: at }
          : outcome.kind === "refused"
            ? { status: "failed" as const, provider_status: outcome.status }
            : { status: "unknown" as const };
      await db
        .update(campaignSends)
        .set(set)
        .where(and(eq(campaignSends.id, sendId), eq(campaignSends.status, "sending")));
    },

    async release(sendId) {
      await db
        .update(campaignSends)
        .set({
          status: "pending",
          email_hash: null,
          unsubscribe_token_hash: null,
          sender_name: null,
          body_sha256: null,
          claimed_at: null,
        })
        .where(and(eq(campaignSends.id, sendId), eq(campaignSends.status, "sending")));
    },
  };
}

/* ── the owner approves the exact email ── */

export function hashFollowUpApproval(p: {
  proposal_id: string;
  draft_id: string;
  approved_by: string;
  approved_at: string;
  body_sha256: string;
  subject: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "followup_approval",
        proposal_id: p.proposal_id,
        draft_id: p.draft_id,
        approved_by: p.approved_by,
        approved_at: p.approved_at,
        body_sha256: p.body_sha256,
        subject_sha256: sha256(p.subject),
      }),
    )
    .digest("hex");
}

/**
 * The owner approves THIS email: the body whose sha256 they were shown, under
 * the subject line they typed. Refused when the body changed under them, or
 * when the follow-up was approved as undoable (a sent email can't be). Sets
 * the proposal's schedule floor to now when it had none, so the due runner
 * sends it on its next pass.
 */
export async function approveFollowUpEmail(args: {
  profileId: string;
  proposalId: string;
  userId: string;
  subject: string;
  bodySha256: string;
  now?: Date;
}): Promise<{ draft_id: string; approved_at: string; fresh: boolean }> {
  const at = (args.now ?? new Date()).toISOString();
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, args.proposalId));
  if (!proposal || proposal.profile_id !== args.profileId || !isFollowUpProposal(proposal)) {
    throw new FollowUpSendError("no such follow-up", 404);
  }
  if (proposal.status !== "approved") {
    throw new FollowUpSendError(
      `only an approved follow-up is sent — this one is ${proposal.status}`,
      409,
    );
  }
  if ((proposal.reversibility as { level?: string } | null)?.level !== "hard") {
    throw new FollowUpSendError(FOLLOWUP_GATE_WORDS.labelled_undoable, 409);
  }
  const subject = args.subject.trim();
  if (subject === "" || subject.length > 200 || /[\r\n]/.test(subject)) {
    throw new FollowUpSendError("the subject line must be one line of at most 200 characters", 422);
  }
  const draft = await draftFor(proposal.id);
  if (!draft) throw new FollowUpSendError(FOLLOWUP_GATE_WORDS.no_draft, 409);
  const bodySha = sha256(draft.body);
  if (args.bodySha256.trim().toLowerCase() !== bodySha) {
    throw new FollowUpSendError(
      "the email changed since you opened it: read it again as it is now, then approve",
      409,
    );
  }
  if (!draft.body.includes(draft.disclosure)) {
    throw new FollowUpSendError(FOLLOWUP_GATE_WORDS.draft_incomplete, 422);
  }
  if (
    draft.approved_sha256 === bodySha &&
    draft.approved_subject === subject &&
    draft.approved_at
  ) {
    return { draft_id: draft.id, approved_at: draft.approved_at, fresh: false };
  }
  await db.transaction(async (tx) => {
    await tx
      .update(dealFollowups)
      .set({
        approved_by: args.userId,
        approved_at: at,
        approved_sha256: bodySha,
        approved_subject: subject,
      })
      .where(eq(dealFollowups.id, draft.id));
    if (proposal.execute_not_before === null) {
      await tx
        .update(proposals)
        .set({ execute_not_before: at })
        .where(and(eq(proposals.id, proposal.id), eq(proposals.status, "approved")));
    }
    await tx.insert(decisionLog).values({
      profile_id: proposal.profile_id,
      actor: "owner",
      user_id: args.userId,
      kind: "followup_approval",
      ref_id: proposal.id,
      payload_hash: hashFollowUpApproval({
        proposal_id: proposal.id,
        draft_id: draft.id,
        approved_by: args.userId,
        approved_at: at,
        body_sha256: bodySha,
        subject,
      }),
    });
  });
  const [acct] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, proposal.profile_id));
  console.log(
    JSON.stringify({
      event: "followup_email_approved",
      account_id: acct?.account_id ?? null,
      proposal_id: proposal.id,
      draft_id: draft.id,
    }),
  );
  return { draft_id: draft.id, approved_at: at, fresh: true };
}

/* ── the send, through the engine ── */

export interface FollowUpSendNow {
  /** "sent": it went; "held": it waits (sending off, or the stop); "refused": a gate held it; "failed": it didn't go. */
  result: "sent" | "held" | "refused" | "failed";
  message: string;
}

/**
 * The owner's "Approve and send": executeProposal with the follow-up
 * provider, so every guard runs. While real sending is off the provider
 * defers it, unclaimed, and it stays approved for the due runner.
 */
export async function sendFollowUpNow(args: {
  profileId: string;
  proposalId: string;
  provider?: ExecutionProvider;
}): Promise<FollowUpSendNow> {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, args.proposalId));
  if (!proposal || proposal.profile_id !== args.profileId || !isFollowUpProposal(proposal)) {
    throw new FollowUpSendError("no such follow-up", 404);
  }
  try {
    const run = await executeProposal({
      proposalId: proposal.id,
      provider: args.provider ?? executionProvider(FOLLOWUP_PROVIDER),
      op: FOLLOWUP_OP,
      params: { proposal_id: proposal.id },
    });
    if (run.status === "succeeded") {
      return { result: "sent", message: "Sent. Their consent was checked again as it went." };
    }
    return {
      result: run.held_for ? "held" : "failed",
      message: run.error ?? "The send didn't finish.",
    };
  } catch (error) {
    if (error instanceof ExecutionRefused) {
      return {
        result: error.code === "deferred" ? "held" : "refused",
        message: error.message,
      };
    }
    throw error;
  }
}
