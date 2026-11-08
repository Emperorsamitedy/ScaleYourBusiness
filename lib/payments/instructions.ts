// Plain step-by-step instructions for prepared payments — P6-05. Pure: the
// text a person follows in their own bank, for any currency, and the steps
// for uploading a SEPA file. SYB moves no money; these words say so.
//
// L-4b: the words come from messages/<locale>.json ("payments.steps"),
// English by default; figures are formatted, never typed into a message.

import type { Money } from "../core/money";
import { format } from "../core/money";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
import { groupIban } from "./iban";
import type { Debtor, FilePayment, SepaBar } from "./sepa";

export interface StepsWords {
  tr: Tr;
  locale: string;
}

const ENGLISH = (): StepsWords => ({ tr: englishTr("payments.steps"), locale: "en" });

const numbered = (lines: readonly string[]) => lines.map((l, i) => `${i + 1}. ${l}`);

/** Pure: an amount as the reader's locale writes it, its currency named. */
export function amountWords(m: Money, locale: string): string {
  try {
    return format(m, locale);
  } catch {
    return format(m, "en");
  }
}

/** Pure: the steps for entering payments by hand, then each payment's details. */
export function handInstructions(
  payments: readonly FilePayment[],
  debtor: Debtor | null,
  w: StepsWords = ENGLISH(),
  bars: ReadonlyMap<string, SepaBar | null> = new Map(),
): string {
  const { tr } = w;
  const out: string[] = [tr("title"), "", tr("intro"), ""];
  if (debtor) out.push(tr("from", { name: debtor.holder_name, iban: groupIban(debtor.iban) }), "");
  out.push(tr("howTitle"));
  out.push(
    ...numbered([
      tr("hand.open"),
      tr("hand.copy"),
      tr("hand.amount"),
      tr("hand.confirm"),
      tr("hand.mark"),
    ]),
  );
  payments.forEach((p, i) => {
    out.push("", tr("paymentTitle", { n: i + 1, count: payments.length }));
    if (p.payee_iban === null || p.payee_name === null) {
      out.push(tr("erased"));
      return;
    }
    out.push(tr("payTo", { name: p.payee_name }));
    out.push(tr("iban", { iban: groupIban(p.payee_iban) }));
    if (p.payee_bic) out.push(tr("bic", { bic: p.payee_bic }));
    out.push(tr("amount", { amount: amountWords(p.amount, w.locale) }));
    out.push(tr("reference", { reference: p.reference }));
    out.push(tr("date", { date: p.execution_date }));
    const bar = bars.get(p.id);
    if (bar === "not_eur") out.push(tr("why.notEur"));
    else if (bar === "payee_not_sepa" || bar === "payer_not_sepa") out.push(tr("why.notSepa"));
  });
  out.push("", tr("closing"));
  return `${out.join("\n")}\n`;
}

/** Pure: the steps for uploading a SEPA file to the owner's own bank. */
export function fileInstructions(
  fileName: string,
  count: number,
  w: StepsWords = ENGLISH(),
): string[] {
  const { tr } = w;
  return numbered([
    tr("file.save", { file: fileName }),
    tr("file.find"),
    tr("file.upload", { count }),
    tr("file.confirm"),
    tr("file.mark"),
  ]);
}
