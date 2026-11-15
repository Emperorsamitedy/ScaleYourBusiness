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
// The email carries the order as a PDF (P6-09): the same order, rendered
// by lib/purchasing/pdf from the approved row, attached once. The body is
// unchanged. The run's result records the file's name and size, real or fake.
//
// Real, or held. The order goes out only when SYB's email service is set up
// on a verified domain AND the real-write gate is on (SESSION_D_REAL_WRITES);
// lib/purchasing/po's sendingMode decides, read at the moment of sending.
// `external` follows the same reading, so with the gate off the engine's
// guard 6a never sees a real sender. Otherwise the order is HELD (the
// owner's decision of 2026-11-09): the pre-flight refuses it as deferred,
// before the claim, so there is no execution row, the proposal stays
// approved and nothing is marked done. The due runner picks it up again on
// every pass and it goes out on the first one after sending is switched on —
// unless its last recorded yes is more than 14 days old by then
// (lib/execution/stale, stalePurchaseOrder), when it waits for the owner's
// "Send now". Meanwhile the owner can download it and send it by hand.
// (Before 2026-11-09 such a run went through a fake sender and was marked
// executed with {sent: false}; those rows are still read, never written.)
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

/**
 * The start of the pre-flight's sentence for an order held while sending is
 * off. sendPurchaseOrderNow reads it back to answer "held" with the reasons.
 */
export const PO_HELD = "Waiting for email to be set up.";

const HELD_WHY: Record<NotSentReason, string> = {
  email_not_set_up: "Email isn't set up on ScaleX's sending domain yet.",
  real_writes_off: "Real sending is switched off until the two-week unattended test completes.",
};

/** Pure: the owner's sentence for a held order, every reason named. */
export function heldSentence(reasons: readonly NotSentReason[]): string {
  return [
    PO_HELD,
    ...reasons.map((r) => HELD_WHY[r]),
    "Nothing was sent and it isn't marked done: it stays approved and goes out on the first run after sending is switched on (if you approved it more than 14 days before that, it waits for you to confirm it). You can download it and send it yourself meanwhile, then mark it as sent by hand.",
  ].join(" ");
}

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
  /** P6-09: the order as a PDF, attached to the email (lib/purchasing/pdf). */
  attachment: PoAttachment;
}

/** A file on the email: its name and its bytes. */
export interface PoAttachment {
  filename: string;
  content: Uint8Array;
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
  /** P6-09: the order's PDF — Resend's `attachments`, content as Base64. */
  attachments: { filename: string; content: string }[];
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
        ...(mail.attachments.length > 0 ? { attachments: mail.attachments } : {}),
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

/** The file the email carried (or, from the fake sender, would have): its name and size. */
export interface PoAttachmentRecord {
  filename: string;
  bytes: number;
}

/**
 * What an execution of this provider returns, journaled as the result. Only
 * `sent: true` is written now; `sent: false` is how a run against the fake
 * sender was journaled before 2026-11-09, still read for those rows.
 */
export type PurchaseOrderResult =
  | {
      sent: true;
      number: string;
      provider_id: string;
      to_domain: string;
      po_sha256: string;
      attachments: PoAttachmentRecord[];
    }
  | {
      sent: false;
      number: string;
      not_sent: NotSentReason[];
      to_domain: string;
      po_sha256: string;
      attachments: PoAttachmentRecord[];
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
      // Held, not run (2026-11-09): while sending is off nothing is claimed or
      // marked done; the proposal stays approved for the first run after.
      const now = mode();
      if (now.mode === "fake") return { code: "deferred", message: heldSentence(now.reasons) };
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
        // P6-09: the PDF, by name and size — journaled, never its bytes.
        attachments: [
          { filename: plan.attachment.filename, bytes: plan.attachment.content.byteLength },
        ],
      };
      const now = mode();
      if (now.mode === "fake") {
        // Sending went off between the pre-flight and here: nothing leaves SYB
        // and nothing is marked done. The run ends (never retried in-run); the
        // owner's Send now runs it again once sending is on.
        logSend(ctx, plan.proposal_id, "held", { reasons: now.reasons });
        throw new PurchaseOrderRefused(
          "Sending was switched off just as this order was about to go. Nothing was sent; press Send now once sending is on again.",
        );
      }
      const outcome = await sendPurchaseOrderEmail(
        {
          from: poFromHeader(plan.po.business, now.from_address),
          to: plan.to,
          reply_to: plan.reply_to,
          subject: plan.email.subject,
          text: plan.email.text,
          html: plan.email.html,
          attachments: [
            {
              filename: plan.attachment.filename,
              content: Buffer.from(plan.attachment.content).toString("base64"),
            },
          ],
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
        `${PO_UNCONFIRMED} It may have reached ${plan.po.supplier.name}, so ScaleX won't send it again: download it and check with them.`,
      );
    },

    async undo() {
      throw new PurchaseOrderRefused(
        "A sent order can't be recalled, and ScaleX never changes or cancels an order. Tell the supplier yourself.",
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
