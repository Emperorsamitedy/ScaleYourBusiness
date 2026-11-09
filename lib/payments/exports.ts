// The files the owner downloads, kept as export batches — P6-05, the
// owner's decision of 2026-11-09 ("the best solution top businesses are
// currently doing"): repeated downloads must never pay a payment twice.
//
//   · A NEW file holds only ready payments (approved, not marked paid, not
//     erased) that were never in a file before, and records itself as a
//     batch: its id, its moment, who downloaded it, its message id. A
//     payment is in one file at most — payment_export_items holds a unique
//     index on the payment, so two downloads at the same moment can't both
//     take it (the second is refused, nothing written).
//   · DOWNLOAD AGAIN re-renders a batch from what it recorded — the same
//     payments in the same order, the same MsgId and CreDtTm, the "pay from"
//     statement it was made with (superseded statements are kept), the same
//     day — so the file is byte for byte the first one. A bank refuses a
//     pain.001 whose MsgId it has already seen, which is what stops a second
//     upload from paying twice. Its sha256 is checked against the first.
//   · The plain steps are tracked the same way. Nothing dedupes a payment
//     typed in by hand, so a copy of the steps says, first, that it is a copy.
//   · "Paid in my bank" stays per payment (./store markPaidInBank).
//
// No IBAN is kept on a batch: ids, counts and a digest. Nothing here moves
// money or talks to a bank (lib/payments/fence.test.ts).

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  payerAccounts,
  paymentExportItems,
  paymentExports,
  preparedPayments,
  proposals,
  users,
} from "../../db/schema";
import type { StepsWords } from "./instructions";
import { handInstructions } from "./instructions";
import type { Debtor, FilePayment } from "./sepa";
import { renderPain001, sepaBar } from "./sepa";
import { currentPayer, readyPayments } from "./store";

export type ExportFormat = "sepa" | "steps";

export type ExportRefusal =
  | "none_ready"
  | "all_in_file"
  | "no_payer"
  | "none_for_file"
  | "taken"
  | "no_such_file"
  | "file_erased";

export class ExportError extends Error {
  readonly code: ExportRefusal;
  readonly status: number;
  constructor(code: ExportRefusal, message: string, status = 409) {
    super(message);
    this.name = "ExportError";
    this.code = code;
    this.status = status;
  }
}

/** A file to hand to the owner, and the batch it belongs to. */
export interface ExportedFile {
  export_id: string;
  format: ExportFormat;
  msg_id: string;
  body: string;
  filename: string;
  content_type: string;
  count: number;
  /** Rule 1: a SEPA file's control sum in minor units of EUR; null for steps. */
  ctrl_sum_minor: number | null;
  /** True when this is a copy of a file downloaded before. */
  again: boolean;
  /** For a copy: whether it matched the first download's digest. */
  same_bytes: boolean;
}

/** One downloaded file, as the screen lists it. */
export interface ExportListing {
  id: string;
  format: ExportFormat;
  msg_id: string;
  created_at: string;
  /** YYYY-MM-DD. */
  made_on: string;
  /** Who downloaded it: their name on the team, else their email; null without a session. */
  by: string | null;
  count: number;
  /** How many of its payments are now marked paid in the owner's bank. */
  paid: number;
  /** Whether it can be downloaded again (no payment in it was erased). */
  again: boolean;
}

/** Pure: a message id unique per file — SYB, the moment, and a random tail (35 characters at most). */
export function fileMessageId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `SYB${stamp}${randomBytes(4).toString("hex").toUpperCase()}`;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Pure: the file's name, the same for the first download and every copy. */
export function exportFilename(format: ExportFormat, madeOn: string, msgId: string): string {
  return format === "sepa"
    ? `syb-sepa-${madeOn}-${msgId}.xml`
    : `syb-payments-${madeOn}-${msgId}.txt`;
}

const CONTENT_TYPE: Record<ExportFormat, string> = {
  sepa: "application/xml; charset=utf-8",
  steps: "text/plain; charset=utf-8",
};

interface RenderArgs {
  format: ExportFormat;
  payments: readonly FilePayment[];
  payer: Debtor | null;
  msgId: string;
  createdAt: string;
  madeOn: string;
  words: StepsWords;
}

/** Pure: the file's text from what a batch records. The same inputs give the same bytes. */
export function renderExport(a: RenderArgs): { body: string; ctrl_sum_minor: number | null } {
  if (a.format === "sepa") {
    if (a.payer === null) throw new ExportError("no_payer", "a SEPA file needs a payer");
    const file = renderPain001({
      debtor: a.payer,
      payments: a.payments,
      msg_id: a.msgId,
      created_at: a.createdAt,
      today: a.madeOn,
    });
    return { body: file.xml, ctrl_sum_minor: file.ctrl_sum_minor };
  }
  const bars = new Map(a.payments.map((p) => [p.id, sepaBar(p, a.payer)]));
  const head = a.words.tr("batch", { ref: a.msgId, date: a.madeOn });
  return {
    body: `${head}\n\n${handInstructions(a.payments, a.payer, a.words, bars)}`,
    ctrl_sum_minor: null,
  };
}

/** The ids, among these, that are already in a downloaded file. */
async function alreadyInFile(paymentIds: readonly string[]): Promise<Set<string>> {
  if (paymentIds.length === 0) return new Set();
  const rows = await db
    .select({ id: paymentExportItems.payment_id })
    .from(paymentExportItems)
    .where(inArray(paymentExportItems.payment_id, [...paymentIds]));
  return new Set(rows.map((r) => r.id));
}

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
};

/**
 * A new file: the ready payments not yet in any file (narrowed to `ids`
 * when given), rendered and recorded as one batch in one transaction.
 * SEPA takes those that can go in a SEPA file; the steps take every one.
 */
export async function exportNewFile(args: {
  profileId: string;
  accountId: string;
  format: ExportFormat;
  ids?: readonly string[];
  userId: string | null;
  words: StepsWords;
  now?: Date;
}): Promise<ExportedFile> {
  // Whole seconds: CreDtTm has none smaller, and the copy must say the same.
  const now = new Date(Math.floor((args.now ?? new Date()).getTime() / 1000) * 1000);
  const createdAt = now.toISOString();
  const madeOn = createdAt.slice(0, 10);
  const [payer, ready] = await Promise.all([
    currentPayer(args.profileId),
    readyPayments(args.profileId, args.ids),
  ]);
  if (ready.length === 0) {
    throw new ExportError(
      "none_ready",
      "nothing is ready for your bank: a payment needs approving first",
    );
  }
  let candidates = ready;
  if (args.format === "sepa") {
    if (payer === null) {
      throw new ExportError("no_payer", "a SEPA file needs the bank details you pay from");
    }
    candidates = ready.filter((p) => sepaBar(p, payer) === null);
    if (candidates.length === 0) {
      throw new ExportError(
        "none_for_file",
        "none of the ready payments can go in a SEPA file (euros between SEPA IBANs only)",
      );
    }
  }
  const taken = await alreadyInFile(candidates.map((p) => p.id));
  const chosen = candidates.filter((p) => !taken.has(p.id));
  if (chosen.length === 0) {
    throw new ExportError(
      "all_in_file",
      "every one of these payments is already in a file you downloaded: download that file again",
    );
  }
  const msgId = fileMessageId(now);
  const { body, ctrl_sum_minor } = renderExport({
    format: args.format,
    payments: chosen,
    payer,
    msgId,
    createdAt,
    madeOn,
    words: args.words,
  });
  let exportId: string;
  try {
    exportId = await db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(paymentExports)
        .values({
          profile_id: args.profileId,
          format: args.format,
          msg_id: msgId,
          created_at: createdAt,
          made_on: madeOn,
          created_by: args.userId,
          payer_account_id: payer?.id ?? null,
          locale: args.words.locale,
          nb_of_txs: chosen.length,
          ctrl_sum_minor,
          sha256: sha256(body),
        })
        .returning({ id: paymentExports.id });
      await tx.insert(paymentExportItems).values(
        chosen.map((p, i) => ({
          export_id: batch!.id,
          payment_id: p.id,
          position: i,
        })),
      );
      return batch!.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ExportError(
        "taken",
        "another download put some of these payments in a file just now: reload and look again",
      );
    }
    throw error;
  }
  console.log(
    JSON.stringify({
      event: "payments_export",
      account_id: args.accountId,
      profile_id: args.profileId,
      export_id: exportId,
      format: args.format,
      msg_id: msgId,
      count: chosen.length,
      ...(ctrl_sum_minor !== null ? { ctrl_sum_minor, currency: "EUR" } : {}),
    }),
  );
  return {
    export_id: exportId,
    format: args.format,
    msg_id: msgId,
    body,
    filename: exportFilename(args.format, madeOn, msgId),
    content_type: CONTENT_TYPE[args.format],
    count: chosen.length,
    ctrl_sum_minor,
    again: false,
    same_bytes: true,
  };
}

/**
 * Download again: the batch re-rendered from what it recorded, the same
 * MsgId and the same bytes. Refused when a payment in it was erased (the
 * details are gone for good, rule 22) or the batch is another business's.
 */
export async function exportAgain(args: {
  profileId: string;
  accountId: string;
  exportId: string;
  wordsFor: (locale: string) => Promise<StepsWords>;
}): Promise<ExportedFile> {
  const [batch] = await db
    .select()
    .from(paymentExports)
    .where(
      and(eq(paymentExports.id, args.exportId), eq(paymentExports.profile_id, args.profileId)),
    );
  if (!batch) throw new ExportError("no_such_file", "no such file", 404);
  const rows = await db
    .select({
      id: preparedPayments.id,
      payee_name: preparedPayments.payee_name,
      payee_iban: preparedPayments.payee_iban,
      payee_bic: preparedPayments.payee_bic,
      amount_minor: preparedPayments.amount_minor,
      currency: preparedPayments.currency,
      reference: preparedPayments.reference,
      execution_date: preparedPayments.execution_date,
      erased_at: preparedPayments.erased_at,
      decided_by: proposals.decided_by,
    })
    .from(paymentExportItems)
    .innerJoin(preparedPayments, eq(preparedPayments.id, paymentExportItems.payment_id))
    .innerJoin(proposals, eq(proposals.id, preparedPayments.proposal_id))
    .where(
      and(
        eq(paymentExportItems.export_id, batch.id),
        eq(preparedPayments.profile_id, args.profileId),
      ),
    )
    .orderBy(paymentExportItems.position);
  if (rows.length !== batch.nb_of_txs || rows.some((r) => r.erased_at !== null)) {
    throw new ExportError(
      "file_erased",
      "this file can't be made again: a payment in it had its bank details erased",
    );
  }
  let payer: Debtor | null = null;
  if (batch.payer_account_id !== null) {
    const [p] = await db
      .select({
        holder_name: payerAccounts.holder_name,
        iban: payerAccounts.iban,
        bic: payerAccounts.bic,
      })
      .from(payerAccounts)
      .where(
        and(
          eq(payerAccounts.id, batch.payer_account_id),
          eq(payerAccounts.profile_id, args.profileId),
        ),
      );
    payer = p ?? null;
  }
  // As they were when the file was made: approved, by the person who
  // approved them, not yet marked paid. A copy is the same file, not a new one.
  const payments: FilePayment[] = rows.map((r) => ({
    id: r.id,
    proposal_status: "approved",
    approved_by: r.decided_by,
    paid: false,
    payee_name: r.payee_name,
    payee_iban: r.payee_iban,
    payee_bic: r.payee_bic,
    amount: { amount_minor: r.amount_minor, currency: r.currency },
    reference: r.reference,
    execution_date: r.execution_date,
  }));
  const format: ExportFormat = batch.format === "steps" ? "steps" : "sepa";
  const words = await args.wordsFor(batch.locale);
  const { body } = renderExport({
    format,
    payments,
    payer,
    msgId: batch.msg_id,
    createdAt: new Date(batch.created_at).toISOString(),
    madeOn: batch.made_on,
    words,
  });
  const same = sha256(body) === batch.sha256;
  console.log(
    JSON.stringify({
      event: "payments_export_again",
      account_id: args.accountId,
      profile_id: args.profileId,
      export_id: batch.id,
      format,
      msg_id: batch.msg_id,
      count: payments.length,
      same_bytes: same,
    }),
  );
  const out = format === "steps" ? `${words.tr("copy", { date: batch.made_on })}\n\n${body}` : body;
  return {
    export_id: batch.id,
    format,
    msg_id: batch.msg_id,
    body: out,
    filename: exportFilename(format, batch.made_on, batch.msg_id),
    content_type: CONTENT_TYPE[format],
    count: payments.length,
    ctrl_sum_minor: batch.ctrl_sum_minor,
    again: true,
    same_bytes: same,
  };
}

/** The business's downloaded files, newest first, with how many of each are paid. */
export async function listExports(profileId: string, limit = 50): Promise<ExportListing[]> {
  const batches = await db
    .select({
      id: paymentExports.id,
      format: paymentExports.format,
      msg_id: paymentExports.msg_id,
      created_at: paymentExports.created_at,
      made_on: paymentExports.made_on,
      nb_of_txs: paymentExports.nb_of_txs,
      display_name: users.display_name,
      email: users.email,
    })
    .from(paymentExports)
    .leftJoin(users, eq(users.id, paymentExports.created_by))
    .where(eq(paymentExports.profile_id, profileId))
    .orderBy(desc(paymentExports.created_at))
    .limit(limit);
  if (batches.length === 0) return [];
  const items = await db
    .select({
      export_id: paymentExportItems.export_id,
      paid_stated_at: preparedPayments.paid_stated_at,
      erased_at: preparedPayments.erased_at,
    })
    .from(paymentExportItems)
    .innerJoin(preparedPayments, eq(preparedPayments.id, paymentExportItems.payment_id))
    .where(
      inArray(
        paymentExportItems.export_id,
        batches.map((b) => b.id),
      ),
    );
  return batches.map((b) => {
    const mine = items.filter((i) => i.export_id === b.id);
    return {
      id: b.id,
      format: b.format === "steps" ? "steps" : "sepa",
      msg_id: b.msg_id,
      created_at: new Date(b.created_at).toISOString(),
      made_on: b.made_on,
      by: b.display_name ?? b.email ?? null,
      count: b.nb_of_txs,
      paid: mine.filter((i) => i.paid_stated_at !== null).length,
      again: mine.length === b.nb_of_txs && mine.every((i) => i.erased_at === null),
    };
  });
}
