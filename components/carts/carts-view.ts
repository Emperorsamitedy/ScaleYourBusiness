// The carts screen's words — idea 47. Pure, so they are tested without a
// browser (carts-view.test.ts). Plain words, en-GB days ("6 Nov"), never an
// ISO date or a rule number, and never a shopper: every line is a count.
//
// L-3b: the fixed words (titles, status words, "and") are the "carts"
// catalogue through optional words, English by default; money and shares
// in the reader's locale. The sentences built from the counts (headline,
// window line, consent and checkout notes, the week line, why proposing is
// off, the sources line) stay English until L-4.

import type { CartsScreenView } from "../../app/api/carts/route";
import type { CartReach, Money, WindowStats } from "../../lib/carts/measure";
import type { CartShopperRead } from "../../lib/connectors/provider";
import { dayWords } from "../../lib/carts/measure";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import { percentText } from "../cash/cash-view";
import { moneyText, num } from "../sheet/num";

/** The screen's words and the reader's locale: the "carts" catalogue. */
export interface CartsWords {
  tr: Tr;
  locale: AppLocale;
}
const ENGLISH = (): CartsWords => ({ tr: englishTr("carts"), locale: "en" });

export type Measured = Extract<NonNullable<CartsScreenView["measure"]>, { status: "measured" }>;

const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/** "€1,240", or "€1,240 and £80" — currencies side by side, never added. */
export function moneyList(list: readonly Money[], w: CartsWords = ENGLISH()): string {
  const parts = list.map((m) => moneyText(m.amount_minor, m.currency, w.locale));
  return parts.length <= 1
    ? (parts[0] ?? moneyText(0, "EUR", w.locale))
    : w.tr("view.and", { first: parts.slice(0, -1).join(", "), last: parts.at(-1)! });
}

/** The screen's one display line. */
export function cartsHeadline(view: CartsScreenView): string {
  if (!view.applies) return "Abandoned carts need a connected Shopify shop.";
  const read = (view.sources ?? []).some((s) => s.read_at !== null);
  const m = view.measure;
  if (!m || (!read && m.status === "refused")) return "I haven't read your carts yet.";
  // Review 2026-10-30: a stale or partial read says so, not "too early".
  if (m.status === "refused" && m.basis === "too_many") {
    return "Too many checkouts to read in full.";
  }
  if (m.status === "refused" && m.basis === "stale") return "Your carts haven't been read lately.";
  if (m.status === "refused") return "Too early to measure your abandoned carts.";
  const days = view.thresholds?.window_days ?? 30;
  const value = m.current.value_left.filter((v) => v.amount_minor > 0);
  const left =
    value.length === 0
      ? `${plural(m.current.left, "cart was", "carts were")} left in the last ${days} days`
      : `${moneyList(value)} was left in carts in the last ${days} days`;
  return `${left}; ${num(m.reach.emailable_shoppers)} of the ${plural(m.reach.shoppers, "shopper")} can be emailed.`;
}

/** The refusal card's title. */
export function refusalTitle(m: CartsScreenView["measure"], tr: Tr = ENGLISH().tr): string {
  if (m?.status === "refused" && m.basis === "too_many") return tr("view.titleTooMany");
  if (m?.status === "refused" && m.basis === "stale") return tr("view.titleStale");
  return tr("view.titleTooFew");
}

/** The share left, as a whole percent, or null when orders weren't measured. */
export function shareText(w: WindowStats, locale: AppLocale = "en"): string | null {
  return w.share_left === null ? null : percentText(Math.round(w.share_left * 100), locale);
}

/** The mono line under the head: the window and what it is set against. */
export function windowLine(m: Measured): string {
  const c = m.current;
  const share = shareText(c);
  const now = `${dayWords(c.from)} to ${dayWords(c.to)}: ${plural(c.started, "checkout")} started, ${num(c.left)} left, ${num(c.recovered)} finished later${share ? `; ${share} of all checkouts left unfinished` : ""}.`;
  if (!m.prior) return `${now} ${m.prior_note ?? ""}`.trim();
  const p = m.prior;
  const pShare = shareText(p);
  return `${now} The 30 days before: ${num(p.left)} left (${moneyList(p.value_left)})${pShare ? `, ${pShare} of checkouts` : ""}.`;
}

/** I-47b: why a cart carries no email, by whether the store's last read had the shopper. */
const NO_EMAIL_WHY: Record<CartShopperRead | "unknown", string> = {
  read: "The checkout had no customer email: a draft order, or one made by an app.",
  not_granted:
    "Shopify only says who left a cart to an app that may read your customers. Add read_customers to the app in Shopify's Dev Dashboard, release it, and connect again.",
  refused:
    "The app has read_customers, but Shopify still withheld customer details. In the app's Dev Dashboard, allow access to customer data (email), release it, and the next sync matches carts.",
  unknown:
    "Shopify only says who left a cart to an app that may read your customers (read_customers).",
};

const NOTE: Record<
  Exclude<CartReach, "emailable">,
  (n: string, one: boolean, shopper: CartShopperRead | "unknown") => string
> = {
  no_email: (n, one, shopper) =>
    `${n} ${one ? "cart carries" : "carts carry"} no email I can read, so ${one ? "it isn't" : "they aren't"} matched to anyone. ${NO_EMAIL_WHY[shopper]}`,
  not_contact: (n, one) =>
    `${n} ${one ? "cart is" : "carts are"} from shoppers who aren't among your contacts, so ${one ? "it isn't" : "they aren't"} emailed.`,
  no_consent: (n, one) =>
    `${n} ${one ? "cart is" : "carts are"} from contacts with no recorded yes to email, so ${one ? "it isn't" : "they aren't"} emailed.`,
  suppressed: (n, one) =>
    `${n} ${one ? "cart is from someone" : "carts are from people"} who unsubscribed or asked to be forgotten, so ${one ? "it isn't" : "they aren't"} emailed.`,
};

/**
 * The consent notes: who can't be emailed, counted, in words. Never an
 * address. `shopper` is the store's last read (I-47b); null when unknown.
 */
export function consentNotes(m: Measured, shopper: CartShopperRead | null = null): string[] {
  const out: string[] = [];
  const yes = m.reach.carts.emailable;
  if (yes > 0) {
    out.push(
      `${num(yes)} ${yes === 1 ? "cart is" : "carts are"} from contacts who said yes to email.`,
    );
  }
  for (const k of ["no_consent", "not_contact", "suppressed", "no_email"] as const) {
    const n = m.reach.carts[k];
    if (n > 0) out.push(NOTE[k](num(n), n === 1, shopper ?? "unknown"));
  }
  return out;
}

/**
 * I-47a/I-47c: what Shopify's checkout tick did to the contacts, in words,
 * or nothing when it did nothing. Counts only.
 */
export function checkoutConsentNotes(view: CartsScreenView): string[] {
  const c = view.checkout_consent;
  if (!c) return [];
  const out: string[] = [];
  if (c.said_yes > 0) {
    out.push(
      `${num(c.said_yes)} ${c.said_yes === 1 ? "contact" : "contacts"} said yes to email at Shopify's checkout, recorded with when they did. If they unsubscribe in Shopify, I stop emailing them.`,
    );
  }
  if (c.withdrawn > 0) {
    out.push(
      `${num(c.withdrawn)} ${c.withdrawn === 1 ? "contact" : "contacts"} you recorded as a yes later unsubscribed in Shopify, so I no longer email them.`,
    );
  }
  if (c.differs !== null && c.differs > 0) {
    out.push(
      `Shopify lists ${num(c.differs)} ${c.differs === 1 ? "contact" : "contacts"} as subscribed whom you recorded differently. I left ${c.differs === 1 ? "that answer" : "those answers"} as you recorded.`,
    );
  }
  return out;
}

/** The contacts of the reminder's week who won't get one, and why, or null when there are none. */
export function weekLine(view: CartsScreenView): string | null {
  const r = view.reminder;
  if (!r) return null;
  const cant = r.no_consent + r.suppressed;
  const parts = [
    ...(cant > 0 ? [`${num(cant)} can't be emailed`] : []),
    ...(r.recently_proposed > 0
      ? [
          `${num(r.recently_proposed)} ${r.recently_proposed === 1 ? "was" : "were"} already proposed a reminder in the last ${view.thresholds?.recontact_days ?? 30} days`,
        ]
      : []),
  ];
  return parts.length === 0
    ? null
    : `Of the contacts who left a cart in the last week, ${parts.join(", and ")}.`;
}

/** "€37–€124", per currency. */
export function winBackText(m: Measured, words: CartsWords = ENGLISH()): string | null {
  if (m.win_back.length === 0) return null;
  const { tr, locale } = words;
  return m.win_back
    .map(
      (w) =>
        `${moneyText(w.low_minor, w.currency, locale)}–${moneyText(w.high_minor, w.currency, locale)}`,
    )
    .reduce((acc, part) => tr("view.and", { first: acc, last: part }));
}

/** Why "Propose win-back emails" is off, or null when it can be pressed. */
export function proposeBlock(view: CartsScreenView): string | null {
  if (view.held) return view.held;
  if (view.proposal) return null; // shown as its status instead
  const r = view.reminder;
  const t = view.thresholds;
  const span = t ? `${t.winback_min_days}–${t.winback_max_days} days ago` : "in the last week";
  if (!r || r.emailable > 0) return null;
  if (r.recently_proposed > 0) {
    return `Everyone who left a cart ${span} and said yes to email was proposed a reminder in the last ${t?.recontact_days ?? 30} days.`;
  }
  return `No contact who said yes to email left a cart ${span}, so there is nobody to remind.`;
}

/** What has become of today's reminder proposal, in a word or two. */
export function proposalWord(
  p: { status: string },
  tr: Tr = ENGLISH().tr,
): { word: string; tone: string } {
  switch (p.status) {
    case "pending":
      return { word: tr("view.waiting"), tone: "ok" };
    case "blocked":
      return { word: tr("view.blocked"), tone: "alarm" };
    case "approved":
      return { word: tr("view.approved"), tone: "ok" };
    case "executed":
      return { word: tr("view.sent"), tone: "ok" };
    case "rejected":
      return { word: tr("view.declined"), tone: "none" };
    case "expired":
      return { word: tr("view.expired"), tone: "none" };
    default:
      return { word: p.status.replace(/_/g, " "), tone: "none" };
  }
}

/** The sources line: where the numbers came from, with the day they were read. */
export function sourcesLine(view: CartsScreenView): string {
  const read = (view.sources ?? [])
    .filter((s) => s.read_at !== null)
    .map((s) => `${s.label}, read ${dayWords(s.read_at!.slice(0, 10))}`);
  return `Carts and orders: ${read.length > 0 ? read.join("; ") : "not read yet"}. Who can be emailed: each contact's own recorded consent, checked again when an email goes.`;
}
