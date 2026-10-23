// The campaign send, owner side and database side — P4-15 (Phase 4 Session F).
//
// lib/execution/providers/email-campaign.ts sends; this file remembers, as
// lib/content/publishing.ts does for Meta publishing. It holds:
//
//   the backend   what the executor reads and writes (CampaignBackend):
//                 readiness (guard 6b's sentences), the run's plan, the
//                 per-recipient rows in campaign_sends, and THE per-recipient
//                 check — the contact read again at the moment of their send
//                 and run through canSendMarketing (rule 23)
//   approval      the owner approves the exact email (its sha256 and the
//                 subject line they gave it) — the second, separate consent
//                 the P3-21 design asks for: what goes out is what was seen.
//                 A decision-log `campaign_approval` entry, ids and hashes only
//   the send      sendCampaignNow: the owner's click, THROUGH executeProposal;
//                 campaignPlanFor: the due runner's route for later runs
//   the state     what /customers shows per campaign — counts by status and
//                 by refusal reason, unsubscribed since, and which gate holds
//                 it, in words
//
// Nothing here stores an address, a name or a body beside a send: rows hold
// the contact id (nulled on erasure), the address's keyed hash, codes and
// Resend's id.

import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  campaignComparisons,
  campaignSends,
  contacts,
  contentItems,
  decisionLog,
  executions,
  proposals,
} from "../../db/schema";
import { appUrl, resendApiKey, sessionDRealWritesOn } from "../env";
import { activeExecutionConnection } from "../execution/connections";
import {
  ExecutionRefused,
  executeProposal,
  haltState,
  realWritesOffSentence,
} from "../execution/engine";
import type {
  CampaignBackend,
  CampaignCounts,
  CampaignMailOutcome,
  CampaignPlan,
} from "../execution/providers/email-campaign";
import { CAMPAIGN_OP, SLOT, sha256 } from "../execution/providers/email-campaign";
import { executionProvider } from "../execution/providers/index";
import type { ExecutionContext, ExecutionProvider } from "../execution/providers/fixture";
import type { DispatchPlan } from "../execution/due";
import { EXECUTION_SCOPE_REGISTRY } from "../execution/scopes";
import { COUNTRY_KEY } from "../hours/timezone";
import { latestDecision } from "../mode/service";
import { readCurrentField } from "../profile/field-store";
import type { ProposalRow } from "../proposals/service";
import { campaignDraftFor, POSTAL_ADDRESS_KEY } from "./campaign-draft";
import type { ContactRow } from "./contacts";
import { emailHash, normalizeEmail, outboundPosture } from "./contacts";
import { canSendMarketing } from "./jurisdiction";
import type { LawReviewVerdict } from "./law-review";
import { currentLawReview } from "./law-review";
import { SEGMENT_KIND, SEGMENT_MODULE } from "./segment-proposals";
import { computeSegments } from "./segments";

export class CampaignSendError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CampaignSendError";
    this.status = status;
  }
}

/** The codes a recipient can be refused with beyond canSendMarketing's own. */
export type ExecutorRefusal = "contact_gone" | "duplicate_address";

/** A run that died without finishing is picked up after this long (the P3-21d figure). */
export const STALE_RUN_MS = 15 * 60_000;

const STILL_APPROVED = "Nothing was sent; this stays approved.";

/* ── the sender identity ── */

/** SYB's verified sending address: EMAIL_FROM's address part, or Resend's test sender. */
export function sendingAddress(): string {
  const raw = process.env.EMAIL_FROM?.trim() || "Ledgerline <onboarding@resend.dev>";
  return (/<([^<>]+)>\s*$/.exec(raw)?.[1] ?? raw).trim();
}

/** Pure: '"Fernhill Ceramics via Ledgerline" <address>' — their name, our verified address. */
export function campaignFromHeader(senderName: string, address = sendingAddress()): string {
  const name = senderName.replace(/["<>\r\n\\]/g, "").trim() || "A business";
  return `"${name} via Ledgerline" <${address}>`;
}

/* ── is it a campaign ── */

export function isCampaignProposal(p: Pick<ProposalRow, "module" | "action">): boolean {
  return p.module === SEGMENT_MODULE && (p.action as { kind?: unknown })?.kind === SEGMENT_KIND;
}

/** The due runner's route for a campaign (P4-15): one op, the proposal's own id. */
export function campaignPlanFor(
  proposal: Pick<ProposalRow, "id" | "module" | "action">,
): DispatchPlan | null {
  if (!isCampaignProposal(proposal)) return null;
  return { provider: "email_campaign", op: CAMPAIGN_OP, params: { proposal_id: proposal.id } };
}

/** Pure: the proposal's contact ids, as approved — uuid-shaped strings, deduplicated, in order. */
export function approvedRecipients(action: unknown): string[] {
  const ids = (action as { detail?: { contact_ids?: unknown } } | null)?.detail?.contact_ids;
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  for (const id of ids) if (typeof id === "string" && !out.includes(id)) out.push(id);
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function answered(profileId: string, key: string): Promise<string | null> {
  const f = await readCurrentField<string>(profileId, key);
  return f && f.status === "answered" && typeof f.value === "string" && f.value.trim() !== ""
    ? f.value.trim()
    : null;
}

/* ── the gates, in the engine's order, in words ── */

export type GateCode =
  | "stopped"
  | "no_mode_decision"
  | "watching"
  | "labelled_undoable"
  | "real_sends_off"
  | "not_connected"
  | "law_review_missing"
  | "law_review_stale"
  | "outbound_off"
  | "email_not_set_up"
  | "no_draft"
  | "draft_not_approved"
  | "draft_changed"
  | "draft_incomplete";

export interface Gate {
  code: GateCode;
  words: string;
}

export const GATE_WORDS: Readonly<
  Record<Exclude<GateCode, "law_review_missing" | "law_review_stale" | "real_sends_off">, string>
> = {
  stopped: "Everything is stopped (the emergency stop is on). Nothing sends until you resume.",
  no_mode_decision: "There's no decision yet on how I work with your business, so nothing sends.",
  watching: "I'm watching your business, not changing it, so nothing sends until the watch ends.",
  labelled_undoable:
    "This campaign was approved as something that could be undone, and a sent email can't be recalled. Decline it in the queue and propose it again.",
  not_connected: "Campaign email isn't connected. Grant it on Connections first.",
  outbound_off:
    'Your own answer on customer consent was "no consent", so outbound email is off until your data says otherwise.',
  email_not_set_up:
    "Email isn't set up yet: SYB's sending key or its public web address is missing, so there's nowhere for an unsubscribe link to point.",
  no_draft: "There's no email drafted for this campaign yet.",
  draft_not_approved: "You haven't approved the email itself yet.",
  draft_changed:
    "The email changed after you approved it. Approve it again as it is now before it sends.",
  draft_incomplete:
    "The email is missing its unsubscribe slot or its AI disclosure, so it can't be sent as approved.",
};

interface DraftFacts {
  exists: boolean;
  approved: boolean;
  intact: boolean;
  complete: boolean;
}

function draftFacts(draft: typeof contentItems.$inferSelect | null): DraftFacts {
  if (!draft) return { exists: false, approved: false, intact: false, complete: false };
  const approved = draft.approved_at !== null && draft.approved_sha256 !== null;
  return {
    exists: true,
    approved,
    intact: approved && sha256(draft.body) === draft.approved_sha256,
    complete: draft.body.includes(SLOT) && draft.body.includes(draft.disclosure),
  };
}

/** Pure: is the public address usable for unsubscribe links (https only)? */
export function unsubscribeBase(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Gates 6b, the provider's own: connection, law review, posture, set-up, the approved draft. */
async function readinessGates(
  proposal: ProposalRow,
  accountId: string,
  lawReview: () => Promise<LawReviewVerdict>,
): Promise<Gate[]> {
  const gates: Gate[] = [];
  const conn = await activeExecutionConnection(accountId, "email_campaign");
  if (!conn || conn.status !== "connected") {
    gates.push({ code: "not_connected", words: GATE_WORDS.not_connected });
  }
  const review = await lawReview();
  if (review.state !== "current") {
    gates.push({
      code: review.state === "missing" ? "law_review_missing" : "law_review_stale",
      words: review.words,
    });
  }
  if ((await outboundPosture(proposal.profile_id)) === "disabled") {
    gates.push({ code: "outbound_off", words: GATE_WORDS.outbound_off });
  }
  if (!resendApiKey() || unsubscribeBase(appUrl()) === null) {
    gates.push({ code: "email_not_set_up", words: GATE_WORDS.email_not_set_up });
  }
  const d = draftFacts(await campaignDraftFor(proposal.id));
  if (!d.exists) gates.push({ code: "no_draft", words: GATE_WORDS.no_draft });
  else if (!d.approved)
    gates.push({ code: "draft_not_approved", words: GATE_WORDS.draft_not_approved });
  else if (!d.intact) gates.push({ code: "draft_changed", words: GATE_WORDS.draft_changed });
  else if (!d.complete)
    gates.push({ code: "draft_incomplete", words: GATE_WORDS.draft_incomplete });
  return gates;
}

/**
 * Every gate holding a campaign, in the order the engine applies them —
 * the first is the one holding it now. The stop, the watch, the label,
 * the real-send switch, then the provider's own pre-flight.
 */
export async function campaignGates(
  proposal: ProposalRow,
  accountId: string,
  opts: { lawReview?: () => Promise<LawReviewVerdict> } = {},
): Promise<Gate[]> {
  const gates: Gate[] = [];
  if ((await haltState(accountId)).halted)
    gates.push({ code: "stopped", words: GATE_WORDS.stopped });
  const decision = await latestDecision(proposal.profile_id);
  if (!decision) gates.push({ code: "no_mode_decision", words: GATE_WORDS.no_mode_decision });
  else if (decision.mode === "watching")
    gates.push({ code: "watching", words: GATE_WORDS.watching });
  if ((proposal.reversibility as { level?: string } | null)?.level !== "hard") {
    gates.push({ code: "labelled_undoable", words: GATE_WORDS.labelled_undoable });
  }
  if (!sessionDRealWritesOn()) {
    gates.push({
      code: "real_sends_off",
      words: realWritesOffSentence(EXECUTION_SCOPE_REGISTRY.email_campaign.label),
    });
  }
  gates.push(...(await readinessGates(proposal, accountId, opts.lawReview ?? currentLawReview)));
  return gates;
}

/* ── the database backend ── */

async function ownedProposal(
  proposalId: string,
  ctx: ExecutionContext,
): Promise<ProposalRow | null> {
  const [p] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
  if (!p || p.profile_id !== ctx.profile_id || !isCampaignProposal(p)) return null;
  return p;
}

export interface CampaignBackendOptions {
  /** Tests: stand in for the recorded law review (a global fact). */
  lawReview?: () => Promise<LawReviewVerdict>;
  now?: () => Date;
}

export function dbCampaignBackend(opts: CampaignBackendOptions = {}): CampaignBackend {
  const now = opts.now ?? (() => new Date());
  const lawReview = opts.lawReview ?? currentLawReview;
  const readiness = async (proposalId: string, ctx: ExecutionContext): Promise<string | null> => {
    const proposal = await ownedProposal(proposalId, ctx);
    if (!proposal) return "This isn't one of your campaigns. Nothing was sent.";
    const [first] = await readinessGates(proposal, ctx.account_id, lawReview);
    return first ? `${first.words} ${STILL_APPROVED}` : null;
  };

  return {
    readiness,

    async plan(proposalId, ctx) {
      const refused = await readiness(proposalId, ctx);
      if (refused !== null) return { refused };
      const draft = await campaignDraftFor(proposalId);
      const conn = await activeExecutionConnection(ctx.account_id, "email_campaign");
      const key = resendApiKey();
      const base = unsubscribeBase(appUrl());
      if (
        !draft?.approved_sha256 ||
        !draft.approved_subject ||
        !conn?.sender_name ||
        !conn.reply_to ||
        !key ||
        !base
      ) {
        return { refused: `${GATE_WORDS.email_not_set_up} ${STILL_APPROVED}` };
      }
      const address = sendingAddress();
      const plan: CampaignPlan = {
        proposal_id: proposalId,
        api_key: key,
        from: campaignFromHeader(conn.sender_name, address),
        from_address: address,
        sender_name: conn.sender_name,
        reply_to: conn.reply_to,
        subject: draft.approved_subject,
        body: draft.body,
        approved_sha256: draft.approved_sha256,
        disclosure: draft.disclosure,
        base_url: base,
        connection_id: conn.id,
      };
      return plan;
    },

    async materialise(proposalId, executionId, ctx) {
      await db.transaction(async (tx) => {
        // Once per campaign: the first run writes a row per approved contact id,
        // and every later run only ever works through those rows.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`campaign:${proposalId}`}))`);
        const [have] = await tx
          .select({ n: count() })
          .from(campaignSends)
          .where(eq(campaignSends.proposal_id, proposalId));
        if (Number(have?.n ?? 0) > 0) return;
        const [proposal] = await tx.select().from(proposals).where(eq(proposals.id, proposalId));
        if (!proposal) return;
        const ids = approvedRecipients(proposal.action);
        const shaped = ids.filter((id) => UUID_RE.test(id));
        const living = shaped.length
          ? await tx
              .select({ id: contacts.id })
              .from(contacts)
              .where(and(inArray(contacts.id, shaped), eq(contacts.account_id, ctx.account_id)))
          : [];
        const alive = new Set(living.map((r) => r.id));
        const rows = ids.map((id) => {
          const sendId = randomUUID();
          const here = alive.has(id);
          return {
            id: sendId,
            proposal_id: proposalId,
            execution_id: executionId,
            profile_id: ctx.profile_id,
            account_id: ctx.account_id,
            contact_id: here ? id : null,
            status: here ? ("pending" as const) : ("refused" as const),
            refused_reasons: here ? [] : ["contact_gone"],
            idempotency_key: `syb-campaign-${sendId}`,
          };
        });
        if (rows.length > 0) await tx.insert(campaignSends).values(rows);
        // P4-17: the comparison group, as the send begins — the segment's
        // members who are NOT on the approved list. Read once, here, so the
        // readback compares like with like: both groups "since this moment".
        const segment = (proposal.action as { detail?: { segment?: unknown } }).detail?.segment;
        if (typeof segment === "string") {
          const report = await computeSegments(ctx.account_id, now());
          const members = report.segments.find((s) => s.key === segment)?.contact_ids ?? [];
          const approved = new Set(ids);
          const others = members.filter((id) => !approved.has(id));
          if (others.length > 0) {
            await tx
              .insert(campaignComparisons)
              .values(
                others.map((contact_id) => ({
                  proposal_id: proposalId,
                  profile_id: ctx.profile_id,
                  account_id: ctx.account_id,
                  contact_id,
                  snapshot_at: now().toISOString(),
                })),
              )
              .onConflictDoNothing();
          }
        }
      });
    },

    async settleInterrupted(proposalId) {
      const rows = await db
        .update(campaignSends)
        .set({ status: "unknown" })
        .where(and(eq(campaignSends.proposal_id, proposalId), eq(campaignSends.status, "sending")))
        .returning({ id: campaignSends.id });
      return rows.length;
    },

    async pending(proposalId, limit) {
      return db
        .select({
          send_id: campaignSends.id,
          contact_id: campaignSends.contact_id,
          idempotency_key: campaignSends.idempotency_key,
        })
        .from(campaignSends)
        .where(and(eq(campaignSends.proposal_id, proposalId), eq(campaignSends.status, "pending")))
        .orderBy(asc(campaignSends.created_at), asc(campaignSends.id))
        .limit(limit);
    },

    async check(row, plan, message, ctx) {
      if (row.contact_id === null) return { ok: false, codes: ["contact_gone"] };
      const [contact] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, row.contact_id), eq(contacts.account_id, ctx.account_id)));
      if (!contact) return { ok: false, codes: ["contact_gone"] };
      const [country, postal] = await Promise.all([
        answered(ctx.profile_id, COUNTRY_KEY),
        answered(ctx.profile_id, POSTAL_ADDRESS_KEY),
      ]);
      // The message as it will be sent: an address or a disclosure counts only if it is IN the body.
      const verdict = await canSendMarketing({
        contact: contact as ContactRow,
        businessCountry: country,
        message: {
          sender_name: plan.sender_name,
          sender_email: plan.from_address,
          postal_address: postal !== null && message.body.includes(postal) ? postal : null,
          unsubscribe_url: message.unsubscribe_url,
          disclosure: message.body.includes(plan.disclosure) ? plan.disclosure : "",
        },
      });
      if (!verdict.allowed || !contact.email) {
        return { ok: false, codes: verdict.codes.length > 0 ? verdict.codes : ["no_email"] };
      }
      const email = normalizeEmail(contact.email);
      return { ok: true, email, email_hash: emailHash(email) };
    },

    async refuse(sendId, codes) {
      await db
        .update(campaignSends)
        .set({ status: "refused", refused_reasons: codes })
        .where(and(eq(campaignSends.id, sendId), eq(campaignSends.status, "pending")));
    },

    async claim(sendId, c) {
      try {
        const rows = await db
          .update(campaignSends)
          .set({
            status: "sending",
            email_hash: c.email_hash,
            unsubscribe_token_hash: c.token_hash,
            sender_name: c.sender_name,
            body_sha256: c.body_sha256,
            claimed_at: now().toISOString(),
          })
          .where(and(eq(campaignSends.id, sendId), eq(campaignSends.status, "pending")))
          .returning({ id: campaignSends.id });
        return rows.length === 1 ? { claimed: true } : { claimed: false, code: null };
      } catch (error) {
        const constraint = (error as { cause?: { constraint?: string } }).cause?.constraint;
        // The same address already has this campaign: once per address, structurally.
        if (constraint === "campaign_sends_address_idx") {
          return { claimed: false, code: "duplicate_address" };
        }
        throw error;
      }
    },

    async record(sendId, outcome: CampaignMailOutcome) {
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

    async stillConnected(connectionId, ctx) {
      const conn = await activeExecutionConnection(ctx.account_id, "email_campaign");
      return conn !== null && conn.id === connectionId && conn.status === "connected";
    },

    counts: campaignCounts,
  };
}

/** Counts per status and per refusal reason. Pure arithmetic over the rows. */
export async function campaignCounts(proposalId: string): Promise<CampaignCounts> {
  const rows = await db
    .select({ status: campaignSends.status, reasons: campaignSends.refused_reasons })
    .from(campaignSends)
    .where(eq(campaignSends.proposal_id, proposalId));
  return tallyCounts(rows);
}

/** Pure: the tally. A recipient refused for two reasons counts once in `refused`, once per reason. */
export function tallyCounts(
  rows: readonly { status: CampaignSendStatus; reasons: readonly string[] }[],
): CampaignCounts {
  const out: CampaignCounts = {
    pending: 0,
    refused: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
    refused_by_reason: {},
  };
  for (const r of rows) {
    out[r.status] += 1;
    if (r.status === "refused") {
      for (const code of r.reasons)
        out.refused_by_reason[code] = (out.refused_by_reason[code] ?? 0) + 1;
    }
  }
  return out;
}

export type CampaignSendStatus = (typeof campaignSends.$inferSelect)["status"];

/* ── the owner approves the exact email ── */

export function hashCampaignApproval(p: {
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
        kind: "campaign_approval",
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
 * The owner approves THIS email: the body whose sha256 they were shown,
 * under the subject line they typed. Refused when the body changed under
 * them, or when the campaign was approved as undoable (a sent email can't
 * be). Sets the proposal's schedule floor to now when it had none, so the
 * due runner carries a held or refused send on from here.
 */
export async function approveCampaignEmail(args: {
  profileId: string;
  proposalId: string;
  userId: string;
  subject: string;
  bodySha256: string;
  now?: Date;
}): Promise<{ draft_id: string; approved_at: string; fresh: boolean }> {
  const at = (args.now ?? new Date()).toISOString();
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, args.proposalId));
  if (!proposal || proposal.profile_id !== args.profileId || !isCampaignProposal(proposal)) {
    throw new CampaignSendError("no such campaign", 404);
  }
  if (proposal.status !== "approved") {
    throw new CampaignSendError(
      `only an approved campaign is sent — this one is ${proposal.status}`,
      409,
    );
  }
  if ((proposal.reversibility as { level?: string } | null)?.level !== "hard") {
    throw new CampaignSendError(GATE_WORDS.labelled_undoable, 409);
  }
  const subject = args.subject.trim();
  if (subject === "" || subject.length > 200 || /[\r\n]/.test(subject)) {
    throw new CampaignSendError("the subject line must be one line of at most 200 characters", 422);
  }
  const draft = await campaignDraftFor(proposal.id);
  if (!draft) throw new CampaignSendError(GATE_WORDS.no_draft, 409);
  const bodySha = sha256(draft.body);
  if (args.bodySha256.trim().toLowerCase() !== bodySha) {
    throw new CampaignSendError(
      "the email changed since you opened it — read it again as it is now, then approve",
      409,
    );
  }
  if (!draftFacts(draft).complete) throw new CampaignSendError(GATE_WORDS.draft_incomplete, 422);
  if (
    draft.approved_sha256 === bodySha &&
    draft.approved_subject === subject &&
    draft.approved_at
  ) {
    return { draft_id: draft.id, approved_at: draft.approved_at, fresh: false };
  }
  await db.transaction(async (tx) => {
    await tx
      .update(contentItems)
      .set({
        approved_by: args.userId,
        approved_at: at,
        approved_sha256: bodySha,
        approved_subject: subject,
      })
      .where(eq(contentItems.id, draft.id));
    if (proposal.execute_not_before === null) {
      await tx
        .update(proposals)
        .set({ execute_not_before: at })
        .where(and(eq(proposals.id, proposal.id), eq(proposals.status, "approved")));
    }
    await tx.insert(decisionLog).values({
      profile_id: proposal.profile_id,
      actor: "owner",
      kind: "campaign_approval",
      ref_id: proposal.id,
      payload_hash: hashCampaignApproval({
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
      event: "campaign_email_approved",
      account_id: acct?.account_id ?? null,
      proposal_id: proposal.id,
      draft_id: draft.id,
    }),
  );
  return { draft_id: draft.id, approved_at: at, fresh: true };
}

/* ── the send, through the engine ── */

export interface SendNowOutcome {
  /** "sent" = the run finished; "held" = it stopped with recipients left; "refused" = a gate held it. */
  result: "sent" | "held" | "refused" | "failed";
  message: string;
}

/**
 * The owner's "Send now": executeProposal with the campaign provider, so
 * every guard runs. A refusal comes back as the engine's own sentence.
 */
export async function sendCampaignNow(args: {
  profileId: string;
  proposalId: string;
  provider?: ExecutionProvider;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SendNowOutcome> {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, args.proposalId));
  if (!proposal || proposal.profile_id !== args.profileId || !isCampaignProposal(proposal)) {
    throw new CampaignSendError("no such campaign", 404);
  }
  try {
    const run = await executeProposal({
      proposalId: proposal.id,
      provider: args.provider ?? executionProvider("email_campaign"),
      op: CAMPAIGN_OP,
      params: { proposal_id: proposal.id },
      ...(args.sleep ? { sleep: args.sleep } : {}),
    });
    if (run.status === "succeeded") {
      return {
        result: "sent",
        message: "Sent. Every recipient was checked again at the moment it went.",
      };
    }
    return {
      result: run.held_for ? "held" : "failed",
      message: run.error ?? "The send didn't finish.",
    };
  } catch (error) {
    if (error instanceof ExecutionRefused) return { result: "refused", message: error.message };
    throw error;
  }
}

/**
 * A campaign run that died without finishing (the process ended mid-run)
 * sits `running` for ever, and nothing re-selects a running row. After
 * STALE_RUN_MS it is closed as failed, held "remaining", so the due runner
 * sends the rows still pending — and the rows it left `sending` become
 * unknown at the start of that run, never sent again.
 */
export async function reclaimStaleCampaignRuns(now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(executions)
    .set({
      status: "failed",
      held_for: "remaining",
      error:
        "The send stopped without finishing. Anyone not yet emailed goes out on the next run; anyone it may have reached stays unconfirmed and is never emailed again.",
      finished_at: now.toISOString(),
    })
    .where(
      and(
        eq(executions.provider, "email_campaign"),
        eq(executions.status, "running"),
        lt(executions.started_at, new Date(now.getTime() - STALE_RUN_MS).toISOString()),
      ),
    )
    .returning({ id: executions.id, account_id: executions.account_id });
  for (const r of rows) {
    console.log(
      JSON.stringify({
        event: "campaign_run_reclaimed",
        account_id: r.account_id,
        execution_id: r.id,
      }),
    );
  }
  return rows.length;
}

/* ── what /customers shows ── */

export interface CampaignSendView {
  phase: "awaiting_draft" | "awaiting_approval" | "held" | "sending" | "sent";
  /** Every gate holding it, the first one holding it now. Empty while it can go. */
  gates: Gate[];
  counts: CampaignCounts & { unsubscribed: number; total: number };
  approved_at: string | null;
  subject: string | null;
  /** sha256 of the draft's body as it is now — what an approval must name. */
  body_sha256: string | null;
  execution: {
    status: string;
    held_for: string | null;
    error: string | null;
    finished_at: string | null;
  } | null;
}

export async function campaignSendView(
  proposal: ProposalRow,
  accountId: string,
): Promise<CampaignSendView> {
  const draft = await campaignDraftFor(proposal.id);
  const [execution] = await db
    .select()
    .from(executions)
    .where(eq(executions.proposal_id, proposal.id));
  const counts = await campaignCounts(proposal.id);
  const [unsub] = await db
    .select({ n: count() })
    .from(campaignSends)
    .where(
      and(eq(campaignSends.proposal_id, proposal.id), isNotNull(campaignSends.unsubscribed_at)),
    );
  const total =
    counts.pending + counts.refused + counts.sending + counts.sent + counts.failed + counts.unknown;
  const finished = execution?.status === "succeeded" || proposal.status === "executed";
  const gates = finished ? [] : await campaignGates(proposal, accountId);
  const phase: CampaignSendView["phase"] = finished
    ? "sent"
    : !draft
      ? "awaiting_draft"
      : !draft.approved_at
        ? "awaiting_approval"
        : execution && (execution.status === "running" || execution.held_for === "remaining")
          ? "sending"
          : "held";
  return {
    phase,
    gates,
    counts: { ...counts, unsubscribed: Number(unsub?.n ?? 0), total },
    approved_at: draft?.approved_at ?? null,
    subject: draft?.approved_subject ?? null,
    body_sha256: draft ? sha256(draft.body) : null,
    execution: execution
      ? {
          status: execution.status,
          held_for: execution.held_for,
          error: execution.error,
          finished_at: execution.finished_at,
        }
      : null,
  };
}
