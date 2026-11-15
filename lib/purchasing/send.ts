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
//   by hand        markPurchaseOrderSentByHand: the owner says they sent it
//                  themselves — approved → executed with that statement, an
//                  "execution" entry in their name, never emailed after
//
// "No PO email without an approval row": the engine runs approved rows only,
// and on top of that the pre-flight reads the approval entry the queue wrote
// (decision_log kind "approval", its payload hash and its person) and refuses
// without it. A declined order is "rejected" and never reaches a sender.
//
// Held, not done (the owner's decision of 2026-11-09): an approved order
// while sending is off stays approved, isn't run, and goes out on the first
// due run after sending is on — if its last yes is at most 14 days old by
// then (lib/execution/stale). An older one waits: "Send now" records the
// owner's yes again (a second "approval" entry, marked reconfirmed, by the
// person who pressed it) and sends it.

import { and, desc, eq, inArray, like, ne } from "drizzle-orm";
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
import { PO_HELD, PO_UNCONFIRMED } from "../execution/providers/purchase-order";
import { stalePurchaseOrder } from "../execution/stale";
import { businessCustomerLocale } from "../i18n/people";
import type { AppLocale } from "../i18n/locales";
import { wordsFor } from "../i18n/recipient";
import type { ProposalRow } from "../proposals/service";
import { hashProposalPayload } from "../proposals/service";
import { STOCK_MODULE } from "../stock/propose";
import type { NotSentReason, PoDocStatus, PurchaseOrder } from "./po";
import {
  PO_KIND,
  PO_OP,
  PO_PROVIDER,
  normaliseEmail,
  poEmail,
  poSha256,
  poTotals,
  sendingMode,
} from "./po";
import { pdfLocale, poPdfFilename, renderPurchaseOrderPdf } from "./pdf";
import { PO_REF_PREFIX } from "./propose";

/** The words of the email and the document (messages/<locale>.json). */
export const PO_WORDS = "emails.purchaseOrder";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/* ── the recorded yes ── */

type YesRow = Pick<ProposalRow, "id" | "profile_id" | "decided_by">;

/** The approval the queue wrote for this row: by the person it names (rule 12). */
function approvalHash(p: YesRow): string {
  return hashProposalPayload("approval", {
    proposal_id: p.id,
    profile_id: p.profile_id,
    status: "approved",
    decided_by: p.decided_by,
    rejection_reason: null,
  });
}

/** The owner's yes again for an order held past 14 days: by the person who pressed Send now. */
function reconfirmHash(p: YesRow, userId: string): string {
  return hashProposalPayload("approval", {
    proposal_id: p.id,
    profile_id: p.profile_id,
    status: "approved",
    decided_by: userId,
    rejection_reason: null,
    detail: { reconfirmed: true },
  });
}

interface YesEntry {
  ref_id: string;
  payload_hash: string;
  user_id: string | null;
  at: string;
}

/** Pure: whether the queue's own approval is on the log, and the latest recorded yes (ISO), per order. */
export function yesOf(
  p: YesRow,
  entries: readonly YesEntry[],
): { approved: boolean; last_yes: string | null } {
  const mine = entries.filter((e) => e.ref_id === p.id && e.user_id !== null);
  const approvals = mine.filter(
    (e) => e.user_id === p.decided_by && e.payload_hash === approvalHash(p),
  );
  // A re-confirmation counts only beside a real approval.
  const yeses =
    approvals.length === 0
      ? []
      : [...approvals, ...mine.filter((e) => e.payload_hash === reconfirmHash(p, e.user_id!))];
  const last = yeses.map((e) => Date.parse(e.at)).filter(Number.isFinite);
  return {
    approved: approvals.length > 0,
    last_yes: last.length === 0 ? null : new Date(Math.max(...last)).toISOString(),
  };
}

async function yesEntries(profileId: string, ids: readonly string[]): Promise<YesEntry[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      ref_id: decisionLog.ref_id,
      payload_hash: decisionLog.payload_hash,
      user_id: decisionLog.user_id,
      at: decisionLog.at,
    })
    .from(decisionLog)
    .where(
      and(
        eq(decisionLog.profile_id, profileId),
        eq(decisionLog.kind, "approval"),
        inArray(decisionLog.ref_id, [...ids]),
      ),
    );
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
  const yes = yesOf(proposal, await yesEntries(proposal.profile_id, [proposal.id]));
  if (!yes.approved) {
    return {
      refused:
        "There is no recorded approval for this order on the decision log, so it doesn't go out. Nothing was sent.",
    };
  }
  // Held past 14 days (2026-11-09): not emailed on its own; it waits for the owner's yes again.
  const stale = stalePurchaseOrder(yes.last_yes, new Date());
  if (stale !== null) return { refused: stale };
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
  /**
   * "sent": it went; "held": sending is off, so it stays approved and goes
   * out once sending is on; "not_sent": a run before 2026-11-09 went through
   * the fake sender; "refused": a gate held it; "failed": it didn't finish.
   */
  result: "sent" | "held" | "not_sent" | "refused" | "failed";
  /** Why it doesn't really go out (held), or didn't (not_sent). */
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

/**
 * Through executeProposal, so the stop, the approval, the watch and the claim
 * all run. Pressed on an order whose last yes is more than 14 days old, while
 * sending is on, it first records the presser's yes again (rule 12: the
 * re-confirmation is on the decision log, by the person) — the owner's
 * "re-confirm" of the decision of 2026-11-09. While sending is off it records
 * nothing and answers "held".
 */
export async function sendPurchaseOrderNow(args: {
  profileId: string;
  proposalId: string;
  /** Who pressed it: the re-confirmation is recorded in their name. */
  userId?: string | null;
  provider?: ExecutionProvider;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}): Promise<PoSendOutcome> {
  // An id that isn't a uuid names no order (the uuid column would throw, a 500).
  if (!UUID_RE.test(args.proposalId)) throw new PurchaseOrderSendError("no such purchase order");
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, args.proposalId));
  if (!proposal || proposal.profile_id !== args.profileId || !isPurchaseOrderProposal(proposal)) {
    throw new PurchaseOrderSendError("no such purchase order");
  }
  const provider = args.provider ?? executionProvider(PO_PROVIDER);
  const now = args.now ?? (() => new Date());
  if (
    proposal.status === "approved" &&
    proposal.decided_by &&
    args.userId &&
    provider.external === true
  ) {
    const yes = yesOf(proposal, await yesEntries(proposal.profile_id, [proposal.id]));
    if (yes.approved && stalePurchaseOrder(yes.last_yes, now()) !== null) {
      await db.insert(decisionLog).values({
        profile_id: proposal.profile_id,
        actor: "owner",
        kind: "approval",
        user_id: args.userId,
        ref_id: proposal.id,
        payload_hash: reconfirmHash(proposal, args.userId),
      });
      console.log(
        JSON.stringify({
          event: "purchase_order_reconfirmed",
          profile_id: proposal.profile_id,
          proposal_id: proposal.id,
        }),
      );
    }
  }
  try {
    const run = await executeProposal({
      proposalId: proposal.id,
      provider,
      op: PO_OP,
      params: { proposal_id: proposal.id },
      ...(args.sleep ? { sleep: args.sleep } : {}),
      ...(args.now ? { now: args.now } : {}),
    });
    if (run.status === "succeeded") {
      const result = run.result as PurchaseOrderResult | null;
      return result?.sent === false
        ? { result: "not_sent", reasons: result.not_sent }
        : { result: "sent" };
    }
    return { result: "failed", message: run.error ?? "The send didn't finish." };
  } catch (error) {
    if (error instanceof ExecutionRefused) {
      if (error.code === "deferred" && error.message.startsWith(PO_HELD)) {
        return { result: "held", reasons: currentSending().reasons, message: error.message };
      }
      return { result: "refused", message: error.message };
    }
    throw error;
  }
}

/* ── sent by hand ── */

/**
 * The owner says they sent the order themselves (downloaded, emailed or
 * handed over): approved → executed with that statement as its result and an
 * "execution" entry in their name, in one transaction. From then on nothing
 * emails it — the due runner selects approved rows only. Refused while a
 * send is running or after one went; only once.
 */
export async function markPurchaseOrderSentByHand(args: {
  profileId: string;
  accountId: string;
  proposalId: string;
  userId: string;
  now?: Date;
}): Promise<void> {
  if (!UUID_RE.test(args.proposalId)) throw new PurchaseOrderSendError("no such purchase order");
  const at = (args.now ?? new Date()).toISOString();
  await db.transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(and(eq(proposals.id, args.proposalId), eq(proposals.profile_id, args.profileId)));
    if (!proposal || !isPurchaseOrderProposal(proposal)) {
      throw new PurchaseOrderSendError("no such purchase order");
    }
    const [run] = await tx
      .select({ status: executions.status })
      .from(executions)
      .where(and(eq(executions.proposal_id, proposal.id), ne(executions.status, "failed")));
    if (proposal.status !== "approved" || run) {
      throw new PurchaseOrderSendError(
        "Only an approved order that hasn't been emailed can be marked as sent by hand.",
        409,
      );
    }
    const result = {
      kind: "sent_by_hand",
      stated_by: args.userId,
      stated_at: at,
      source: "owner_input",
      note: "The owner sent this order to the supplier themselves. ScaleX didn't email it.",
    };
    const [p] = await tx
      .update(proposals)
      .set({ status: "executed", execution_result: result })
      .where(and(eq(proposals.id, proposal.id), eq(proposals.status, "approved")))
      .returning();
    if (!p) throw new PurchaseOrderSendError("The order changed just now. Try again.", 409);
    await tx.insert(decisionLog).values({
      profile_id: p.profile_id,
      actor: "owner",
      kind: "execution",
      user_id: args.userId,
      ref_id: p.id,
      payload_hash: hashProposalPayload("execution", {
        proposal_id: p.id,
        profile_id: p.profile_id,
        status: p.status,
        decided_by: p.decided_by,
        detail: result,
      }),
    });
  });
  console.log(
    JSON.stringify({
      event: "purchase_order_sent_by_hand",
      account_id: args.accountId,
      profile_id: args.profileId,
      proposal_id: args.proposalId,
    }),
  );
}

/** Pure: the day an order was marked sent by hand, from its stored result, or null. */
export function sentByHandOn(executionResult: unknown): string | null {
  const r = executionResult as { kind?: unknown; stated_at?: unknown } | null;
  return r?.kind === "sent_by_hand" && typeof r.stated_at === "string"
    ? r.stated_at.slice(0, 10)
    : null;
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
  /**
   * Approved and not yet run because sending is off (2026-11-09): held, not
   * done, and why (codes the screen words). Empty when not held.
   */
  held: NotSentReason[];
  /** Approved, but its last yes is more than 14 days old: it goes out only on the owner's Send now. */
  needs_confirming: boolean;
  /** The day of the last recorded yes, YYYY-MM-DD; null before approval. */
  approved_on: string | null;
  /** The day the owner said they sent it themselves, YYYY-MM-DD. */
  by_hand_on: string | null;
  created_at: string;
}

/** The business's orders, newest first. Reads only. */
export async function listPurchaseOrders(
  profileId: string,
  limit = 10,
  now: Date = new Date(),
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
  const entries = await yesEntries(
    profileId,
    rows.filter((r) => r.decided_by).map((r) => r.id),
  );
  const sending = currentSending();
  return rows.flatMap((r) => {
    const stored = storedOrder(r.action);
    if (!stored) return [];
    const run = runOf.get(r.id);
    const result = run?.status === "succeeded" ? (run.result as PurchaseOrderResult | null) : null;
    const yes = r.decided_by ? yesOf(r, entries) : { approved: false, last_yes: null };
    const waiting = r.status === "approved" && (run === undefined || run.status === "failed");
    return [
      {
        id: r.id,
        number: stored.po.number,
        supplier: stored.po.supplier.name,
        lines: stored.po.lines.length,
        // Decision 4: only stated or measured prices, from the lines (never the stored totals).
        totals: poTotals(stored.po.lines).totals,
        status: r.status,
        blocked_by_limit: r.blocked_by_limit,
        sent: result ? result.sent : null,
        not_sent: result && result.sent === false ? result.not_sent : [],
        sent_on: result?.sent && run?.finished_at ? run.finished_at.slice(0, 10) : null,
        error: run?.status === "failed" ? run.error : null,
        held: waiting && !sending.real ? sending.reasons : [],
        needs_confirming: waiting && yes.approved && stalePurchaseOrder(yes.last_yes, now) !== null,
        approved_on: yes.last_yes?.slice(0, 10) ?? null,
        by_hand_on: r.status === "executed" ? sentByHandOn(r.execution_result) : null,
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
  const byHand = row.status === "executed" ? sentByHandOn(row.execution_result) : null;
  // A held order reads "approved": it is the document the owner sends by hand.
  const status: PoDocStatus = result?.sent
    ? { kind: "sent", on: (run!.finished_at ?? row.created_at).slice(0, 10) }
    : byHand
      ? { kind: "sent_by_hand", on: byHand }
      : result && !result.sent
        ? { kind: "not_sent" }
        : row.status === "approved"
          ? { kind: "approved" }
          : { kind: "draft" };
  return { po: stored.po, status, locale: await businessCustomerLocale(profileId) };
}
