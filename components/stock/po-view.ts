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

type StateInput = Pick<PurchaseOrderView, "status" | "sent" | "sent_on" | "error"> &
  Partial<Pick<PurchaseOrderView, "held" | "needs_confirming" | "approved_on" | "by_hand_on">>;

/**
 * Where an order stands, in words: "emailed on 8 Nov 2026", "approved, held
 * until email is set up" (2026-11-09: held, not done), "approved on 1 Nov
 * 2026, waiting for your yes again", "sent by you on 9 Nov 2026".
 */
export function orderState(
  o: StateInput,
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
  if (o.by_hand_on) {
    return { word: tr("po.state.byHand", { day: dayMonthYear(o.by_hand_on, locale) }), tone: "ok" };
  }
  if (o.sent === false) return { word: tr("po.state.notSent"), tone: "alarm" };
  if (o.status === "approved" && o.needs_confirming && o.approved_on) {
    return {
      word: tr("po.state.needsConfirming", { day: dayMonthYear(o.approved_on, locale) }),
      tone: "alarm",
    };
  }
  if (o.status === "approved" && o.held && o.held.length > 0) {
    return { word: tr("po.state.held"), tone: "alarm" };
  }
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

/**
 * What the owner can do about an approved order that hasn't gone: held (why,
 * and that it goes out on its own once sending is on), or waiting for their
 * yes again after PO_APPROVAL_MAX_AGE_DAYS. Empty for any other order.
 */
export function waitingWords(
  o: Pick<PurchaseOrderView, "status" | "held" | "needs_confirming">,
  maxAgeDays: number,
  w: PoWords = ENGLISH(),
): string {
  if (o.status !== "approved") return "";
  const parts: string[] = [];
  if (o.held.length > 0) parts.push(notSentWords(o.held, w), w.tr("po.heldAfter"));
  if (o.needs_confirming) parts.push(w.tr("po.confirmAfter", { days: maxAgeDays }));
  return parts.join(" ");
}

/** A line's unit price on the order form, or that the supplier confirms it (decision 4). */
export function unitPriceText(
  unit: { amount_minor: number; currency: string } | null,
  w: PoWords = ENGLISH(),
): string {
  return unit ? totalsText([unit], w.locale) : w.tr("po.toConfirm");
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
