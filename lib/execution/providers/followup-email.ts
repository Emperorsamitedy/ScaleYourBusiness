// The deal follow-up sender — P5-16b; rule 29 amended by the owner on
// 2026-11-16 ("make all these automatic all the owner should do is just
// approve"); rules 12, 15, 16, 22, 23.
//
// An approved follow-up whose exact email the owner also approved
// (lib/pipeline/followup-send approveFollowUpEmail) is emailed to the deal's
// one contact, from SYB's own email service under the business's name, with
// replies going to the person who approved it. It is a Phase 3 execution
// provider like the campaign's, so the send runs THROUGH the engine and
// inherits every guard: the stop, the approval, the schedule floor, the
// watch, the registry (one op, send_followup, irreversible and labelled so
// before approval), the idempotency claim and the journal. Its own
// pre-flight (guard 6b, reads only) adds: the email the owner approved is
// still the draft, the deal is still open, outbound is not off, and email is
// set up with a public https address for the unsubscribe link.
//
// Real, or held — the purchase-order pattern. It goes out only when SYB's
// email service is set up on a verified domain AND the real-write gate is on
// (SESSION_D_REAL_WRITES). Otherwise the pre-flight answers `deferred`
// before the claim: no execution row, the proposal stays approved, and the
// due runner sends it on its first pass after sending is switched on.
//
// What goes out is the approved body with three things ScaleX adds, each
// shown on the approval screen: the contact's first name in the {{name}}
// slot, the business's postal address when it is on file, and an
// unsubscribe line with the recipient's own link (RFC 8058 headers ride
// along). The AI disclosure is already in the approved body (P3-19).
//
// At most once, stated honestly. The send is ONE campaign_sends row on the
// follow-up's proposal (idempotency key syb-followup-<proposal>), so the
// unsubscribe page, one-click unsubscribe and the email service's delivery,
// bounce and complaint events work exactly as for a campaign. The contact is
// read again and run through canSendMarketing at the moment of the send
// (rule 23). A row left sending, or unknown, is never sent again.
//
// This file holds no database import (the provider map stays importable
// without one): the reads live behind FollowUpBackend
// (lib/pipeline/followup-send.ts), loaded on first use. The one network call
// is sendCampaignEmail, called once, inside execute, after the stop, the
// consent check and the claim — pinned by email-campaign.test.ts's gate.

import type { NotSentReason, SendingMode } from "../../purchasing/po";
import { sendingMode } from "../../purchasing/po";
import type { CampaignMailOutcome, MailFetch } from "./email-campaign";
import { newUnsubscribeToken, sendCampaignEmail, sha256, unsubscribeUrls } from "./email-campaign";
import type { ExecutionContext, ExecutionProvider, HeldFor, PreflightRefusal } from "./fixture";

export const FOLLOWUP_PROVIDER = "followup_email";
export const FOLLOWUP_OP = "send_followup";
/** The greeting slot a follow-up draft carries (lib/pipeline/followups NAME_SLOT). */
export const FOLLOWUP_NAME_SLOT = "{{name}}";

/** The start of the pre-flight's sentence while sending is off. */
export const FOLLOWUP_HELD = "Waiting for email to be switched on.";

/** The start of the sentence for a send nobody could confirm: never sent again. */
export const FOLLOWUP_UNCONFIRMED =
  "I may have sent this follow-up: the email service didn't confirm it either way.";

const HELD_WHY: Record<NotSentReason, string> = {
  email_not_set_up: "Email isn't set up on ScaleX's sending domain yet.",
  real_writes_off: "Real sending is switched off until the two-week unattended test completes.",
};

/** Pure: the owner's sentence for a held follow-up, every reason named. */
export function followUpHeldSentence(reasons: readonly NotSentReason[]): string {
  return [
    FOLLOWUP_HELD,
    ...reasons.map((r) => HELD_WHY[r]),
    "Nothing was sent: it stays approved and goes out on the first run after sending is switched on.",
  ].join(" ");
}

/**
 * Whether a follow-up can really go out, from the environment: the purchase
 * order's rule, with the campaign sending address (CAMPAIGN_EMAIL_FROM)
 * preferred over the sign-in one, since a follow-up is outbound mail.
 */
export function followUpSendingMode(
  env: Readonly<Record<string, string | undefined>>,
): SendingMode {
  const campaign = env.CAMPAIGN_EMAIL_FROM?.trim();
  return sendingMode(campaign ? { ...env, EMAIL_FROM: campaign } : env);
}

/* ── what the backend answers ── */

export interface FollowUpPlan {
  proposal_id: string;
  /** '"<name> via ScaleX" <address>'. */
  from: string;
  /** The bare sending address, for the consent check's sender identity. */
  from_address: string;
  sender_name: string;
  /** The approver's own address. */
  reply_to: string;
  subject: string;
  /** The approved body, {{name}} slot included, disclosure included. */
  body: string;
  /** The AI disclosure the approved body carries, for the consent check's completeness test. */
  disclosure: string;
  /** The business's postal address when it is on file, added under the body. */
  postal_address: string | null;
  /** https origin for the unsubscribe page and the one-click endpoint. */
  base_url: string;
}

export type FollowUpCheck =
  | { ok: true; contact_id: string; email: string; email_hash: string; name: string | null }
  | { ok: false; codes: string[]; words: string };

export type FollowUpPrior = { send_id: string; status: string } | null;

export interface FollowUpBackend {
  /** Guard 6b: null = ready; otherwise the owner's sentence. Reads only. */
  readiness(proposalId: string, ctx: ExecutionContext): Promise<string | null>;
  plan(proposalId: string, ctx: ExecutionContext): Promise<FollowUpPlan | { refused: string }>;
  /** The follow-up's one send row, if a run already made it. */
  prior(proposalId: string): Promise<FollowUpPrior>;
  /** A row a dead run left `sending` → `unknown`. Never back to pending. */
  settleInterrupted(proposalId: string): Promise<void>;
  /** The contact, read again NOW, through canSendMarketing with this exact message. */
  check(
    proposalId: string,
    plan: FollowUpPlan,
    message: { unsubscribe_url: string; body: string },
    ctx: ExecutionContext,
  ): Promise<FollowUpCheck>;
  /** Record a refusal on the follow-up's row (codes only). */
  refuse(
    proposalId: string,
    contactId: string | null,
    codes: string[],
    ctx: ExecutionContext,
  ): Promise<void>;
  /** The row, pending → sending, conditionally. Null = another run holds it. */
  claim(
    proposalId: string,
    claim: {
      contact_id: string;
      email_hash: string;
      token_hash: string;
      sender_name: string;
      body_sha256: string;
    },
    ctx: ExecutionContext,
  ): Promise<{ send_id: string; idempotency_key: string } | null>;
  record(sendId: string, outcome: CampaignMailOutcome): Promise<void>;
  /** sending → pending: the service refused SYB itself before doing anything. */
  release(sendId: string): Promise<void>;
}

/* ── pure helpers ── */

/** The Resend Idempotency-Key and the row's key: one per follow-up. */
export function followUpIdempotencyKey(proposalId: string): string {
  return `syb-followup-${proposalId}`;
}

/** Pure: the approved draft's {{name}} slot filled from the contact's first name. */
export function fillFollowUpName(body: string, name: string | null): string {
  const first = name?.trim().split(/\s+/)[0] ?? "";
  return body.split(FOLLOWUP_NAME_SLOT).join(first === "" ? "there" : first);
}

/**
 * Pure: the email as it goes out — the approved body with the name filled,
 * then what ScaleX adds: the postal address when on file, and the
 * unsubscribe line. Nothing else changes, and the caller's check proves it.
 */
export function composeFollowUp(args: {
  body: string;
  name: string | null;
  postal_address: string | null;
  unsubscribe_url: string;
}): string {
  return [
    fillFollowUpName(args.body, args.name).trimEnd(),
    ...(args.postal_address ? [args.postal_address] : []),
    `If you'd rather not get emails like this, unsubscribe here: ${args.unsubscribe_url}`,
  ].join("\n\n");
}

/* ── errors the engine reads ── */

/** A run that ends, never retried in-run: another attempt could only repeat it, or send twice. */
export class FollowUpRefused extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "FollowUpRefused";
  }
}

/** The stop came on, or the service refused SYB itself: held, nothing sent. */
export class FollowUpHold extends Error {
  readonly retryable = false;
  readonly held_for: HeldFor;
  constructor(held: HeldFor, message: string) {
    super(message);
    this.name = "FollowUpHold";
    this.held_for = held;
  }
}

export interface FollowUpResult {
  sent: true;
  send_id: string;
  provider_id: string | null;
  /** True when an earlier run had already sent it and this one sent nothing. */
  already: boolean;
}

/* ── the provider ── */

export interface FollowUpOptions {
  fetch?: MailFetch;
  backend?: FollowUpBackend;
  /** Tests: the environment reading in place of process.env. */
  mode?: () => SendingMode;
}

const SERVICE_LEVEL_REFUSAL = new Set([401, 403, 429]);

export function createFollowUpExecutor(options: FollowUpOptions = {}): ExecutionProvider {
  const fetchImpl: MailFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const mode = options.mode ?? (() => followUpSendingMode(process.env));
  const loadBackend = async (): Promise<FollowUpBackend> => {
    if (options.backend) return options.backend;
    const { dbFollowUpBackend } = await import("../../pipeline/followup-send");
    return dbFollowUpBackend();
  };
  const proposalOf = (op: string, params: Record<string, unknown>): string => {
    if (op !== FOLLOWUP_OP) throw new FollowUpRefused(`a follow-up has no "${op}" operation`);
    const id = params.proposal_id;
    if (typeof id !== "string" || id === "") {
      throw new FollowUpRefused("the send names no follow-up");
    }
    return id;
  };

  return {
    id: FOLLOWUP_PROVIDER,
    // Real only when it can really go out — which needs the real-write gate
    // on — so guard 6a and this provider read the same switch.
    get external() {
      return mode().mode === "real";
    },

    async preflight(op, params, ctx): Promise<PreflightRefusal | null> {
      const proposalId = proposalOf(op, params);
      const now = mode();
      if (now.mode === "fake")
        return { code: "deferred", message: followUpHeldSentence(now.reasons) };
      const refusal = await (await loadBackend()).readiness(proposalId, ctx);
      return refusal === null ? null : { code: "refused", message: refusal };
    },

    // Irreversible: the engine never asks (the op is registered reversible: false).
    async captureUndo() {
      return null;
    },

    async execute(op, params, ctx): Promise<FollowUpResult> {
      const proposalId = proposalOf(op, params);
      if (!ctx.execution_id) {
        throw new FollowUpRefused("a follow-up goes out only inside an engine run");
      }
      const now = mode();
      if (now.mode === "fake") {
        throw new FollowUpRefused(
          "Sending was switched off just as this follow-up was about to go. Nothing was sent.",
        );
      }
      const b = await loadBackend();
      const plan = await b.plan(proposalId, ctx);
      if ("refused" in plan) throw new FollowUpRefused(plan.refused);

      await b.settleInterrupted(proposalId);
      const prior = await b.prior(proposalId);
      if (prior?.status === "sent") {
        return { sent: true, send_id: prior.send_id, provider_id: null, already: true };
      }
      if (prior && (prior.status === "sending" || prior.status === "unknown")) {
        throw new FollowUpRefused(
          `${FOLLOWUP_UNCONFIRMED} ScaleX won't send it again: check your sent mail, or ask them.`,
        );
      }
      if (prior && prior.status !== "pending") {
        throw new FollowUpRefused(
          "This follow-up was refused earlier and isn't sent. Nothing was sent.",
        );
      }

      // The stop, right before the send (rule 15).
      if (ctx.halted && (await ctx.halted())) {
        throw new FollowUpHold(
          "stop",
          "The emergency stop came on before the follow-up went out. Nothing was sent; it goes out after you resume.",
        );
      }

      const token = newUnsubscribeToken();
      const urls = unsubscribeUrls(plan.base_url, token);
      // The name is filled after the consent check, from the same contact read.
      const probe = composeFollowUp({
        body: plan.body,
        name: null,
        postal_address: plan.postal_address,
        unsubscribe_url: urls.page,
      });
      const verdict = await b.check(
        proposalId,
        plan,
        { unsubscribe_url: urls.page, body: probe },
        ctx,
      );
      if (!verdict.ok) {
        await b.refuse(proposalId, null, verdict.codes, ctx);
        logSend(ctx, proposalId, "refused", { codes: verdict.codes });
        throw new FollowUpRefused(`Not sent: ${verdict.words}. Nothing went out.`);
      }
      const text = composeFollowUp({
        body: plan.body,
        name: verdict.name,
        postal_address: plan.postal_address,
        unsubscribe_url: urls.page,
      });
      const claim = await b.claim(
        proposalId,
        {
          contact_id: verdict.contact_id,
          email_hash: verdict.email_hash,
          token_hash: sha256(token),
          sender_name: plan.sender_name,
          body_sha256: sha256(text),
        },
        ctx,
      );
      if (claim === null) {
        throw new FollowUpRefused(
          `${FOLLOWUP_UNCONFIRMED} Another run already holds it, so this one sent nothing.`,
        );
      }
      const outcome = await sendCampaignEmail(
        {
          from: plan.from,
          to: verdict.email,
          reply_to: plan.reply_to,
          subject: plan.subject,
          text,
          one_click_url: urls.one_click,
          idempotency_key: claim.idempotency_key,
          send_id: claim.send_id,
        },
        now.api_key,
        fetchImpl,
      );
      if (outcome.kind === "refused" && SERVICE_LEVEL_REFUSAL.has(outcome.status)) {
        await b.release(claim.send_id);
        logSend(ctx, proposalId, "service_refused", { status: outcome.status });
        throw new FollowUpHold(
          "remaining",
          outcome.status === 429
            ? "The email service asked ScaleX to slow down. Nothing was sent; it goes out on the next run."
            : "The email service refused ScaleX's own sending key. Nothing was sent; it goes out once ScaleX has fixed it.",
        );
      }
      await b.record(claim.send_id, outcome);
      logSend(ctx, proposalId, outcome.kind, {
        ...(outcome.kind === "refused" ? { status: outcome.status } : {}),
      });
      if (outcome.kind === "sent") {
        return {
          sent: true,
          send_id: claim.send_id,
          provider_id: outcome.provider_id,
          already: false,
        };
      }
      if (outcome.kind === "refused") {
        throw new FollowUpRefused(
          `The email service refused the follow-up (it answered ${outcome.status}). Nothing went out.`,
        );
      }
      throw new FollowUpRefused(
        `${FOLLOWUP_UNCONFIRMED} ScaleX won't send it again: check your sent mail, or ask them.`,
      );
    },

    async undo() {
      throw new FollowUpRefused(
        "A sent email can't be recalled. There is no undo for a follow-up.",
      );
    },
  };
}

function logSend(
  ctx: ExecutionContext,
  proposalId: string,
  outcome: string,
  extra: Record<string, unknown>,
): void {
  // Ids and codes only — never an address, a name or a body (rule 22).
  console.log(
    JSON.stringify({
      event: "followup_send",
      account_id: ctx.account_id,
      execution_id: ctx.execution_id ?? null,
      attempt: ctx.attempt ?? null,
      proposal_id: proposalId,
      outcome,
      ...extra,
    }),
  );
}

export const followUpExecutor = createFollowUpExecutor();
