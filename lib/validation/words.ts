// A validation finding's sentence in the reader's language — L-4a of
// TASKS-LANGUAGES.md.
//
// A finding is stored as the rule wrote it: message.en, and since L-4a the
// figures beside it (message.args). The reconcile panel reads it here: the
// "validationWords" message for its rule, with the figures formatted the
// reader's way and the money in its own currency, never converted (rule 1).
// English, and a finding stored before its figures were, print the stored
// English. Pure.

import { minorUnitExponent } from "../core/money";
import { intlMoney, intlNumber } from "../i18n/format";
import type { AppLocale } from "../i18n/locales";
import type { Tr } from "../i18n/tr";

/** The rules whose sentence has no figure in it. */
const STATIC = new Set([
  "inventory_without_supplier",
  "channel_without_revenue",
  "key_person_undocumented",
  "stage_vs_revenue",
  "single_supplier_top_offer",
]);

/** The figures each parametric rule's sentence needs. */
const NEEDS: Record<string, readonly string[]> = {
  margin_mismatch: ["stated", "computed"],
  revenue_vs_offers: ["stated", "sum"],
  costs_exceed_revenue: ["total", "revenue"],
  stale_financials: ["days"],
};

interface MoneyArg {
  amount_minor: number;
  currency: string;
}

const isMoney = (v: unknown): v is MoneyArg =>
  typeof v === "object" &&
  v !== null &&
  Number.isSafeInteger((v as MoneyArg).amount_minor) &&
  typeof (v as MoneyArg).currency === "string";

/** Pure: a stored finding's sentence in `locale`, given a translator over "validationWords". */
export function findingWords(
  ruleId: string,
  message: { en?: unknown; args?: unknown } | null | undefined,
  tr: Tr,
  locale: AppLocale,
): string {
  const english = typeof message?.en === "string" ? message.en.trim() : "";
  if (locale === "en") return english;
  if (STATIC.has(ruleId)) return tr(ruleId);
  const needs = NEEDS[ruleId];
  const args = message?.args;
  if (!needs || typeof args !== "object" || args === null) return english;
  const values: Record<string, string | number> = {};
  for (const name of needs) {
    const v = (args as Record<string, unknown>)[name];
    if (isMoney(v)) {
      const exp = minorUnitExponent(v.currency);
      values[name] = intlMoney(v.amount_minor / 10 ** exp, v.currency, 0, locale);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      // A count is passed as a number so a plural can agree with it.
      values[name] = name === "days" ? v : intlNumber(v, 0, locale);
    } else return english;
  }
  return tr(ruleId, values);
}
