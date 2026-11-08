// An approved purchase order, out through the engine — P6-04, rules 12, 15, 16, 27.
//
//   the route      purchaseOrderPlanFor: the due runner's plan for an approved
//                  order — { purchase_order, send_purchase_order, {proposal_id} },
//                  built from the approved row, never from anything it carries
//   the send       sendPurchaseOrderNow: the owner's "Send now" on /stock,
//                  THROUGH executeProposal, so every guard runs
//   the backend    dbPurchaseOrderBackend: what the provider reads (reads only)
//                  — the approval on the decision log, the order as approved
//                  (its fingerprint), the approver's address for replies, and
//                  the email in the business's language
//   the screen     listPurchaseOrders and poForDocument: where each order
//                  stands, in codes the screen words; the order as a document
//
// "No PO email without an approval row": the engine runs approved rows only,
// and on top of that the pre-flight reads the approval entry the queue wrote
// (decision_log kind "approval", its payload hash and its person) and refuses
// without it. A declined order is "rejected" and never reaches a sender.

import { and, desc, eq, inArray, like } from "drizzle-orm";
import { db } from "../../db";
import { decisionLog, executions, proposals, users } from "../../db/schema";
import type { DispatchPlan } from "../execution/due";
import { ExecutionRefused, executeProposal } from "../execution/engine";
import type { ExecutionContext, ExecutionProvider } from "../execution/providers/fixture";
import { executionProvider } from "../execution/providers/index";
import type {
  PurchaseOrderBackend,
  PurchaseOrderPlan,
  PurchaseOrderResult,
} from "../execution/providers/purchase-order";
import { PO_UNCONFIRMED } from "../execution/providers/purchase-order";
import { businessCustomerLocale } from "../i18n/people";
import type { AppLocale } from "../i18n/locales";
import { wordsFor } from "../i18n/recipient";
import type { ProposalRow } from "../proposals/service";
import { hashProposalPayload } from "../proposals/service";
import { STOCK_MODULE } from "../stock/propose";
import type { NotSentReason, PoDocStatus, PurchaseOrder } from "./po";
import { PO_KIND, PO_OP, PO_PROVIDER, normaliseEmail, poEmail, poSha256, sendingMode } from "./po";
import { pdfLocale, poPdfFilename, renderPurchaseOrderPdf } from "./pdf";
import { PO_REF_PREFIX } from "./propose";

/** The words of the email and the document (messages/<locale>.json). */
export const PO_WORDS = "emails.purchaseOrder";

export function isPurchaseOrderProposal(p: Pick<ProposalRow, "module" | "action">): boolean {
  return p.module === STOCK_MODULE && (p.action as { kind?: unknown } | null)?.kind === PO_KIND;
}

/** The due runner's route for an approved purchase order: one op, the proposal's own id. */
export function purchaseOrderPlanFor(
  proposal: Pick<ProposalRow, "id" | "module" | "action">,
): DispatchPlan | null {
  if (!isPurchaseOrderProposal(proposal)) return null;
  return { provider: PO_PROVIDER, op: PO_OP, params: { proposal_id: proposal.id } };
}

/** Pure: the order and its fingerprint as the proposal stores them, or null when either is missing. */
export function storedOrder(action: unknown): { po: PurchaseOrder; sha: string } | null {
  const detail = (action as { detail?: { po?: unknown; po_sha256?: unknown } } | null)?.detail;
  const po = detail?.po as PurchaseOrder | undefined;
  if (!po || typeof po !== "object" || typeof detail?.po_sha256 !== "string") return null;
  if (!Array.isArray(po.lines) || typeof po.supplier?.email !== "string") return null;
  return { po, sha: detail.po_sha256 };
}

/* ── the backend the provider reads ── */

async function readiness(
  proposalId: string,
  ctx: ExecutionContext,
): Promise<{ refused: string } | { proposal: ProposalRow; po: PurchaseOrder; sha: string }> {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
  if (!proposal || proposal.profile_id !== ctx.profile_id || !isPurchaseOrderProposal(proposal)) {
    return { refused: "There is no such purchase order." };
  }
  if (proposal.status !== "approved" || !proposal.decided_by) {
    return { refused: "This order isn't approved, so it doesn't go out." };
  }
  // Rule 12: the approval the queue recorded, by the person the row names.
  const approvals = await db
    .select({ payload_hash: decisionLog.payload_hash, user_id: decisionLog.user_id })
    .from(decisionLog)
    .where(
      and(
        eq(decisionLog.profile_id, proposal.profile_id),
        eq(decisionLog.kind, "approval"),
        eq(decisionLog.ref_id, proposal.id),
      ),
    );
  const expected = hashProposalPayload("approval", {
    proposal_id: proposal.id,
    profile_id: proposal.profile_id,
    status: "approved",
    decided_by: proposal.decided_by,
    rejection_reason: null,
  });
  if (!approvals.some((a) => a.payload_hash === expected && a.user_id === proposal.decided_by)) {
    return {
      refused:
        "There is no recorded approval for this order on the decision log, so it doesn't go out. Nothing was sent.",
    };
  }
  const stored = storedOrder(proposal.action);
  if (!stored || poSha256(stored.po) !== stored.sha) {
    return {
      refused:
        "This order has changed since it was approved, so it doesn't go out. Nothing was sent; make the order again.",
    };
  }
  if (normaliseEmail(stored.po.supplier.email) === null) {
    return { refused: "The supplier's email address on this order isn't one. Nothing was sent." };
  }
  // An earlier send nobody could confirm is never repeated.
  const [prior] = await db
    .select({ status: executions.status, error: executions.error })
    .from(executions)
    .where(eq(executions.proposal_id, proposal.id));
  if (prior?.status === "failed" && prior.error?.startsWith(PO_UNCONFIRMED)) {
    return { refused: prior.error };
  }
  return { proposal, po: stored.po, sha: stored.sha };
}

/** The provider's reads (lib/execution/providers/purchase-order.ts). */
export function dbPurchaseOrderBackend(): PurchaseOrderBackend {
  return {
    async readiness(proposalId, ctx) {
      const r = await readiness(proposalId, ctx);
      return "refused" in r ? r.refused : null;
    },
    async plan(proposalId, ctx): Promise<PurchaseOrderPlan | { refused: string }> {
      const r = await readiness(proposalId, ctx);
      if ("refused" in r) return r;
      const [approver] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, r.proposal.decided_by!));
      const locale = await businessCustomerLocale(r.proposal.profile_id);
      const words = await wordsFor(locale, PO_WORDS);
      // P6-09: the PDF the email carries — the order as approved, saying it
      // was emailed today (it is this email). In the business's language
      // when the PDF's font covers it, else English (lib/purchasing/pdf).
      const pdf = await renderPurchaseOrderPdf(
        r.po,
        locale === pdfLocale(locale) ? words : await wordsFor(pdfLocale(locale), PO_WORDS),
        { kind: "sent", on: new Date().toISOString().slice(0, 10) },
      );
      return {
        proposal_id: r.proposal.id,
        po: r.po,
        po_sha256: r.sha,
        to: normaliseEmail(r.po.supplier.email)!,
        reply_to: normaliseEmail(approver?.email) ?? null,
        email: poEmail(r.po, words),
        attachment: { filename: poPdfFilename(r.po), content: pdf },
      };
    },
  };
}

/* ── the owner's "Send now" ── */

export interface PoSendOutcome {
  /** "sent": it went; "not_sent": it ran against the fake sender; "refused": a gate held it; "failed": it didn't finish. */
  result: "sent" | "not_sent" | "refused" | "failed";
  /** Why it didn't really go out, when it ran against the fake sender. */
  reasons?: NotSentReason[];
  /** The engine's or the provider's own sentence, when there is one. */
  message?: string;
}

export class PurchaseOrderSendError extends Error {
  readonly status: number;
  constructor(message: string, status = 404) {
    super(message);
    this.name = "PurchaseOrderSendError";
    this.status = status;
  }
}

/** Through executeProposal, so the stop, the approval, the watch and the claim all run. */
export async function sendPurchaseOrderNow(args: {
  profileId: string;
  proposalId: string;
  provider?: ExecutionProvider;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PoSendOutcome> {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, args.proposalId));
  if (!proposal || proposal.profile_id !== args.profileId || !isPurchaseOrderProposal(proposal)) {
    throw new PurchaseOrderSendError("no such purchase order");
  }
  try {
    const run = await executeProposal({
      proposalId: proposal.id,
      provider: args.provider ?? executionProvider(PO_PROVIDER),
      op: PO_OP,
      params: { proposal_id: proposal.id },
      ...(args.sleep ? { sleep: args.sleep } : {}),
    });
    if (run.status === "succeeded") {
      const result = run.result as PurchaseOrderResult | null;
      return result?.sent === false
        ? { result: "not_sent", reasons: result.not_sent }
        : { result: "sent" };
    }
    return { result: "failed", message: run.error ?? "The send didn't finish." };
  } catch (error) {
    if (error instanceof ExecutionRefused) return { result: "refused", message: error.message };
    throw error;
  }
}

/* ── the screen ── */

export interface PurchaseOrderView {
  id: string;
  number: string;
  supplier: string;
  lines: number;
  totals: { amount_minor: number; currency: string }[];
  /** The proposal's status: pending, approved, rejected, expired, blocked, executed… */
  status: string;
  blocked_by_limit: string | null;
  /** Once run: whether it really went, and if not, why. Null before a run finished. */
  sent: boolean | null;
  not_sent: NotSentReason[];
  /** The day it went, YYYY-MM-DD (the screen words it). */
  sent_on: string | null;
  /** A run that ended without finishing: the engine's sentence. */
  error: string | null;
  created_at: string;
}

/** The business's orders, newest first. Reads only. */
export async function listPurchaseOrders(
  profileId: string,
  limit = 10,
): Promise<PurchaseOrderView[]> {
  const rows = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        like(proposals.originating_finding, `${PO_REF_PREFIX}%`),
      ),
    )
    .orderBy(desc(proposals.created_at))
    .limit(limit);
  const runs =
    rows.length === 0
      ? []
      : await db
          .select()
          .from(executions)
          .where(
            inArray(
              executions.proposal_id,
              rows.map((r) => r.id),
            ),
          );
  const runOf = new Map(runs.map((r) => [r.proposal_id, r]));
  return rows.flatMap((r) => {
    const stored = storedOrder(r.action);
    if (!stored) return [];
    const run = runOf.get(r.id);
    const result = run?.status === "succeeded" ? (run.result as PurchaseOrderResult | null) : null;
    return [
      {
        id: r.id,
        number: stored.po.number,
        supplier: stored.po.supplier.name,
        lines: stored.po.lines.length,
        totals: stored.po.totals,
        status: r.status,
        blocked_by_limit: r.blocked_by_limit,
        sent: result ? result.sent : null,
        not_sent: result && result.sent === false ? result.not_sent : [],
        sent_on: result?.sent && run?.finished_at ? run.finished_at.slice(0, 10) : null,
        error: run?.status === "failed" ? run.error : null,
        created_at: r.created_at,
      },
    ];
  });
}

/** Pure: whether email can really go out now, for the screen to say before anything runs. */
export function currentSending(): { real: boolean; reasons: NotSentReason[] } {
  const m = sendingMode(process.env);
  return m.mode === "real" ? { real: true, reasons: [] } : { real: false, reasons: m.reasons };
}

/** One order as a document: the order, its words and where it stands. Null = not this business's. */
export async function poForDocument(
  profileId: string,
  proposalId: string,
): Promise<{ po: PurchaseOrder; status: PoDocStatus; locale: AppLocale } | null> {
  const [row] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), eq(proposals.profile_id, profileId)));
  if (!row || !isPurchaseOrderProposal(row)) return null;
  const stored = storedOrder(row.action);
  if (!stored) return null;
  const [run] = await db.select().from(executions).where(eq(executions.proposal_id, row.id));
  const result = run?.status === "succeeded" ? (run.result as PurchaseOrderResult | null) : null;
  const status: PoDocStatus = result?.sent
    ? { kind: "sent", on: (run!.finished_at ?? row.created_at).slice(0, 10) }
    : result && !result.sent
      ? { kind: "not_sent" }
      : row.status === "approved"
        ? { kind: "approved" }
        : { kind: "draft" };
  return { po: stored.po, status, locale: await businessCustomerLocale(profileId) };
}
