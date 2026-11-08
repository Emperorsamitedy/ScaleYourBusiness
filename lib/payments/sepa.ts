// The SEPA credit-transfer file — P6-05 (rule 26 amended). Pure: from
// approved payments and the owner's own stated bank details, the text of a
// pain.001.001.03 file the owner uploads to their own bank. SYB writes a
// file; it never sends one anywhere, and nothing here can.
//
// The rules a file keeps:
//   · Only APPROVED, not-yet-paid payments go in (rule 12). The loader
//     selects them that way and this renderer refuses anything else, so an
//     unapproved payment can't reach a file by either door.
//   · EUR only: SEPA is a euro scheme. Both IBANs' countries must be SEPA's.
//     Anything else gets the plain instructions instead (./instructions).
//   · Money stays integer (rule 1): CtrlSum is the sum of amount_minor,
//     printed from its digits by toDecimalString, never added as floats.
//   · One PmtInf per requested execution date (the date is a PmtInf field);
//     GrpHdr counts and sums them all.
//   · Text fields use the SEPA character set (Latin letters, digits and
//     / - ? : ( ) . , ' + space) and their maximum lengths.

import type { Money } from "../core/money";
import { money, toDecimalString } from "../core/money";
import { SEPA_COUNTRIES, SEPA_NON_EEA, checkIban } from "./iban";

export const PAIN_001_NAMESPACE = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03";
export const PAIN_001_VERSION = "pain.001.001.03";

/** The business's own bank details, as the owner stated them. */
export interface Debtor {
  holder_name: string;
  iban: string;
  bic: string | null;
}

/** A payment that may go into a file: approved by a named person, not marked paid. */
export interface FilePayment {
  id: string;
  proposal_status: string;
  approved_by: string | null;
  paid: boolean;
  payee_name: string | null;
  payee_iban: string | null;
  payee_bic: string | null;
  amount: Money;
  reference: string;
  /** YYYY-MM-DD. */
  execution_date: string;
}

export class SepaFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SepaFileError";
  }
}

/** Why a payment can't go in a SEPA file (it still gets instructions), or null when it can. */
export type SepaBar =
  | "not_approved"
  | "paid"
  | "erased"
  | "not_eur"
  | "payee_not_sepa"
  | "payer_not_sepa"
  | "no_payer"
  | "name_not_latin"
  | "bic_needed";

/** A letter of a script other than Latin (Greek, Cyrillic, Han…): the SEPA set has no fold for it. */
const NOT_LATIN = /(?=\p{L})\P{Script=Latin}/u;

/**
 * Pure: whether a name can be written in the SEPA set without losing it —
 * Latin letters (accents fold), and something left once folded. "Παπαδόπουλος
 * ΑΕ" or "ООО Ромашка" would fold to nothing, or to the digits alone: an
 * empty <Nm> the bank refuses, or a payee it can't match.
 */
function latinName(raw: string): boolean {
  return !NOT_LATIN.test(raw) && sepaText(raw, 70) !== "";
}

/** Pure: whether a payment can go into a SEPA file with this debtor. */
export function sepaBar(p: FilePayment, debtor: Debtor | null): SepaBar | null {
  if (p.proposal_status !== "approved" || p.approved_by === null) return "not_approved";
  if (p.paid) return "paid";
  if (p.payee_iban === null || p.payee_name === null) return "erased";
  if (p.amount.currency !== "EUR") return "not_eur";
  const payee = checkIban(p.payee_iban);
  if (!payee.ok || !SEPA_COUNTRIES.has(payee.country)) return "payee_not_sepa";
  if (debtor === null) return "no_payer";
  const payer = checkIban(debtor.iban);
  if (!payer.ok || !SEPA_COUNTRIES.has(payer.country)) return "payer_not_sepa";
  if (!latinName(p.payee_name) || !latinName(debtor.holder_name) || NOT_LATIN.test(p.reference)) {
    return "name_not_latin";
  }
  if (!p.payee_bic && (SEPA_NON_EEA.has(payee.country) || SEPA_NON_EEA.has(payer.country))) {
    return "bic_needed";
  }
  return null;
}

const FOLD: Readonly<Record<string, string>> = {
  ß: "ss",
  Æ: "AE",
  æ: "ae",
  Ø: "O",
  ø: "o",
  Œ: "OE",
  œ: "oe",
  Ł: "L",
  ł: "l",
  Đ: "D",
  đ: "d",
  Ð: "D",
  ð: "d",
  Þ: "Th",
  þ: "th",
  "&": "+",
  "’": "'",
  "‘": "'",
  "–": "-",
  "—": "-",
};

/**
 * Pure: text in the SEPA Latin character set, trimmed to `max`. Accents are
 * folded ("Müller" → "Muller"), anything else outside the set becomes a
 * space, and runs of spaces close up. What's left is also XML-safe.
 */
export function sepaText(raw: string, max: number): string {
  const folded = [...raw.normalize("NFD")]
    .map((c) => FOLD[c] ?? c)
    .join("")
    .replace(/[̀-ͯ]/g, "");
  const kept = folded.replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, " ");
  return kept.replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** Pure: an identifier field (MsgId, PmtInfId, EndToEndId): no spaces, at most 35. */
export function sepaId(raw: string): string {
  return sepaText(raw, 70).replace(/[ ]/g, "").slice(0, 35);
}

/** Pure: an integer sum of minor units, refusing anything that isn't (rule 1). */
export function sumMinor(amounts: readonly Money[]): number {
  let total = 0;
  for (const a of amounts) {
    const m = money(a.amount_minor, a.currency);
    total += m.amount_minor;
    if (!Number.isSafeInteger(total)) throw new SepaFileError("the total is too large to write");
  }
  return total;
}

/** Pure: the decimal a file shows for minor units of EUR, built from the digits. */
export function eurDecimal(minor: number): string {
  return toDecimalString({ amount_minor: minor, currency: "EUR" });
}

export interface RenderInput {
  debtor: Debtor;
  payments: readonly FilePayment[];
  /** Unique per file; 35 characters at most. */
  msg_id: string;
  /** When the file was made (ISO). */
  created_at: string;
  /** Today, YYYY-MM-DD: a requested date already past goes out as today. */
  today: string;
}

export interface RenderedFile {
  xml: string;
  msg_id: string;
  nb_of_txs: number;
  /** Rule 1: the file's control sum in minor units, the integer it was printed from. */
  ctrl_sum_minor: number;
  /** The payments in the file, by id, in file order. */
  payment_ids: string[];
  /** Payments whose date had passed and went out as today. */
  moved_to_today: string[];
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Pure: the pain.001.001.03 file for these payments. Throws (and writes
 * nothing) when any payment may not be in a SEPA file: the caller chooses
 * the payments, and a wrong choice is a refusal, never a quiet omission.
 */
export function renderPain001(input: RenderInput): RenderedFile {
  if (input.payments.length === 0) throw new SepaFileError("no payments to put in a file");
  const debtorIban = checkIban(input.debtor.iban);
  if (!debtorIban.ok) throw new SepaFileError("the paying IBAN isn't a valid IBAN");
  for (const p of input.payments) {
    const bar = sepaBar(p, input.debtor);
    if (bar !== null) throw new SepaFileError(`payment ${p.id} can't go in a SEPA file: ${bar}`);
  }
  const msgId = sepaId(input.msg_id);
  if (msgId === "") throw new SepaFileError("the file needs a message id");

  // One PmtInf per execution date, dates in order, payments in given order.
  const byDate = new Map<string, FilePayment[]>();
  const moved: string[] = [];
  for (const p of input.payments) {
    const date = p.execution_date < input.today ? input.today : p.execution_date;
    if (date !== p.execution_date) moved.push(p.id);
    const list = byDate.get(date) ?? [];
    list.push(p);
    byDate.set(date, list);
  }
  const dates = [...byDate.keys()].sort();

  const total = sumMinor(input.payments.map((p) => p.amount));
  const createdAt = input.created_at.replace(/\.\d+Z$/, "").replace(/Z$/, "");
  const debtorName = sepaText(input.debtor.holder_name, 70);
  const lines: string[] = [];
  const out = (depth: number, s: string) => lines.push(`${"  ".repeat(depth)}${s}`);

  out(0, '<?xml version="1.0" encoding="UTF-8"?>');
  out(0, `<Document xmlns="${PAIN_001_NAMESPACE}">`);
  out(1, "<CstmrCdtTrfInitn>");
  out(2, "<GrpHdr>");
  out(3, `<MsgId>${esc(msgId)}</MsgId>`);
  out(3, `<CreDtTm>${esc(createdAt)}</CreDtTm>`);
  out(3, `<NbOfTxs>${input.payments.length}</NbOfTxs>`);
  out(3, `<CtrlSum>${eurDecimal(total)}</CtrlSum>`);
  out(3, `<InitgPty><Nm>${esc(debtorName)}</Nm></InitgPty>`);
  out(2, "</GrpHdr>");

  const order: string[] = [];
  dates.forEach((date, i) => {
    const group = byDate.get(date)!;
    const groupSum = sumMinor(group.map((p) => p.amount));
    out(2, "<PmtInf>");
    out(3, `<PmtInfId>${esc(sepaId(`${msgId}-${i + 1}`))}</PmtInfId>`);
    out(3, "<PmtMtd>TRF</PmtMtd>");
    out(3, "<BtchBookg>true</BtchBookg>");
    out(3, `<NbOfTxs>${group.length}</NbOfTxs>`);
    out(3, `<CtrlSum>${eurDecimal(groupSum)}</CtrlSum>`);
    out(3, "<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>");
    out(3, `<ReqdExctnDt>${esc(date)}</ReqdExctnDt>`);
    out(3, `<Dbtr><Nm>${esc(debtorName)}</Nm></Dbtr>`);
    out(3, `<DbtrAcct><Id><IBAN>${debtorIban.iban}</IBAN></Id></DbtrAcct>`);
    out(
      3,
      input.debtor.bic
        ? `<DbtrAgt><FinInstnId><BIC>${esc(input.debtor.bic)}</BIC></FinInstnId></DbtrAgt>`
        : "<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>",
    );
    out(3, "<ChrgBr>SLEV</ChrgBr>");
    for (const p of group) {
      const payee = checkIban(p.payee_iban!);
      if (!payee.ok) throw new SepaFileError(`payment ${p.id} has no valid IBAN`);
      order.push(p.id);
      out(3, "<CdtTrfTxInf>");
      out(4, `<PmtId><EndToEndId>${esc(sepaId(p.id.replace(/-/g, "")))}</EndToEndId></PmtId>`);
      out(4, `<Amt><InstdAmt Ccy="EUR">${eurDecimal(p.amount.amount_minor)}</InstdAmt></Amt>`);
      if (p.payee_bic) {
        out(4, `<CdtrAgt><FinInstnId><BIC>${esc(p.payee_bic)}</BIC></FinInstnId></CdtrAgt>`);
      }
      out(4, `<Cdtr><Nm>${esc(sepaText(p.payee_name!, 70))}</Nm></Cdtr>`);
      out(4, `<CdtrAcct><Id><IBAN>${payee.iban}</IBAN></Id></CdtrAcct>`);
      const ustrd = sepaText(p.reference, 140);
      if (ustrd !== "") out(4, `<RmtInf><Ustrd>${esc(ustrd)}</Ustrd></RmtInf>`);
      out(3, "</CdtTrfTxInf>");
    }
    out(2, "</PmtInf>");
  });

  out(1, "</CstmrCdtTrfInitn>");
  out(0, "</Document>");
  return {
    xml: `${lines.join("\n")}\n`,
    msg_id: msgId,
    nb_of_txs: input.payments.length,
    ctrl_sum_minor: total,
    payment_ids: order,
    moved_to_today: moved,
  };
}
