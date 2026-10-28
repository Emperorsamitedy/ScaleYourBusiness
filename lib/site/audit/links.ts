// Reading a page the way a visitor reads it — Phase 5 Session C (P5-12).
//
// Pure functions over fetched HTML: which links a page offers and what each
// one is (a product, the cart, a booking page, a login…), which of them the
// audit must never follow, what a phone's first screen shows, and how many
// fields a form asks for. No network, no DOM, no dependency.
//
// RULE 30 LIVES HERE AS DATA. A link is classified before it is followed,
// and three kinds are refused by name, never fetched:
//   · login, account and sign-up pages — the audit never logs in;
//   · cart ACTION links (…/cart/add, ?add-to-cart=…) — a GET that changes a
//     cart is still an add to cart, so it is not followed even though it is
//     "only a link";
//   · checkout — measured from the outside (the link exists, and how many
//     clicks it is from home), never opened.
// Booking links to another company's booking site count as the booking
// entry and are never fetched either: that page is not the owner's.

import { stripHtml } from "../html-text";

export type PageRole =
  | "home"
  | "category"
  | "product"
  | "cart"
  | "checkout"
  | "service"
  | "booking"
  | "contact"
  | "other";

/** Why the audit will not open a link — rule 30, by name. */
export type NeverFollow = "login_or_account" | "cart_action" | "checkout" | "external_booking";

export interface PageLink {
  url: string;
  text: string;
  role: PageRole;
  same_origin: boolean;
  never_follow: NeverFollow | null;
}

/** Hosted booking services: a link to one is a booking entry on someone else's site. */
const BOOKING_HOSTS =
  /(^|\.)(fresha\.com|booksy\.com|calendly\.com|setmore\.com|simplybook\.(me|it)|treatwell\.[a-z.]+|acuityscheduling\.com|opentable\.[a-z.]+|resdiary\.com|squareup\.com|square\.site|vagaro\.com|mindbodyonline\.com|timely\.com|gettimely\.com|salonized\.com|phorest\.com|booker\.com|picktime\.com|youcanbook\.me)$/i;

const seg = (words: string) => new RegExp(`/(${words})(?=$|[/?#.\\-_])`, "i");

const AUTH = seg(
  "log-?in|sign-?in|sign-?up|signup|register|log-?out|sign-?out|account|accounts|my-account|wp-login\\.php|wp-login|wp-admin|admin|password|belepes|regisztracio|fiokom",
);
const CART_ACTION =
  /\/cart\/(add|change|update|clear)(?=$|[/?#.])|[?&](add-to-cart|add_to_cart|add|quantity)=|\/add-to-cart(?=$|[/?#])/i;
const CHECKOUT = seg("checkout|checkouts|kassza|penztar");
const CART = seg("cart|basket|bag|kosar");
const BOOKING = seg(
  "book|book-now|booking|bookings|book-online|appointment|appointments|reserve|reservation|reservations|schedule|foglalas|idopontfoglalas|idopont",
);
const PRODUCT = /\/(products?|item|items|p|termek|termekek)\/[^/?#]+/i;
const CATEGORY = seg(
  "collections?|categor(y|ies)|shop|store|webshop|termekek|kategoria|kategoriak",
);
const SERVICE = seg(
  "services?|treatments?|szolgaltatas(ok)?|menu|etlap|pricing|prices|price-list|arak|arlista|classes|lessons",
);
const CONTACT = seg("contact|contact-us|kapcsolat|elerhetoseg(ek)?");

const TEXT_BOOKING = /\b(book (now|online|an? appointment|a table|a class)|reserve|foglal)/i;
const TEXT_CONTACT = /^(contact( us)?|kapcsolat|get in touch)$/i;

/** Accents off, so "Kosár" and "kosar" are one word. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

/** Pure: what a link is, and whether the audit may follow it. */
export function classifyLink(url: URL, text: string, base: URL): Omit<PageLink, "url" | "text"> {
  const sameOrigin = url.origin === base.origin;
  const path = fold(decodeURIComponent(url.pathname + url.search).toLowerCase());
  const words = fold(text).trim();
  if (!sameOrigin) {
    if (BOOKING_HOSTS.test(url.hostname)) {
      return { role: "booking", same_origin: false, never_follow: "external_booking" };
    }
    return { role: "other", same_origin: false, never_follow: null };
  }
  if (AUTH.test(path))
    return { role: "other", same_origin: true, never_follow: "login_or_account" };
  if (CART_ACTION.test(path))
    return { role: "other", same_origin: true, never_follow: "cart_action" };
  if (CHECKOUT.test(path)) return { role: "checkout", same_origin: true, never_follow: "checkout" };
  if (CART.test(path)) return { role: "cart", same_origin: true, never_follow: null };
  if (BOOKING.test(path) || TEXT_BOOKING.test(words)) {
    return { role: "booking", same_origin: true, never_follow: null };
  }
  if (PRODUCT.test(path)) return { role: "product", same_origin: true, never_follow: null };
  if (CATEGORY.test(path)) return { role: "category", same_origin: true, never_follow: null };
  if (SERVICE.test(path)) return { role: "service", same_origin: true, never_follow: null };
  if (CONTACT.test(path) || TEXT_CONTACT.test(words)) {
    return { role: "contact", same_origin: true, never_follow: null };
  }
  if (url.pathname === "/" || url.pathname === "") {
    return { role: "home", same_origin: true, never_follow: null };
  }
  return { role: "other", same_origin: true, never_follow: null };
}

/** The address without its fragment — "#reviews" is the same page. */
export function pageKey(url: URL): string {
  const u = new URL(url.href);
  u.hash = "";
  return u.href;
}

/** Pure: every http(s) link on a page, classified, each address once, in page order. */
export function pageLinks(html: string, pageUrl: string): PageLink[] {
  const base = new URL(pageUrl);
  const seen = new Set<string>();
  const out: PageLink[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1] ?? "").trim();
    if (href === "" || href.startsWith("#") || /^(mailto|tel|javascript|data|sms):/i.test(href))
      continue;
    let url: URL;
    try {
      url = new URL(href.replace(/&amp;/g, "&"), base);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const key = pageKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const text = stripHtml(m[2] ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    out.push({ url: key, text, ...classifyLink(url, text, base) });
  }
  return out;
}

const ENTITIES: Readonly<Record<string, string>> = {
  euro: "€",
  pound: "£",
  yen: "¥",
  dollar: "$",
  cent: "¢",
};

/** Visible text, with the currency entities a price uses decoded. */
export function visibleText(html: string): string {
  return stripHtml(html)
    .replace(/&(euro|pound|yen|dollar|cent);/gi, (_, n: string) => ENTITIES[n.toLowerCase()] ?? "")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)));
}

/**
 * The first screen, by heuristic (stated, not measured — SYB renders
 * nothing): the page's own text after the site header and menu, first
 * FIRST_SCREEN_CHARS characters. On a phone that is roughly the headline,
 * a line or two, and whatever sits beside them.
 */
export const FIRST_SCREEN_CHARS = 600;

export function firstScreenText(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(body)?.[1];
  const content = (main ?? body)
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ");
  return visibleText(content).replace(/\s+/g, " ").trim().slice(0, FIRST_SCREEN_CHARS);
}

const SYMBOL_FIRST = /(€|£|\$|¥|₹|\b(eur|usd|gbp|huf|chf|pln|czk|sek|dkk|nok)\b)\s?\d/i;
const AMOUNT_FIRST =
  /\d[\d\s.,]*\s?(€|£|\$|zł|kč|\b(ft|huf|eur|usd|gbp|chf|pln|czk|sek|dkk|nok|kr)\b)/i;

/** Pure: whether a piece of text shows a price. */
export function showsPrice(text: string): boolean {
  return SYMBOL_FIRST.test(text) || AMOUNT_FIRST.test(text);
}

export interface FormCount {
  /** Where the form would send its answers; never sent to. */
  action: string | null;
  /** Fields a visitor fills in: inputs (not hidden or buttons), selects, textareas. */
  fields: number;
  required: number;
}

const NOT_A_FIELD = /^(hidden|submit|button|image|reset)$/i;

/**
 * Pure: the forms a visitor fills in on this page, each with its field
 * count. Search boxes and add-to-cart forms are not "asking the visitor
 * for effort" and are skipped. Nothing is ever submitted.
 */
export function countForms(html: string): FormCount[] {
  const out: FormCount[] = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = m[1] ?? "";
    const inner = m[2] ?? "";
    const action = /action\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? null;
    if (/role\s*=\s*["']search["']/i.test(attrs)) continue;
    if (action && /\/(search|cart)(\/|$|\?)|add-to-cart|\/cart\/add/i.test(action)) continue;
    if (/<input\b[^>]*type\s*=\s*["']?search/i.test(inner)) continue;
    let fields = 0;
    let required = 0;
    for (const f of inner.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
      const tag = (f[1] ?? "").toLowerCase();
      const a = f[2] ?? "";
      if (tag === "input") {
        const type = /type\s*=\s*["']?([a-z-]+)/i.exec(a)?.[1] ?? "text";
        if (NOT_A_FIELD.test(type)) continue;
      }
      fields += 1;
      if (/\brequired\b|aria-required\s*=\s*["']true/i.test(a)) required += 1;
    }
    if (fields > 0) out.push({ action, fields, required });
  }
  return out;
}

/** Pure: whether a page offers an Add-to-cart control (a form or button — never pressed). */
export function hasAddToCart(html: string): boolean {
  return (
    /<form\b[^>]*action\s*=\s*["'][^"']*(\/cart\/add|add-to-cart|add_to_cart)/i.test(html) ||
    /<button\b[^>]*>[\s\S]{0,80}?(add to (cart|basket|bag)|kosarba|kosárba)/i.test(html) ||
    /name\s*=\s*["']add(-to-cart)?["']/i.test(html)
  );
}

/** Pure: whether a page offers a way into checkout (a link, a form, or a button — never pressed). */
export function hasCheckoutControl(html: string, pageUrl: string): boolean {
  if (/<form\b[^>]*action\s*=\s*["'][^"']*\/checkout/i.test(html)) return true;
  if (/<(button|input)\b[^>]*name\s*=\s*["']checkout["']/i.test(html)) return true;
  if (/<button\b[^>]*>[\s\S]{0,60}?(check ?out|penztar|pénztár|kassza)/i.test(html)) return true;
  return pageLinks(html, pageUrl).some((l) => l.role === "checkout");
}
