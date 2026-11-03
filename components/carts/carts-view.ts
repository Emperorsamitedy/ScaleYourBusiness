// The carts screen's words — idea 47. Pure, so they are tested without a
// browser (carts-view.test.ts). Plain words, en-GB days ("6 Nov"), never an
// ISO date or a rule number, and never a shopper: every line is a count.
//
// L-3b: the fixed words (titles, status words, "and") are the "carts"
// catalogue through optional words, English by default; money and shares
// in the reader's locale. L-4b: the sentences built from the counts
// (headline, window line, consent and checkout notes, the week line, why
// proposing is off, the sources line) are the "cartsWords" catalogue, the
// same way, English by default.

import { listSep } from "../../lib/i18n/punctuation";
import type { CartsScreenView } from "../../app/api/carts/route";
import type { CartReach, CartsSentenceWords, Money, WindowStats } from "../../lib/carts/measure";
import type { CartShopperRead } from "../../lib/connectors/provider";
import { CARTS, dayWords, englishCartsWords } from "../../lib/carts/measure";
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

/** The sentences' words and the reader's locale: the "cartsWords" catalogue. */
export type CartsSentences = CartsSentenceWords;
const SENTENCES = englishCartsWords;

export type Measured = Extract<NonNullable<CartsScreenView["measure"]>, { status: "measured" }>;

/** "€1,240", or "€1,240 and £80" — currencies side by side, never added. */
export function moneyList(list: readonly Money[], w: CartsWords = ENGLISH()): string {
  const parts = list.map((m) => moneyText(m.amount_minor, m.currency, w.locale));
  return parts.length <= 1
    ? (parts[0] ?? moneyText(0, "EUR", w.locale))
    : w.tr("view.and", { first: parts.slice(0, -1).join(", "), last: parts.at(-1)! });
}

/** moneyList inside a sentence, over the sentences' own "and". */
const moneyIn = (list: readonly Money[], s: CartsSentences) =>
  moneyList(list, { tr: (k, v) => s.tr(k === "view.and" ? "and" : k, v), locale: s.locale });

/** The screen's one display line. */
export function cartsHeadline(view: CartsScreenView, s: CartsSentences = SENTENCES()): string {
  const { tr, locale } = s;
  if (!view.applies) return tr("headline.noShop");
  const read = (view.sources ?? []).some((x) => x.read_at !== null);
  const m = view.measure;
  if (!m || (!read && m.status === "refused")) return tr("headline.notRead");
  // Review 2026-10-30: a stale or partial read says so, not "too early".
  if (m.status === "refused" && m.basis === "too_many") return tr("headline.tooMany");
  if (m.status === "refused" && m.basis === "stale") return tr("headline.stale");
  if (m.status === "refused") return tr("headline.tooEarly");
  const days = view.thresholds?.window_days ?? 30;
  const value = m.current.value_left.filter((v) => v.amount_minor > 0);
  const reach = {
    days,
    emailable: num(m.reach.emailable_shoppers, 0, locale),
    shoppers: m.reach.shoppers,
  };
  return value.length === 0
    ? tr("headline.carts", { ...reach, count: m.current.left })
    : tr("headline.value", { ...reach, money: moneyIn(value, s) });
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
export function windowLine(m: Measured, s: CartsSentences = SENTENCES()): string {
  const { tr, locale } = s;
  const c = m.current;
  const share = shareText(c, locale);
  const nowValues = {
    from: dayWords(c.from, locale),
    to: dayWords(c.to, locale),
    started: c.started,
    left: num(c.left, 0, locale),
    recovered: num(c.recovered, 0, locale),
  };
  const now = share ? tr("window.nowShare", { ...nowValues, share }) : tr("window.now", nowValues);
  if (!m.prior) return `${now} ${m.prior_note ?? ""}`.trim();
  const p = m.prior;
  const pShare = shareText(p, locale);
  const priorValues = {
    days: CARTS.window_days,
    left: num(p.left, 0, locale),
    money: moneyIn(p.value_left, s),
  };
  const before = pShare
    ? tr("window.priorShare", { ...priorValues, share: pShare })
    : tr("window.prior", priorValues);
  return `${now} ${before}`;
}

/** I-47b: why a cart carries no email, by whether the store's last read had the shopper. */
const NO_EMAIL_WHY: Record<CartShopperRead | "unknown", string> = {
  read: "noEmailWhy.read",
  not_granted: "noEmailWhy.notGranted",
  refused: "noEmailWhy.refused",
  unknown: "noEmailWhy.unknown",
};

const NOTE: Record<Exclude<CartReach, "emailable">, string> = {
  no_email: "notes.noEmail",
  not_contact: "notes.notContact",
  no_consent: "notes.noConsent",
  suppressed: "notes.suppressed",
};

/**
 * The consent notes: who can't be emailed, counted, in words. Never an
 * address. `shopper` is the store's last read (I-47b); null when unknown.
 */
export function consentNotes(
  m: Measured,
  shopper: CartShopperRead | null = null,
  s: CartsSentences = SENTENCES(),
): string[] {
  const { tr } = s;
  const out: string[] = [];
  const yes = m.reach.carts.emailable;
  if (yes > 0) out.push(tr("notes.yes", { count: yes }));
  for (const k of ["no_consent", "not_contact", "suppressed", "no_email"] as const) {
    const n = m.reach.carts[k];
    if (n === 0) continue;
    const note = tr(NOTE[k], { count: n });
    out.push(k === "no_email" ? `${note} ${tr(NO_EMAIL_WHY[shopper ?? "unknown"])}` : note);
  }
  return out;
}

/**
 * I-47a/I-47c: what Shopify's checkout tick did to the contacts, in words,
 * or nothing when it did nothing. Counts only.
 */
export function checkoutConsentNotes(
  view: CartsScreenView,
  s: CartsSentences = SENTENCES(),
): string[] {
  const { tr } = s;
  const c = view.checkout_consent;
  if (!c) return [];
  const out: string[] = [];
  if (c.said_yes > 0) out.push(tr("checkout.saidYes", { count: c.said_yes }));
  if (c.withdrawn > 0) out.push(tr("checkout.withdrawn", { count: c.withdrawn }));
  if (c.differs !== null && c.differs > 0) out.push(tr("checkout.differs", { count: c.differs }));
  return out;
}

/** The contacts of the reminder's week who won't get one, and why, or null when there are none. */
export function weekLine(view: CartsScreenView, s: CartsSentences = SENTENCES()): string | null {
  const { tr } = s;
  const r = view.reminder;
  if (!r) return null;
  const cant = r.no_consent + r.suppressed;
  const values = {
    cant,
    count: r.recently_proposed,
    days: view.thresholds?.recontact_days ?? 30,
  };
  if (cant > 0 && r.recently_proposed > 0) return tr("week.both", values);
  if (cant > 0) return tr("week.cant", values);
  if (r.recently_proposed > 0) return tr("week.recent", values);
  return null;
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
export function proposeBlock(
  view: CartsScreenView,
  s: CartsSentences = SENTENCES(),
): string | null {
  const { tr, locale } = s;
  if (view.held) return view.held;
  if (view.proposal) return null; // shown as its status instead
  const r = view.reminder;
  const t = view.thresholds;
  if (!r || r.emailable > 0) return null;
  const values = {
    days: t?.recontact_days ?? 30,
    min: t ? num(t.winback_min_days, 0, locale) : "",
    max: t?.winback_max_days ?? 0,
  };
  if (r.recently_proposed > 0) return tr(t ? "block.everyone" : "block.everyoneWeek", values);
  return tr(t ? "block.nobody" : "block.nobodyWeek", values);
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
export function sourcesLine(view: CartsScreenView, s: CartsSentences = SENTENCES()): string {
  const { tr, locale } = s;
  const read = (view.sources ?? [])
    .filter((x) => x.read_at !== null)
    .map((x) =>
      tr("sources.read", { source: x.label, day: dayWords(x.read_at!.slice(0, 10), locale) }),
    );
  return read.length > 0
    ? tr("sources.line", { list: read.join(listSep(locale)) })
    : tr("sources.notYet");
}
