// Prepared payments — P6-05 (rule 26 amended: money is prepared, never
// moved). The owner chose: SYB prepares a payment, the owner presses pay in
// their own bank. This module records what a payment is and where it
// stands; it holds no bank credential, no payment-initiation scope and no
// network call (lib/payments/fence.test.ts fails the build if one appears).
//
//   · A payment is a PROPOSAL first (rule 12): `draftPaymentProposal`
//     records a pending proposal (module "payments", kind
//     "prepared_payment", a note kind the due runner leaves unrouted) and
//     its prepared_payments row in one transaction. Approval is the queue's
//     own decision path, by a named person.
//   · Approved and not marked paid is "ready for your bank": the loader for
//     files selects exactly that, so nothing unapproved reaches a file.
//     Which file a ready payment already went into is ./exports' (a
//     payment is in one downloaded file at most).
//   · "Paid in my bank" is the owner's statement: it marks the row, moves
//     the proposal to executed with the statement as its result, and logs
//     it as the owner's, in the same transaction.
//   · The paying side (the debtor) is stated once, superseded never
//     overwritten (rules 2, 3), in payer_accounts.
//   · IBANs are sensitive: logs and the proposal carry the mask; the full
//     number lives only on the row, and erasure (rule 22) nulls it.

import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  costItems,
  decisionLog,
  fieldRecords,
  payerAccounts,
  paymentExportItems,
  paymentExports,
  preparedPayments,
  proposals,
  suppliers,
} from "../../db/schema";
import type { Money } from "../core/money";
import { isIsoCurrency, money } from "../core/money";
import type { ScenarioBlock } from "../diagnosis/recommendations";
import type { LimitLlm } from "../proposals/hard-limits";
import { checkHardLimits, ensureHardLimits, limitCaption } from "../proposals/hard-limits";
import { createProposal, hashProposalPayload } from "../proposals/service";
import { checkBic, checkIban, maskIban } from "./iban";
import type { Debtor, FilePayment } from "./sepa";

export const PAYMENTS_MODULE = "payments";
export const PAYMENT_KIND = "prepared_payment";
/** Days a payment proposal waits for a decision before it lapses. */
export const PAYMENT_EXPIRY_DAYS = 30;
/** How far ahead a requested date may be. */
export const MAX_DAYS_AHEAD = 366;
export const MAX_REFERENCE = 140;
export const MAX_NAME = 70;

export type PaysKind = "supplier" | "fixed_cost" | "purchase_order" | "other";
export const PAYS_KINDS: readonly PaysKind[] = [
  "supplier",
  "fixed_cost",
  "purchase_order",
  "other",
];

/** Why a draft was refused: a code the screen turns into words. */
export type DraftRefusal =
  | "iban_empty"
  | "iban_format"
  | "iban_country"
  | "iban_length"
  | "iban_checksum"
  | "bic"
  | "name"
  | "amount"
  | "currency"
  | "reference"
  | "date"
  | "date_past"
  | "date_far"
  | "pays_kind"
  | "supplier"
  | "cost_item"
  | "purchase_order";

export class PaymentDraftError extends Error {
  readonly status: number;
  readonly code: DraftRefusal | "not_found" | "not_ready" | "no_session";
  constructor(code: PaymentDraftError["code"], message: string, status = 422) {
    super(message);
    this.name = "PaymentDraftError";
    this.code = code;
    this.status = status;
  }
}

export interface PaymentDraftInput {
  payee_name?: string | null;
  iban: string;
  bic?: string | null;
  amount: Money;
  reference: string;
  /** YYYY-MM-DD. */
  execution_date: string;
  pays: {
    kind: PaysKind;
    supplier_id?: string | null;
    cost_item_id?: string | null;
    ref?: string | null;
  };
}

/** A draft that passed every check: what is recorded. */
export interface CheckedDraft {
  payee_name: string | null;
  iban: string;
  bic: string | null;
  amount: Money;
  reference: string;
  execution_date: string;
  pays_kind: PaysKind;
  supplier_id: string | null;
  cost_item_id: string | null;
  purchase_order_ref: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Pure: every check a draft passes before anything is written — the IBAN's
 * country, length and mod-97, an optional BIC, Money that is an integer of
 * minor units above zero (rule 1), a reference, a date from today to a year
 * ahead, and what it pays. The payee's name may be left for the supplier's.
 */
export function checkDraft(input: PaymentDraftInput, today: string): CheckedDraft {
  const fail: (code: DraftRefusal, message: string) => never = (code, message) => {
    throw new PaymentDraftError(code, message);
  };
  const iban = checkIban(typeof input.iban === "string" ? input.iban : "");
  if (!iban.ok) fail(`iban_${iban.reason}`, `that IBAN doesn't check out (${iban.reason})`);
  let bic: string | null = null;
  if (typeof input.bic === "string" && input.bic.trim() !== "") {
    bic = checkBic(input.bic);
    if (bic === null) fail("bic", "that BIC isn't eight or eleven letters and digits");
  }
  const name = typeof input.payee_name === "string" ? input.payee_name.trim() : "";
  if (name.length > MAX_NAME) fail("name", `the name is longer than ${MAX_NAME} characters`);
  const a = input.amount;
  if (!a || typeof a.currency !== "string" || !isIsoCurrency(a.currency.toUpperCase())) {
    fail("currency", "the currency isn't a three-letter ISO code");
  }
  if (!Number.isSafeInteger(a.amount_minor) || a.amount_minor <= 0) {
    fail("amount", "the amount must be a whole number of minor units above zero");
  }
  const amount = money(a.amount_minor, a.currency.toUpperCase());
  const reference = typeof input.reference === "string" ? input.reference.trim() : "";
  if (reference === "" || reference.length > MAX_REFERENCE) {
    fail("reference", `the reference must be 1 to ${MAX_REFERENCE} characters`);
  }
  const date = input.execution_date;
  if (
    typeof date !== "string" ||
    !DATE_RE.test(date) ||
    Number.isNaN(Date.parse(`${date}T00:00:00Z`))
  ) {
    fail("date", "the date must be a day, YYYY-MM-DD");
  }
  if (date < today) fail("date_past", "that day has passed");
  if (date > addDays(today, MAX_DAYS_AHEAD)) fail("date_far", "that day is more than a year ahead");
  const kind = input.pays?.kind;
  if (!PAYS_KINDS.includes(kind)) fail("pays_kind", "say what the payment is for");
  const supplierId = kind === "supplier" ? (input.pays.supplier_id ?? null) : null;
  const costId = kind === "fixed_cost" ? (input.pays.cost_item_id ?? null) : null;
  const poRef = kind === "purchase_order" ? (input.pays.ref ?? "").trim() : "";
  if (kind === "supplier" && (supplierId === null || !UUID_RE.test(supplierId))) {
    fail("supplier", "choose the supplier it pays");
  }
  if (kind === "fixed_cost" && (costId === null || !UUID_RE.test(costId))) {
    fail("cost_item", "choose the fixed cost it pays");
  }
  if (kind === "purchase_order" && (poRef === "" || poRef.length > 100)) {
    fail("purchase_order", "name the purchase order it pays");
  }
  if (name === "" && kind !== "supplier") fail("name", "say who is paid");
  return {
    payee_name: name === "" ? null : name,
    iban: iban.ok ? iban.iban : "",
    bic,
    amount,
    reference,
    execution_date: date,
    pays_kind: kind,
    supplier_id: supplierId,
    cost_item_id: costId,
    purchase_order_ref: poRef === "" ? null : poRef,
  };
}

async function currentValue(profileId: string, key: string): Promise<unknown> {
  const [row] = await db
    .select({ value: fieldRecords.value, status: fieldRecords.status })
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        eq(fieldRecords.field_key, key),
        isNull(fieldRecords.superseded_at),
      ),
    );
  return row?.status === "answered" ? row.value : null;
}

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

function moneyOf(v: unknown): Money | null {
  const m = v as { amount_minor?: unknown; currency?: unknown } | null;
  return m &&
    typeof m.amount_minor === "number" &&
    Number.isSafeInteger(m.amount_minor) &&
    typeof m.currency === "string"
    ? { amount_minor: m.amount_minor, currency: m.currency }
    : null;
}

/** What a payment can be linked to: the owner's suppliers and fixed costs, by name. */
export interface PayableThings {
  suppliers: { id: string; name: string | null }[];
  fixed_costs: { id: string; label: string | null; amount: Money | null }[];
}

export async function payableThings(profileId: string): Promise<PayableThings> {
  const [sRows, cRows] = await Promise.all([
    db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(eq(suppliers.profile_id, profileId))
      .orderBy(asc(suppliers.created_at)),
    db
      .select({ id: costItems.id })
      .from(costItems)
      .where(and(eq(costItems.profile_id, profileId), eq(costItems.bucket, "fixed")))
      .orderBy(asc(costItems.created_at)),
  ]);
  return {
    suppliers: await Promise.all(
      sRows.map(async (s) => ({
        id: s.id,
        name: text(await currentValue(profileId, `suppliers.${s.id}.name`)),
      })),
    ),
    fixed_costs: await Promise.all(
      cRows.map(async (c) => ({
        id: c.id,
        label: text(await currentValue(profileId, `costs.${c.id}.label`)),
        amount: moneyOf(await currentValue(profileId, `costs.${c.id}.amount`)),
      })),
    ),
  };
}

function scenarioFor(d: CheckedDraft): ScenarioBlock {
  return {
    assumptions: [
      {
        statement: `the payee's IBAN ${maskIban(d.iban)} passed the country, length and mod-97 checks; it is what you typed, so check it against what the payee sent you`,
        value: null,
        source_field: null,
        sensitivity: "high",
      },
      {
        statement: `the amount is what you stated, to leave your bank on ${d.execution_date}`,
        value: d.amount,
        source_field: null,
        sensitivity: "low",
      },
    ],
    base_case: {
      case: "base",
      statement:
        "Approved, it waits as ready for your bank: a file and plain steps you take to your own bank. Nothing leaves until you pay it there.",
      profit_delta_monthly: null,
      formula: null,
    },
    downside_case: {
      case: "downside",
      statement: "A detail is wrong: your bank refuses it or asks you, and you correct it there.",
      profit_delta_monthly: null,
      formula: null,
    },
    upside_case: {
      case: "upside",
      statement: "The payment goes out on the day, with the reference the payee expects.",
      profit_delta_monthly: null,
      formula: null,
    },
    breakeven_condition: "not computed: paying what you owe isn't a profit decision",
  };
}

export interface DraftOutcome {
  payment_id: string;
  proposal_id: string;
  status: "pending" | "blocked";
}

/**
 * Record a payment proposal: pending (or born blocked by a 13.5 limit,
 * rule 14), with its prepared_payments row, in one transaction. Nothing is
 * paid, now or on approval.
 */
export async function draftPaymentProposal(args: {
  profileId: string;
  accountId: string;
  input: PaymentDraftInput;
  now?: Date;
  limitLlm?: LimitLlm;
}): Promise<DraftOutcome> {
  const now = args.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const d = checkDraft(args.input, today);

  let payee = d.payee_name;
  let what = "something else";
  if (d.supplier_id) {
    const [s] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, d.supplier_id), eq(suppliers.profile_id, args.profileId)));
    if (!s) throw new PaymentDraftError("supplier", "no such supplier in this business");
    const name = text(await currentValue(args.profileId, `suppliers.${s.id}.name`));
    payee = payee ?? name;
    what = "a supplier";
  }
  if (d.cost_item_id) {
    const [c] = await db
      .select({ id: costItems.id })
      .from(costItems)
      .where(
        and(
          eq(costItems.id, d.cost_item_id),
          eq(costItems.profile_id, args.profileId),
          eq(costItems.bucket, "fixed"),
        ),
      );
    if (!c) throw new PaymentDraftError("cost_item", "no such fixed cost in this business");
    const label = text(await currentValue(args.profileId, `costs.${c.id}.label`));
    what = label ? `the fixed cost "${label}"` : "a fixed cost";
  }
  if (d.purchase_order_ref) what = `purchase order ${d.purchase_order_ref}`;
  if (payee === null) throw new PaymentDraftError("name", "say who is paid");

  const { limits } = await ensureHardLimits(args.profileId, args.limitLlm);
  const verdict = checkHardLimits(limits, PAYMENT_KIND);
  const masked = maskIban(d.iban);

  const out = await db.transaction(async (tx) => {
    const proposal = await createProposal(
      {
        profile_id: args.profileId,
        module: PAYMENTS_MODULE,
        originating_finding: null,
        action: {
          kind: PAYMENT_KIND,
          summary: `Prepare a payment to ${payee} for your bank`,
          detail: {
            payee,
            iban_masked: masked,
            amount: d.amount,
            reference: d.reference,
            execution_date: d.execution_date,
            pays: what,
            what: "A payment prepared for you to make in your own bank: a SEPA file for euros, plain steps for any currency.",
            sending:
              "Nothing is paid, now or on approval. SYB can't move money: approving makes it ready for your bank, and you pay it there yourself.",
            manual_limits: verdict.manual.map((l) => l.quote),
          },
        },
        scenario: scenarioFor(d),
        reversibility: {
          level: "easy",
          if_you_change_your_mind:
            "Nothing leaves your bank unless you send it there yourself. Decline it, or simply don't make the payment.",
        },
        expires_at: new Date(now.getTime() + PAYMENT_EXPIRY_DAYS * 86_400_000).toISOString(),
        blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
      },
      tx,
    );
    const [row] = await tx
      .insert(preparedPayments)
      .values({
        profile_id: args.profileId,
        proposal_id: proposal.id,
        payee_name: payee,
        payee_iban: d.iban,
        payee_bic: d.bic,
        amount_minor: d.amount.amount_minor,
        currency: d.amount.currency,
        reference: d.reference,
        execution_date: d.execution_date,
        pays_kind: d.pays_kind,
        supplier_id: d.supplier_id,
        cost_item_id: d.cost_item_id,
        purchase_order_ref: d.purchase_order_ref,
      })
      .returning({ id: preparedPayments.id });
    return {
      payment_id: row!.id,
      proposal_id: proposal.id,
      status: proposal.status === "blocked" ? ("blocked" as const) : ("pending" as const),
    };
  });
  console.log(
    JSON.stringify({
      event: "payment_drafted",
      account_id: args.accountId,
      profile_id: args.profileId,
      payment_id: out.payment_id,
      proposal_id: out.proposal_id,
      status: out.status,
      iban: masked,
      amount_minor: d.amount.amount_minor,
      currency: d.amount.currency,
    }),
  );
  return out;
}

/* ── where each payment stands ── */

export type PaymentStage =
  | "waiting" // pending approval
  | "blocked" // born blocked by a 13.5 limit
  | "ready" // approved, not marked paid: ready for your bank
  | "paid" // the owner said they paid it in their bank
  | "declined"
  | "changes" // changes requested
  | "lapsed"; // expired undecided

/** Pure: a payment's stage from its proposal's status and its paid mark. */
export function stageOf(proposalStatus: string, paid: boolean): PaymentStage {
  if (paid) return "paid";
  switch (proposalStatus) {
    case "pending":
      return "waiting";
    case "blocked":
      return "blocked";
    case "approved":
      return "ready";
    case "executed":
      return "paid";
    case "rejected":
      return "declined";
    case "changes_requested":
      return "changes";
    default:
      return "lapsed";
  }
}

/**
 * The file a payment went into (the owner's decision of 2026-11-09): a
 * payment is in one downloaded file at most, and the screen says which.
 */
export interface InFile {
  export_id: string;
  format: "sepa" | "steps";
  msg_id: string;
  /** YYYY-MM-DD: the day the file was made. */
  made_on: string;
}

/** One payment as the screen shows it: the IBAN masked, never whole. */
export interface PaymentListing {
  id: string;
  proposal_id: string;
  stage: PaymentStage;
  payee_name: string | null;
  iban_masked: string;
  bic: string | null;
  amount: Money;
  reference: string;
  execution_date: string;
  pays_kind: PaysKind;
  supplier_id: string | null;
  cost_item_id: string | null;
  purchase_order_ref: string | null;
  created_at: string;
  approved_at: string | null;
  paid_stated_at: string | null;
  erased: boolean;
  blocked_by_limit: string | null;
  /** The bank file it is already in, or null when it is in none. */
  in_file: InFile | null;
}

const listColumns = {
  id: preparedPayments.id,
  proposal_id: preparedPayments.proposal_id,
  payee_name: preparedPayments.payee_name,
  payee_iban: preparedPayments.payee_iban,
  payee_bic: preparedPayments.payee_bic,
  amount_minor: preparedPayments.amount_minor,
  currency: preparedPayments.currency,
  reference: preparedPayments.reference,
  execution_date: preparedPayments.execution_date,
  pays_kind: preparedPayments.pays_kind,
  supplier_id: preparedPayments.supplier_id,
  cost_item_id: preparedPayments.cost_item_id,
  purchase_order_ref: preparedPayments.purchase_order_ref,
  created_at: preparedPayments.created_at,
  paid_stated_at: preparedPayments.paid_stated_at,
  erased_at: preparedPayments.erased_at,
  status: proposals.status,
  decided_by: proposals.decided_by,
  decided_at: proposals.decided_at,
  blocked_by_limit: proposals.blocked_by_limit,
};

/** Every payment of the business, newest first, masked. */
export async function listPayments(profileId: string): Promise<PaymentListing[]> {
  const rows = await db
    .select({
      ...listColumns,
      export_id: paymentExports.id,
      export_format: paymentExports.format,
      export_msg_id: paymentExports.msg_id,
      export_made_on: paymentExports.made_on,
    })
    .from(preparedPayments)
    .innerJoin(proposals, eq(proposals.id, preparedPayments.proposal_id))
    .leftJoin(paymentExportItems, eq(paymentExportItems.payment_id, preparedPayments.id))
    .leftJoin(
      paymentExports,
      and(
        eq(paymentExports.id, paymentExportItems.export_id),
        eq(paymentExports.profile_id, profileId),
      ),
    )
    .where(eq(preparedPayments.profile_id, profileId))
    .orderBy(desc(preparedPayments.created_at));
  return rows.map((r) => ({
    id: r.id,
    proposal_id: r.proposal_id,
    stage: stageOf(r.status, r.paid_stated_at !== null),
    payee_name: r.payee_name,
    iban_masked: maskIban(r.payee_iban),
    bic: r.payee_bic,
    amount: { amount_minor: r.amount_minor, currency: r.currency },
    reference: r.reference,
    execution_date: r.execution_date,
    pays_kind: r.pays_kind as PaysKind,
    supplier_id: r.supplier_id,
    cost_item_id: r.cost_item_id,
    purchase_order_ref: r.purchase_order_ref,
    created_at: r.created_at,
    approved_at: r.status === "approved" || r.status === "executed" ? r.decided_at : null,
    paid_stated_at: r.paid_stated_at,
    erased: r.erased_at !== null,
    blocked_by_limit: r.blocked_by_limit,
    in_file:
      r.export_id !== null && r.export_msg_id !== null && r.export_made_on !== null
        ? {
            export_id: r.export_id,
            format: r.export_format === "steps" ? "steps" : "sepa",
            msg_id: r.export_msg_id,
            made_on: r.export_made_on,
          }
        : null,
  }));
}

/**
 * The payments ready for the owner's bank, with their full details, for a
 * file or instructions: APPROVED proposals only, not marked paid, not
 * erased. Optionally narrowed to chosen ids (anything else in the list is
 * simply not ready, and is left out).
 */
export async function readyPayments(
  profileId: string,
  ids?: readonly string[],
): Promise<FilePayment[]> {
  const rows = await db
    .select(listColumns)
    .from(preparedPayments)
    .innerJoin(proposals, eq(proposals.id, preparedPayments.proposal_id))
    .where(
      and(
        eq(preparedPayments.profile_id, profileId),
        eq(proposals.profile_id, profileId),
        eq(proposals.status, "approved"),
        isNull(preparedPayments.paid_stated_at),
        isNull(preparedPayments.erased_at),
        ...(ids && ids.length > 0 ? [inArray(preparedPayments.id, [...ids])] : []),
      ),
    )
    .orderBy(asc(preparedPayments.execution_date), asc(preparedPayments.created_at));
  return rows.map((r) => ({
    id: r.id,
    proposal_status: r.status,
    approved_by: r.decided_by,
    paid: r.paid_stated_at !== null,
    payee_name: r.payee_name,
    payee_iban: r.payee_iban,
    payee_bic: r.payee_bic,
    amount: { amount_minor: r.amount_minor, currency: r.currency },
    reference: r.reference,
    execution_date: r.execution_date,
  }));
}

/**
 * The owner says they paid it in their own bank: approved → executed with
 * the statement as its result, the row marked, and an "execution" entry in
 * the owner's name, all in one transaction. Only a ready payment can be
 * marked, and only once.
 */
export async function markPaidInBank(args: {
  profileId: string;
  accountId: string;
  paymentId: string;
  userId: string;
  now?: Date;
}): Promise<void> {
  const at = (args.now ?? new Date()).toISOString();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(preparedPayments)
      .set({ paid_stated_at: at, paid_stated_by: args.userId })
      .where(
        and(
          eq(preparedPayments.id, args.paymentId),
          eq(preparedPayments.profile_id, args.profileId),
          isNull(preparedPayments.paid_stated_at),
          sql`exists (select 1 from ${proposals} where ${proposals.id} = ${preparedPayments.proposal_id} and ${proposals.status} = 'approved')`,
        ),
      )
      .returning({ proposal_id: preparedPayments.proposal_id });
    if (!row) {
      const [cur] = await tx
        .select({ id: preparedPayments.id })
        .from(preparedPayments)
        .where(
          and(
            eq(preparedPayments.id, args.paymentId),
            eq(preparedPayments.profile_id, args.profileId),
          ),
        );
      if (!cur) throw new PaymentDraftError("not_found", "no such payment", 404);
      throw new PaymentDraftError(
        "not_ready",
        "only an approved payment not yet marked paid can be marked paid",
        409,
      );
    }
    const result = {
      kind: "paid_in_own_bank",
      stated_by: args.userId,
      stated_at: at,
      source: "owner_input",
      note: "The owner made this payment in their own bank. SYB moved no money.",
    };
    const [p] = await tx
      .update(proposals)
      .set({ status: "executed", execution_result: sql`${JSON.stringify(result)}::jsonb` })
      .where(and(eq(proposals.id, row.proposal_id), eq(proposals.status, "approved")))
      .returning();
    if (!p) throw new PaymentDraftError("not_ready", "the approval changed under us", 409);
    await tx.insert(decisionLog).values({
      profile_id: args.profileId,
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
      event: "payment_marked_paid",
      account_id: args.accountId,
      profile_id: args.profileId,
      payment_id: args.paymentId,
    }),
  );
}

/* ── the paying side: stated once, superseded never overwritten ── */

export type PayerRefusal = "holder" | DraftRefusal;

/** A "pay from" statement: the debtor, which statement it is, and when it was made. */
export type StatedPayer = Debtor & { id: string; stated_at: string };

/** The current "pay from" details, or null when the owner hasn't stated them. */
export async function currentPayer(profileId: string): Promise<StatedPayer | null> {
  const [row] = await db
    .select({
      id: payerAccounts.id,
      holder_name: payerAccounts.holder_name,
      iban: payerAccounts.iban,
      bic: payerAccounts.bic,
      recorded_at: payerAccounts.recorded_at,
    })
    .from(payerAccounts)
    .where(and(eq(payerAccounts.profile_id, profileId), isNull(payerAccounts.superseded_at)));
  return row
    ? {
        id: row.id,
        holder_name: row.holder_name,
        iban: row.iban,
        bic: row.bic,
        stated_at: row.recorded_at,
      }
    : null;
}

/**
 * The owner states the bank details they pay from. The old statement is
 * superseded and kept (rule 3); the new one carries its source (rule 2);
 * the decision log gets a profile_change in the owner's name, same
 * transaction (rule 7).
 */
export async function statePayer(args: {
  profileId: string;
  accountId: string;
  holderName: string;
  iban: string;
  bic?: string | null;
  userId: string | null;
  now?: Date;
}): Promise<{ id: string; iban_masked: string }> {
  const holder = args.holderName.trim();
  if (holder === "" || holder.length > MAX_NAME) {
    throw new PaymentDraftError("name", "say the name your bank knows you by");
  }
  const iban = checkIban(args.iban);
  if (!iban.ok)
    throw new PaymentDraftError(
      `iban_${iban.reason}`,
      `that IBAN doesn't check out (${iban.reason})`,
    );
  let bic: string | null = null;
  if (typeof args.bic === "string" && args.bic.trim() !== "") {
    bic = checkBic(args.bic);
    if (bic === null)
      throw new PaymentDraftError("bic", "that BIC isn't eight or eleven letters and digits");
  }
  const at = (args.now ?? new Date()).toISOString();
  const newId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    const retired = await tx
      .update(payerAccounts)
      .set({ superseded_at: at })
      .where(and(eq(payerAccounts.profile_id, args.profileId), isNull(payerAccounts.superseded_at)))
      .returning({ id: payerAccounts.id });
    await tx.insert(payerAccounts).values({
      id: newId,
      profile_id: args.profileId,
      holder_name: holder,
      iban: iban.iban,
      bic,
      status: "answered",
      confidence: "0.750",
      source: { kind: "owner_input" },
      stated_by: args.userId,
      observed_at: at,
      recorded_at: at,
    });
    if (retired[0]) {
      await tx
        .update(payerAccounts)
        .set({ superseded_by: newId })
        .where(eq(payerAccounts.id, retired[0].id));
    }
    await tx.insert(decisionLog).values({
      profile_id: args.profileId,
      actor: "owner",
      kind: "profile_change",
      user_id: args.userId,
      ref_id: newId,
      payload_hash: createHash("sha256")
        .update(
          JSON.stringify({
            profile_id: args.profileId,
            record: "payer_account",
            holder_name: holder,
            iban: iban.iban,
            bic,
            source: { kind: "owner_input" },
            observed_at: at,
          }),
        )
        .digest("hex"),
    });
  });
  const masked = maskIban(iban.iban);
  console.log(
    JSON.stringify({
      event: "payer_stated",
      account_id: args.accountId,
      profile_id: args.profileId,
      iban: masked,
    }),
  );
  return { id: newId, iban_masked: masked };
}

/* ── erasure (rule 22): the payee's bank details go, the record of the payment stays ── */

const ERASED_PAYEE = "an erased payee";

/**
 * Erase the bank details of payments: by supplier (everything prepared for
 * that supplier) or by one payment. Name, IBAN and BIC become null on the
 * row, the proposal's words lose the name, and the decision log records the
 * fact of the erasure by ids and a count only — never what was erased.
 */
export async function eraseBankDetails(args: {
  profileId: string;
  accountId: string;
  userId: string | null;
  supplierId?: string;
  paymentId?: string;
  now?: Date;
}): Promise<number> {
  if (!args.supplierId === !args.paymentId) {
    throw new PaymentDraftError("not_found", "erase by a supplier or by one payment", 422);
  }
  const at = (args.now ?? new Date()).toISOString();
  const target = args.supplierId
    ? eq(preparedPayments.supplier_id, args.supplierId)
    : eq(preparedPayments.id, args.paymentId!);
  const count = await db.transaction(async (tx) => {
    const rows = await tx
      .update(preparedPayments)
      .set({ payee_name: null, payee_iban: null, payee_bic: null, erased_at: at })
      .where(
        and(
          eq(preparedPayments.profile_id, args.profileId),
          target,
          isNull(preparedPayments.erased_at),
        ),
      )
      .returning({ proposal_id: preparedPayments.proposal_id });
    const ids = rows.map((r) => r.proposal_id);
    if (ids.length > 0) {
      await tx
        .update(proposals)
        .set({
          action: sql`jsonb_set(jsonb_set(${proposals.action}, '{summary}', to_jsonb(${`Prepare a payment to ${ERASED_PAYEE} for your bank`}::text)), '{detail,payee}', to_jsonb(${ERASED_PAYEE}::text))`,
        })
        .where(inArray(proposals.id, ids));
    }
    await tx.insert(decisionLog).values({
      profile_id: args.profileId,
      actor: "owner",
      kind: "erasure",
      user_id: args.userId,
      ref_id: args.supplierId ?? args.paymentId!,
      payload_hash: createHash("sha256")
        .update(
          JSON.stringify({
            profile_id: args.profileId,
            erased: "payment_bank_details",
            by: args.supplierId ? "supplier" : "payment",
            ref: args.supplierId ?? args.paymentId,
            count: rows.length,
            at,
          }),
        )
        .digest("hex"),
    });
    return rows.length;
  });
  console.log(
    JSON.stringify({
      event: "payment_details_erased",
      account_id: args.accountId,
      profile_id: args.profileId,
      by: args.supplierId ? "supplier" : "payment",
      count,
    }),
  );
  return count;
}
