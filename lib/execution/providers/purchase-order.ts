// The purchase-order sender — P6-04 (Phase 6), rule 27 amended, rules 12, 15, 16, 34.
//
// "A purchase order goes out only on a recorded yes." An approved purchase
// order is emailed to the supplier's address, as approved, from SYB's
// verified sending address under the business's name, with replies going to
// the person who approved it. It is a Phase 3 execution provider like the
// campaign's, so the send runs THROUGH the engine and inherits every guard
// before anything is read: the emergency stop, the approval, the schedule
// floor, the watch, the registry (one op, send_purchase_order, irreversible
// and labelled so before approval), the idempotency claim and the journal.
// On top of those, its own pre-flight (guard 6b, reads only, nothing
// claimed): the approval is on the decision log, the order is the one the
// owner approved (its fingerprint), and an earlier send that nobody could
// confirm is never repeated.
//
// Real or fake. The order goes out for real only when SYB's email service is
// set up on a verified domain AND the real-write gate is on
// (SESSION_D_REAL_WRITES); lib/purchasing/po's sendingMode decides, read at
// the moment of sending. `external` follows the same reading, so with the
// gate off the engine's guard 6a never sees a real sender. Otherwise the run
// goes through the fake sender: every guard, the claim and the journal run
// exactly as for real, nothing leaves SYB, and the result says it was not
// sent and why, so the screen can say "ready, not sent" in words.
//
// What SYB never does, and nothing here could: edit, cancel or pay an order,
// or sign in to a supplier's system. The one network call is a POST to
// Resend's send endpoint, made from one place (sendPurchaseOrderEmail, called
// once, inside execute, after the stop is checked) — pinned by
// lib/purchasing/rule27.test.ts.
//
// This file holds no database import (the provider map stays importable
// without one): the reads live behind PurchaseOrderBackend
// (lib/purchasing/send.ts), loaded on first use.

import type { NotSentReason, PoEmail, PurchaseOrder, SendingMode } from "../../purchasing/po";
import { PO_OP, poFromHeader, sendingMode } from "../../purchasing/po";
import type { ExecutionContext, ExecutionProvider, PreflightRefusal } from "./fixture";

const RESEND_SEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 20_000;

/**
 * Rule 34: an email out is a cost line, tagged by workload. Resend bills SYB
 * per plan, not per email; on its Pro plan (50 000 emails for $20 a month)
 * one email is about €0.0004. Pinned and ASSUMED, as every price list is.
 */
export const PO_EMAIL_WORKLOAD = "purchase_order_email";
export const PO_EMAIL_COST_EUR = 0.0004;

/**
 * The start of the sentence a send nobody could confirm ends with. The
 * pre-flight reads it back: such an order is never sent a second time.
 */
export const PO_UNCONFIRMED = "The email service didn't confirm whether this order went out.";

/* ── what the backend answers ── */

export interface PurchaseOrderPlan {
  proposal_id: string;
  po: PurchaseOrder;
  po_sha256: string;
  /** The supplier's address, exactly as approved. */
  to: string;
  /** The approver's own address, for the supplier's reply. Null = none on file. */
  reply_to: string | null;
  /** The email, in the business's language. */
  email: PoEmail;
}

export interface PurchaseOrderBackend {
  /** Guard 6b: null = ready; otherwise the owner's sentence. Reads only. */
  readiness(proposalId: string, ctx: ExecutionContext): Promise<string | null>;
  /** The run's plan, or the readiness sentence again if something changed since. */
  plan(proposalId: string, ctx: ExecutionContext): Promise<PurchaseOrderPlan | { refused: string }>;
}

/* ── the one way out ── */

export interface PurchaseOrderMail {
  from: string;
  to: string;
  reply_to: string | null;
  subject: string;
  text: string;
  html: string;
  idempotency_key: string;
}

export type PoMailOutcome =
  | { kind: "sent"; provider_id: string }
  | { kind: "refused"; status: number }
  | { kind: "unknown"; why: string };

export type PoMailFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * POST one purchase order to Resend, on SYB's own account. Sorted as every
 * SYB mailer sorts: 2xx with an id = sent; a 5xx, a 409, a timeout or an
 * unreadable 2xx = unknown (it may have gone out); any other 4xx = refused,
 * nothing went out. The refusal keeps the status only.
 */
export async function sendPurchaseOrderEmail(
  mail: PurchaseOrderMail,
  apiKey: string,
  fetchImpl: PoMailFetch,
): Promise<PoMailOutcome> {
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
        ...(mail.reply_to ? { reply_to: mail.reply_to } : {}),
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
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

/** A run that ends, never retried in-run: another attempt could only repeat it, or send twice. */
export class PurchaseOrderRefused extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "PurchaseOrderRefused";
  }
}

/** The stop came on before the send: held for the resume, nothing sent. */
export class PurchaseOrderHold extends Error {
  readonly held_for = "stop" as const;
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "PurchaseOrderHold";
  }
}

/** What an execution of this provider returns, journaled as the result. */
export type PurchaseOrderResult =
  | {
      sent: true;
      number: string;
      provider_id: string;
      to_domain: string;
      po_sha256: string;
    }
  | {
      sent: false;
      number: string;
      not_sent: NotSentReason[];
      to_domain: string;
      po_sha256: string;
    };

/* ── the provider ── */

export interface PurchaseOrderOptions {
  fetch?: PoMailFetch;
  backend?: PurchaseOrderBackend;
  /** Tests: the environment reading in place of process.env. */
  mode?: () => SendingMode;
}

const domainOf = (address: string) => address.split("@")[1] ?? "";

export function createPurchaseOrderExecutor(options: PurchaseOrderOptions = {}): ExecutionProvider {
  const fetchImpl: PoMailFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const mode = options.mode ?? (() => sendingMode(process.env));
  const loadBackend = async (): Promise<PurchaseOrderBackend> => {
    if (options.backend) return options.backend;
    const { dbPurchaseOrderBackend } = await import("../../purchasing/send");
    return dbPurchaseOrderBackend();
  };
  const proposalOf = (op: string, params: Record<string, unknown>): string => {
    if (op !== PO_OP) throw new PurchaseOrderRefused(`a purchase order has no "${op}" operation`);
    const id = params.proposal_id;
    if (typeof id !== "string" || id === "") {
      throw new PurchaseOrderRefused("the send names no purchase order");
    }
    return id;
  };

  return {
    id: "purchase_order",
    // Real only when it can really go out — which needs the real-write gate
    // on — so guard 6a and this provider read the same switch.
    get external() {
      return mode().mode === "real";
    },

    async preflight(op, params, ctx): Promise<PreflightRefusal | null> {
      const proposalId = proposalOf(op, params);
      const refusal = await (await loadBackend()).readiness(proposalId, ctx);
      return refusal === null ? null : { code: "refused", message: refusal };
    },

    // Irreversible: the engine never asks (the op is registered reversible: false).
    async captureUndo() {
      return null;
    },

    async execute(op, params, ctx): Promise<PurchaseOrderResult> {
      const proposalId = proposalOf(op, params);
      if (!ctx.execution_id) {
        throw new PurchaseOrderRefused("a purchase order goes out only inside an engine run");
      }
      const plan = await (await loadBackend()).plan(proposalId, ctx);
      if ("refused" in plan) throw new PurchaseOrderRefused(plan.refused);
      // The stop, right before the one send (rule 15).
      if (ctx.halted && (await ctx.halted())) {
        throw new PurchaseOrderHold(
          "The emergency stop came on before the order went out. Nothing was sent; it goes out after you resume.",
        );
      }
      const base = {
        number: plan.po.number,
        to_domain: domainOf(plan.to),
        po_sha256: plan.po_sha256,
      };
      const now = mode();
      if (now.mode === "fake") {
        // The fake sender: the run is journaled like any other, and nothing leaves SYB.
        logSend(ctx, plan.proposal_id, "not_sent", { reasons: now.reasons });
        return { sent: false, not_sent: now.reasons, ...base };
      }
      const outcome = await sendPurchaseOrderEmail(
        {
          from: poFromHeader(plan.po.business, now.from_address),
          to: plan.to,
          reply_to: plan.reply_to,
          subject: plan.email.subject,
          text: plan.email.text,
          html: plan.email.html,
          idempotency_key: `syb-po-${plan.proposal_id}`,
        },
        now.api_key,
        fetchImpl,
      );
      logSend(ctx, plan.proposal_id, outcome.kind, {
        ...(outcome.kind === "refused" ? { status: outcome.status } : {}),
        // Rule 34: the email out as a cost line, tagged by workload.
        ...(outcome.kind === "refused"
          ? {}
          : { workload: PO_EMAIL_WORKLOAD, cost_eur: PO_EMAIL_COST_EUR }),
      });
      if (outcome.kind === "sent") {
        return { sent: true, provider_id: outcome.provider_id, ...base };
      }
      if (outcome.kind === "refused") {
        throw new PurchaseOrderRefused(
          `The email service refused the order (it answered ${outcome.status}). Nothing went out; you can send it again once that is fixed.`,
        );
      }
      throw new PurchaseOrderRefused(
        `${PO_UNCONFIRMED} It may have reached ${plan.po.supplier.name}, so SYB won't send it again: download it and check with them.`,
      );
    },

    async undo() {
      throw new PurchaseOrderRefused(
        "A sent order can't be recalled, and SYB never changes or cancels an order. Tell the supplier yourself.",
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
  // Ids and codes only — never an address, a name or a body.
  console.log(
    JSON.stringify({
      event: "purchase_order_send",
      account_id: ctx.account_id,
      execution_id: ctx.execution_id ?? null,
      attempt: ctx.attempt ?? null,
      proposal_id: proposalId,
      outcome,
      ...extra,
    }),
  );
}

export const purchaseOrderExecutor = createPurchaseOrderExecutor();
