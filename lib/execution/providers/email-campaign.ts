// The campaign send executor — P4-15 (Phase 4 Session F), rules 12, 15, 16, 17, 22, 23.
//
// A Phase 3 execution provider like Meta's, so the send runs THROUGH the
// engine and inherits every guard before a single address is read: the
// approval, the schedule floor, the watch, the registry, reversibility
// honesty (this op is irreversible and must have been labelled so before
// approval), the real-write gate 6a (`external`), the emergency stop, and
// the idempotency claim. On top of those, its own pre-flight (guard 6b,
// reads only, nothing claimed): the campaign-email consent is on record,
// the law review covers the jurisdiction table as it is now, the owner
// approved the exact email and it hasn't changed since, and SYB's email
// service is set up with a public https address for unsubscribe links.
//
// Then, per recipient, AT THE MOMENT OF THEIR SEND (rule 23): the contact
// is read again from the proposal's ids and run through canSendMarketing —
// consent, suppression, the business's regime and theirs, and the message
// as it will actually be sent. A refusal is a code on the recipient's row;
// nothing is sent to them and nothing personal is logged.
//
// What goes out is the approved body with ONE thing changed: the
// {{unsubscribe_url}} slot, filled with that recipient's own link — and
// the provider proves it, by putting the slot back and comparing with the
// approved text, before anything is sent. RFC 8058 headers ride along
// (List-Unsubscribe + List-Unsubscribe-Post: One-Click).
//
// At most once, per recipient, stated honestly:
//   - a row is claimed pending → sending before the call (the backend's
//     conditional update; a UNIQUE index per address backs it);
//   - Resend gets a per-recipient Idempotency-Key;
//   - an answer that isn't a clear yes or a clear no is `unknown`, and an
//     unknown row is NEVER sent again by any run — it stays unknown and the
//     owner's screen says so. A row left `sending` by a run that died is
//     settled to unknown at the start of the next one.
//   - after an unknown, the run stops (held "remaining"): if the service is
//     failing, one recipient is uncertain, not the whole list.
//
// Pace and cap: at most CAMPAIGN_RUN_CAP recipients per run, CAMPAIGN_PACE_MS
// apart. A run that reaches the cap with recipients left ends held
// "remaining", and the due runner's next pass re-runs it through every
// guard — sending only the rows still pending. The emergency stop is
// checked before every single send (ctx.halted), and a stop holds the run
// for the resume with nothing further sent.
//
// This file holds no database import (the provider map stays importable
// without one): state lives behind CampaignBackend (lib/crm/campaign-send.ts),
// loaded on first use. It is one of the files allowed to POST to Resend's
// send endpoint, and sendCampaignEmail is called from exactly one place,
// the per-recipient loop below — both pinned by source-scan build gates.

import { createHash, randomBytes } from "node:crypto";
import type { ExecutionContext, ExecutionProvider, HeldFor, PreflightRefusal } from "./fixture";

export const CAMPAIGN_OP = "send_campaign";
/** The slot the draft carries (lib/crm/campaign-draft.ts UNSUBSCRIBE_SLOT), filled per recipient. */
export const SLOT = "{{unsubscribe_url}}";
/** Recipients per run. A bigger campaign carries on in the next run (held "remaining"). */
export const CAMPAIGN_RUN_CAP = 50;
/** Between two sends. Resend's default limit is 2 requests a second (verify at build). */
export const CAMPAIGN_PACE_MS = 600;

const RESEND_SEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 20_000;

/* ── what the backend answers ── */

/** Everything a run needs, read fresh at the start of every attempt. */
export interface CampaignPlan {
  proposal_id: string;
  /** SYB's own Resend key. Never the owner's; never logged. */
  api_key: string;
  /** '"<name> via Ledgerline" <address>' — SYB's verified sending address. */
  from: string;
  /** The bare sending address, for the sender-identity check. */
  from_address: string;
  sender_name: string;
  reply_to: string;
  subject: string;
  /** The approved body, slot included. */
  body: string;
  approved_sha256: string;
  disclosure: string;
  /** https origin for the unsubscribe page and the one-click endpoint. */
  base_url: string;
}

export interface PendingRecipient {
  send_id: string;
  contact_id: string | null;
  idempotency_key: string;
}

export type RecipientCheck =
  { ok: true; email: string; email_hash: string } | { ok: false; codes: string[] };

export type CampaignMailOutcome =
  | { kind: "sent"; provider_id: string }
  | { kind: "refused"; status: number }
  | { kind: "unknown"; why: string };

export interface CampaignCounts {
  pending: number;
  refused: number;
  sending: number;
  sent: number;
  failed: number;
  unknown: number;
  refused_by_reason: Record<string, number>;
}

export interface CampaignBackend {
  /** Guard 6b: null = ready; otherwise the owner's sentence. Reads only. */
  readiness(proposalId: string, ctx: ExecutionContext): Promise<string | null>;
  /** The run's plan, or the readiness sentence again if something changed since. */
  plan(proposalId: string, ctx: ExecutionContext): Promise<CampaignPlan | { refused: string }>;
  /** One row per contact id on the approved proposal; idempotent. */
  materialise(proposalId: string, executionId: string, ctx: ExecutionContext): Promise<void>;
  /** Rows a dead run left `sending` → `unknown`. Never back to pending. */
  settleInterrupted(proposalId: string): Promise<number>;
  pending(proposalId: string, limit: number): Promise<PendingRecipient[]>;
  /** The contact, read again NOW, through canSendMarketing with this exact message. */
  check(
    row: PendingRecipient,
    plan: CampaignPlan,
    message: { unsubscribe_url: string; body: string },
    ctx: ExecutionContext,
  ): Promise<RecipientCheck>;
  refuse(sendId: string, codes: string[]): Promise<void>;
  /** pending → sending, conditionally. False = lost (already claimed, or the address already had this campaign). */
  claim(
    sendId: string,
    claim: { email_hash: string; token_hash: string; sender_name: string; body_sha256: string },
  ): Promise<{ claimed: true } | { claimed: false; code: string | null }>;
  record(sendId: string, outcome: CampaignMailOutcome): Promise<void>;
  /** sending → pending: the service refused before doing anything, for every recipient alike. */
  release(sendId: string): Promise<void>;
  counts(proposalId: string): Promise<CampaignCounts>;
}

/* ── the one way out ── */

export interface CampaignMail {
  from: string;
  to: string;
  reply_to: string;
  subject: string;
  text: string;
  /** RFC 8058: the one-click POST endpoint. */
  one_click_url: string;
  idempotency_key: string;
}

export type MailFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * POST one campaign email to Resend, on SYB's own account. Three outcomes,
 * as the support mailer sorts them: 2xx with an id = sent; a 5xx, a 409
 * (idempotency conflict), a timeout or an unreadable 2xx = unknown; any
 * other 4xx = refused, nothing went out. The refusal keeps the status
 * only — Resend's message can quote the address.
 */
export async function sendCampaignEmail(
  mail: CampaignMail,
  apiKey: string,
  fetchImpl: MailFetch,
): Promise<CampaignMailOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(RESEND_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": mail.idempotency_key,
      },
      body: JSON.stringify({
        from: mail.from,
        to: [mail.to],
        reply_to: mail.reply_to,
        subject: mail.subject,
        text: mail.text,
        headers: {
          "List-Unsubscribe": `<${mail.one_click_url}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "unknown", why: error instanceof Error ? error.name : "network" };
  }
  if (res.ok) {
    try {
      const body = (await res.json()) as { id?: unknown };
      if (typeof body.id === "string" && body.id !== "") {
        return { kind: "sent", provider_id: body.id };
      }
    } catch {
      /* fall through */
    }
    return { kind: "unknown", why: `Resend answered ${res.status} without an id` };
  }
  if (res.status >= 500 || res.status === 409) {
    return { kind: "unknown", why: `Resend answered ${res.status}` };
  }
  return { kind: "refused", status: res.status };
}

/* ── errors the engine reads ── */

/** A run that must wait rather than end (engine: failed + held_for). Never retried in-run. */
export class CampaignHold extends Error {
  readonly held_for: HeldFor;
  readonly retryable = false;
  constructor(held: HeldFor, message: string) {
    super(message);
    this.name = "CampaignHold";
    this.held_for = held;
  }
}

/** A run refused outright (the plan changed since the pre-flight). Final. */
export class CampaignRefused extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "CampaignRefused";
  }
}

/* ── pure helpers ── */

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A per-recipient unsubscribe token: 32 random bytes, url-safe. Only its hash is stored. */
export function newUnsubscribeToken(): string {
  return randomBytes(32).toString("base64url");
}

export function unsubscribeUrls(
  baseUrl: string,
  token: string,
): { page: string; one_click: string } {
  const base = baseUrl.replace(/\/+$/, "");
  return { page: `${base}/u/${token}`, one_click: `${base}/api/u/${token}` };
}

/**
 * Pure: the approved body with the slot filled — and proof that nothing
 * else changed. Null = the body can't be sent as approved (no slot, or the
 * fill would alter something besides the slot).
 */
export function fillSlot(approved: string, url: string): string | null {
  if (!approved.includes(SLOT) || approved.includes(url)) return null;
  const sent = approved.split(SLOT).join(url);
  return sent.split(url).join(SLOT) === approved ? sent : null;
}

/* ── the provider ── */

export interface EmailCampaignOptions {
  fetch?: MailFetch;
  sleep?: (ms: number) => Promise<void>;
  backend?: CampaignBackend;
  /** Tests: a smaller per-run cap, to prove a run resumes with only the unsent. */
  runCap?: number;
}

const SERVICE_LEVEL_REFUSAL = new Set([401, 403, 429]);

export function createEmailCampaignExecutor(options: EmailCampaignOptions = {}): ExecutionProvider {
  const fetchImpl: MailFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const loadBackend = async (): Promise<CampaignBackend> => {
    if (options.backend) return options.backend;
    // The database side lives in lib/crm; loaded on first use so the provider
    // map stays importable without a database.
    const { dbCampaignBackend } = await import("../../crm/campaign-send");
    return dbCampaignBackend();
  };
  const proposalOf = (op: string, params: Record<string, unknown>): string => {
    if (op !== CAMPAIGN_OP) throw new CampaignRefused(`campaign email has no "${op}" operation`);
    const id = params.proposal_id;
    if (typeof id !== "string" || id === "") {
      throw new CampaignRefused("the send names no campaign");
    }
    return id;
  };

  return {
    id: "email_campaign",
    external: true,

    async preflight(op, params, ctx): Promise<PreflightRefusal | null> {
      const proposalId = proposalOf(op, params);
      const refusal = await (await loadBackend()).readiness(proposalId, ctx);
      return refusal === null ? null : { code: "refused", message: refusal };
    },

    // Irreversible: the engine never asks (the op is registered reversible: false).
    async captureUndo() {
      return null;
    },

    async execute(op, params, ctx) {
      const proposalId = proposalOf(op, params);
      if (!ctx.execution_id)
        throw new CampaignRefused("a campaign sends only inside an engine run");
      const b = await loadBackend();
      const plan = await b.plan(proposalId, ctx);
      if ("refused" in plan) throw new CampaignRefused(plan.refused);

      await b.materialise(proposalId, ctx.execution_id, ctx);
      const settled = await b.settleInterrupted(proposalId);
      const batch = await b.pending(proposalId, options.runCap ?? CAMPAIGN_RUN_CAP);
      let sentThisRun = 0;
      let pace = false;

      for (const row of batch) {
        // Paced between sends, never between a claim and its send.
        if (pace) await sleep(CAMPAIGN_PACE_MS);
        pace = false;
        // The stop, before every single send (rule 15, P3-24c).
        if (ctx.halted && (await ctx.halted())) {
          throw new CampaignHold(
            "stop",
            "The emergency stop came on mid-send. Nobody else was emailed; the rest go out after you resume.",
          );
        }
        const token = newUnsubscribeToken();
        const urls = unsubscribeUrls(plan.base_url, token);
        const body = fillSlot(plan.body, urls.page);
        if (body === null) {
          throw new CampaignRefused(
            "The email can't be sent exactly as you approved it (its unsubscribe slot is missing or altered). Nothing more was sent.",
          );
        }
        const verdict = await b.check(row, plan, { unsubscribe_url: urls.page, body }, ctx);
        if (!verdict.ok) {
          await b.refuse(row.send_id, verdict.codes);
          logSend(ctx, row.send_id, "refused", { codes: verdict.codes });
          continue;
        }
        const claim = await b.claim(row.send_id, {
          email_hash: verdict.email_hash,
          token_hash: sha256(token),
          sender_name: plan.sender_name,
          body_sha256: sha256(body),
        });
        if (!claim.claimed) {
          if (claim.code) {
            await b.refuse(row.send_id, [claim.code]);
            logSend(ctx, row.send_id, "refused", { codes: [claim.code] });
          }
          continue;
        }
        pace = true;
        const outcome = await sendCampaignEmail(
          {
            from: plan.from,
            to: verdict.email,
            reply_to: plan.reply_to,
            subject: plan.subject,
            text: body,
            one_click_url: urls.one_click,
            idempotency_key: row.idempotency_key,
          },
          plan.api_key,
          fetchImpl,
        );
        if (outcome.kind === "refused" && SERVICE_LEVEL_REFUSAL.has(outcome.status)) {
          // The service refused SYB itself (its key, or its rate): nothing went
          // out to this recipient, and nothing would to the next. Back to pending.
          await b.release(row.send_id);
          logSend(ctx, row.send_id, "service_refused", { status: outcome.status });
          throw new CampaignHold(
            "remaining",
            outcome.status === 429
              ? "The email service asked SYB to slow down. Nothing more was sent; the rest go out on the next run."
              : "The email service refused SYB's own sending key. Nothing more was sent; the rest go out once SYB has fixed it.",
          );
        }
        await b.record(row.send_id, outcome);
        logSend(ctx, row.send_id, outcome.kind, {
          ...(outcome.kind === "refused" ? { status: outcome.status } : {}),
        });
        if (outcome.kind === "sent") sentThisRun += 1;
        if (outcome.kind === "unknown") {
          throw new CampaignHold(
            "remaining",
            "The email service didn't confirm one email either way, so I stopped there: that one stays unconfirmed and is never sent again, and the rest go out on the next run.",
          );
        }
      }

      const counts = await b.counts(proposalId);
      if (counts.pending > 0) {
        throw new CampaignHold(
          "remaining",
          `Sent ${sentThisRun} this run. ${counts.pending} still to go, on the next run.`,
        );
      }
      return { ...counts, settled_unknown: settled, sent_this_run: sentThisRun };
    },

    async undo() {
      throw new CampaignRefused("A sent email can't be recalled. There is no undo for a campaign.");
    },
  };
}

function logSend(
  ctx: ExecutionContext,
  sendId: string,
  outcome: string,
  extra: Record<string, unknown>,
): void {
  // Ids and codes only — never an address, a name or a body (rule 22).
  console.log(
    JSON.stringify({
      event: "campaign_send",
      account_id: ctx.account_id,
      execution_id: ctx.execution_id ?? null,
      attempt: ctx.attempt ?? null,
      send_id: sendId,
      outcome,
      ...extra,
    }),
  );
}

export const emailCampaignExecutor = createEmailCampaignExecutor();
