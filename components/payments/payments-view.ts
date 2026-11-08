// The payments screen's pure helpers — P6-05. Grouping by stage, the words
// for a stage and for a file's "why not", a refusal code into words, and an
// amount as typed into exact minor units (rule 1). No React, so the tests
// hold them without a browser.

import type { PaymentRow } from "../../app/api/payments/route";
import type { Money } from "../../lib/core/money";
import { format, parseMoneyMinor } from "../../lib/core/money";
import type { Tr } from "../../lib/i18n/tr";

export interface PaymentGroups {
  ready: PaymentRow[];
  waiting: PaymentRow[];
  closed: PaymentRow[];
}

/** Pure: ready for the bank, waiting for a decision, and the rest (paid, declined, lapsed). */
export function groupPayments(rows: readonly PaymentRow[]): PaymentGroups {
  const out: PaymentGroups = { ready: [], waiting: [], closed: [] };
  for (const r of rows) {
    if (r.stage === "ready") out.ready.push(r);
    else if (r.stage === "waiting" || r.stage === "blocked" || r.stage === "changes") {
      out.waiting.push(r);
    } else out.closed.push(r);
  }
  // Ready ones in the order they're due.
  out.ready.sort((a, b) => a.execution_date.localeCompare(b.execution_date));
  return out;
}

/** Pure: the stage in words. */
export function stageWord(row: Pick<PaymentRow, "stage">, tr: Tr): string {
  return tr(`stage.${row.stage}`);
}

/** Pure: whether the row can go in a SEPA file, or why not, in words. */
export function fileWord(row: Pick<PaymentRow, "file_bar">, tr: Tr): string {
  return row.file_bar === null ? tr("file.yes") : tr(`file.bar.${row.file_bar}`);
}

const REFUSALS = new Set([
  "iban_empty",
  "iban_format",
  "iban_country",
  "iban_length",
  "iban_checksum",
  "bic",
  "name",
  "amount",
  "currency",
  "reference",
  "date",
  "date_past",
  "date_far",
  "pays_kind",
  "supplier",
  "cost_item",
  "purchase_order",
  "not_found",
  "not_ready",
  "no_session",
  "none_ready",
  "no_payer",
  "none_for_file",
]);

/** Pure: a refusal from the server in the reader's words; its own text when it has no code. */
export function refusalWords(body: { error?: unknown; code?: unknown }, tr: Tr): string {
  if (typeof body.code === "string" && REFUSALS.has(body.code)) return tr(`refusal.${body.code}`);
  return typeof body.error === "string" ? body.error : tr("error.generic");
}

/** Pure: an amount as typed ("1 234,50", "61.00") → exact minor units, or null. */
export function amountToMinor(raw: string, currency: string): number | null {
  const c = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return null;
  const minor = parseMoneyMinor(raw, c);
  return minor !== null && minor > 0 ? minor : null;
}

/** Pure: Money in the reader's locale. */
export function moneyText(m: Money, locale: string): string {
  try {
    return format(m, locale);
  } catch {
    return `${m.amount_minor} ${m.currency}`;
  }
}

/** Pure: the sum of ready euro payments that can go in a file, in minor units (rule 1: integers only). */
export function fileTotalMinor(rows: readonly PaymentRow[]): number {
  return rows
    .filter((r) => r.stage === "ready" && r.file_bar === null && r.amount.currency === "EUR")
    .reduce((sum, r) => sum + r.amount.amount_minor, 0);
}
