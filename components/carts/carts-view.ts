// The carts screen's words — idea 47. Pure, so they are tested without a
// browser (carts-view.test.ts). Plain words, en-GB days ("6 Nov"), never an
// ISO date or a rule number, and never a shopper: every line is a count.

import type { CartsScreenView } from "../../app/api/carts/route";
import type { CartReach, Money, WindowStats } from "../../lib/carts/measure";
import { dayWords } from "../../lib/carts/measure";
import { moneyText, num } from "../sheet/num";

export type Measured = Extract<NonNullable<CartsScreenView["measure"]>, { status: "measured" }>;

const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/** "€1,240", or "€1,240 and £80" — currencies side by side, never added. */
export function moneyList(list: readonly Money[]): string {
  const parts = list.map((m) => moneyText(m.amount_minor, m.currency));
  return parts.length <= 1
    ? (parts[0] ?? moneyText(0, "EUR"))
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`;
}

/** The screen's one display line. */
export function cartsHeadline(view: CartsScreenView): string {
  if (!view.applies) return "Abandoned carts need a connected Shopify shop.";
  const read = (view.sources ?? []).some((s) => s.read_at !== null);
  const m = view.measure;
  if (!m || (!read && m.status === "refused")) return "I haven't read your carts yet.";
  if (m.status === "refused") return "Too early to measure your abandoned carts.";
  const days = view.thresholds?.window_days ?? 30;
  const value = m.current.value_left.filter((v) => v.amount_minor > 0);
  const left =
    value.length === 0
      ? `${plural(m.current.left, "cart was", "carts were")} left in the last ${days} days`
      : `${moneyList(value)} was left in carts in the last ${days} days`;
  return `${left}; ${num(m.reach.emailable_shoppers)} of the ${plural(m.reach.shoppers, "shopper")} can be emailed.`;
}

/** The share left, as a whole percent, or null when orders weren't measured. */
export function shareText(w: WindowStats): string | null {
  return w.share_left === null ? null : `${Math.round(w.share_left * 100)}%`;
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

const NOTE: Record<Exclude<CartReach, "emailable">, (n: string, one: boolean) => string> = {
  no_email: (n, one) =>
    `${n} ${one ? "cart carries" : "carts carry"} no email I can read, so ${one ? "it isn't" : "they aren't"} matched to anyone. Shopify only says who left a cart to an app that may read your customers, and I don't ask for that.`,
  not_contact: (n, one) =>
    `${n} ${one ? "cart is" : "carts are"} from shoppers who aren't among your contacts, so ${one ? "it isn't" : "they aren't"} emailed.`,
  no_consent: (n, one) =>
    `${n} ${one ? "cart is" : "carts are"} from contacts with no recorded yes to email, so ${one ? "it isn't" : "they aren't"} emailed.`,
  suppressed: (n, one) =>
    `${n} ${one ? "cart is" : "carts are"} from people who unsubscribed or asked to be forgotten, so ${one ? "it isn't" : "they aren't"} emailed.`,
};

/** The consent notes: who can't be emailed, counted, in words. Never an address. */
export function consentNotes(m: Measured): string[] {
  const out: string[] = [];
  const yes = m.reach.carts.emailable;
  if (yes > 0) {
    out.push(
      `${num(yes)} ${yes === 1 ? "cart is" : "carts are"} from contacts who said yes to email.`,
    );
  }
  for (const k of ["no_consent", "not_contact", "suppressed", "no_email"] as const) {
    const n = m.reach.carts[k];
    if (n > 0) out.push(NOTE[k](num(n), n === 1));
  }
  return out;
}

/** "€37–€124", per currency. */
export function winBackText(m: Measured): string | null {
  if (m.win_back.length === 0) return null;
  return m.win_back
    .map((w) => `${moneyText(w.low_minor, w.currency)}–${moneyText(w.high_minor, w.currency)}`)
    .join(" and ");
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
export function proposalWord(p: { status: string }): { word: string; tone: string } {
  switch (p.status) {
    case "pending":
      return { word: "Waiting for you", tone: "ok" };
    case "blocked":
      return { word: "Blocked by your rule", tone: "alarm" };
    case "approved":
      return { word: "Approved", tone: "ok" };
    case "executed":
      return { word: "Sent", tone: "ok" };
    case "rejected":
      return { word: "Declined", tone: "none" };
    case "expired":
      return { word: "Expired", tone: "none" };
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
