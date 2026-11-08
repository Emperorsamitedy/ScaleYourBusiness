// The purchase-order words on /stock — P6-04. Pure, so they are tested
// without a browser (po-view.test.ts). The fixed words are the "stock"
// catalogue's `po` keys through an optional translator, English by default;
// figures and days in the reader's locale. The server sends codes (a status,
// the reasons an order wasn't really sent); nothing here shows a code.

import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import { dayMonthYear } from "../../lib/i18n/format";
import type { PurchaseOrderView } from "../../lib/purchasing/send";
import type { NotSentReason } from "../../lib/purchasing/po";
import { moneyExact } from "../sheet/num";

export interface PoWords {
  tr: Tr;
  locale: AppLocale;
}
const ENGLISH = (): PoWords => ({ tr: englishTr("stock"), locale: "en" });

const STATES = new Set([
  "pending",
  "approved",
  "rejected",
  "expired",
  "blocked",
  "changes_requested",
  "executed",
]);

/** Where an order stands, in words: "emailed on 8 Nov 2026", "ready, not sent". */
export function orderState(
  o: Pick<PurchaseOrderView, "status" | "sent" | "sent_on" | "error">,
  w: PoWords = ENGLISH(),
): { word: string; tone: "ok" | "alarm" | "none" } {
  const { tr, locale } = w;
  if (o.sent === true) {
    return {
      word: o.sent_on
        ? tr("po.state.sent", { day: dayMonthYear(o.sent_on, locale) })
        : tr("po.state.executed"),
      tone: "ok",
    };
  }
  if (o.sent === false) return { word: tr("po.state.notSent"), tone: "alarm" };
  if (o.status === "approved" && o.error) return { word: tr("po.state.failed"), tone: "alarm" };
  if (STATES.has(o.status)) {
    return {
      word: tr(`po.state.${o.status}`),
      tone:
        o.status === "pending" || o.status === "approved"
          ? "ok"
          : o.status === "blocked"
            ? "alarm"
            : "none",
    };
  }
  return { word: tr("po.state.pending"), tone: "none" };
}

/** Why an approved order isn't really emailed, each reason as a sentence. */
export function notSentWords(reasons: readonly NotSentReason[], w: PoWords = ENGLISH()): string {
  return reasons.map((r) => w.tr(`po.why.${r}`)).join(" ");
}

/** The order's totals, one per currency: "€490.00 + 12 000 HUF"; "—" with none. */
export function totalsText(
  totals: readonly { amount_minor: number; currency: string }[],
  locale: AppLocale = "en",
): string {
  return totals.length === 0
    ? "—"
    : totals.map((t) => moneyExact(t.amount_minor, t.currency, locale)).join(" + ");
}
