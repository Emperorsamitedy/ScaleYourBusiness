// Reading prices off a competitor's public page — feature 35.
//
// Deterministic first, in this order, and the first method to see an
// offer keeps it:
//   1. schema.org JSON-LD: Product / Service / Offer / AggregateOffer,
//      OfferCatalog lists, and a business-level AggregateRating;
//   2. OpenGraph price tags (og:price:amount, product:price:amount);
//   3. visible price patterns in the page text ("Cut and colour  €85").
// A model reads a page only when it plainly shows prices these could not
// pair with names (./model.ts decides, under caps). Nothing here guesses:
// a price without a currency it can name is dropped, never assumed.
//
// Money is integer minor units plus an ISO currency (rule 1), parsed from
// the digits as written — never through a float.

import type { Money } from "../core/money";
import { minorUnitExponent, money } from "../core/money";
import { stripHtml } from "../site/html-text";

export type ExtractMethod = "jsonld" | "og" | "pattern" | "model";

/** Earlier wins when two methods see the same offer. */
export const METHOD_ORDER: readonly ExtractMethod[] = ["jsonld", "og", "pattern", "model"];

export interface SeenOffer {
  /** Stable identity across reads: the normalised name. */
  key: string;
  /** As the page wrote it, trimmed. */
  name: string;
  price: Money;
  /** "from €45" — the lowest price of a range. */
  from: boolean;
  method: ExtractMethod;
}

export interface SeenRating {
  rating: number;
  best: number;
  count: number | null;
  method: "jsonld";
}

export interface PageExtract {
  offers: SeenOffer[];
  rating: SeenRating | null;
  /** Price tokens in the visible text: the model fallback's trigger. */
  price_tokens: number;
  /** Currencies the visible text names, for the model fallback. */
  currencies: string[];
  /** Visible text, for the model fallback. */
  text: string;
}

/** A page is not a catalogue: past this many offers, the rest are dropped. */
export const MAX_OFFERS_PER_PAGE = 60;
const MAX_NAME = 90;

/* ── names ── */

/** Pure: the identity of an offer name — lower case, unaccented, punctuation-free. */
export function offerKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/colour/g, "color")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function cleanName(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:|·•.*]+|[\s\-–—:|·•.*,]+$/g, "")
    .replace(/\.{2,}/g, " ")
    .trim()
    .slice(0, MAX_NAME);
}

/* ── money from digits as written ── */

/** Symbols and words a price can carry, to an ISO code. "kr" and "$" variants that name several currencies are not here. */
const CURRENCY_WORDS: Readonly<Record<string, string>> = {
  "€": "EUR",
  eur: "EUR",
  "£": "GBP",
  gbp: "GBP",
  $: "USD",
  usd: "USD",
  ft: "HUF",
  huf: "HUF",
  zł: "PLN",
  pln: "PLN",
  kč: "CZK",
  czk: "CZK",
  lei: "RON",
  ron: "RON",
  chf: "CHF",
};

export function currencyOf(word: string): string | null {
  return CURRENCY_WORDS[word.toLowerCase()] ?? null;
}

/**
 * Pure: an amount as written ("85", "85.00", "85,00", "1 200", "1.200",
 * "12,500.50", "85,-") in minor units of `currency`. Null when it is
 * not a plain positive amount. `strictDot` reads "1.200" as one point
 * two — schema.org's own number form — instead of twelve hundred.
 */
export function parseAmount(raw: string, currency: string, strictDot = false): number | null {
  const exp = minorUnitExponent(currency);
  let s = raw
    .trim()
    .replace(/[\u00a0\u202f\u2009' ]/g, "")
    .replace(/[.,][-–]$/, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;
  let intPart: string;
  let frac = "";
  if (strictDot) {
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    [intPart = "", frac = ""] = s.split(".");
  } else {
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    if (lastDot !== -1 && lastComma !== -1) {
      const dec = lastDot > lastComma ? "." : ",";
      const thou = dec === "." ? "," : ".";
      s = s.split(thou).join("");
      [intPart = "", frac = ""] = s.split(dec);
    } else {
      const sep = lastDot !== -1 ? "." : lastComma !== -1 ? "," : null;
      if (sep === null) {
        intPart = s;
      } else {
        const parts = s.split(sep);
        const tail = parts[parts.length - 1] ?? "";
        if (parts.length === 2 && tail.length >= 1 && tail.length <= 2) {
          intPart = parts[0] ?? "";
          frac = tail;
        } else if (parts.slice(1).every((p) => p.length === 3)) {
          intPart = parts.join("");
        } else {
          return null;
        }
      }
    }
  }
  if (intPart === "" || !/^\d+$/.test(intPart) || !/^\d*$/.test(frac)) return null;
  if (frac.length > exp) {
    // "85.000" in a 2-decimal currency: only trailing zeros may go.
    if (!/^0+$/.test(frac.slice(exp))) return null;
    frac = frac.slice(0, exp);
  }
  const minor = Number(intPart) * 10 ** exp + Number(frac.padEnd(exp, "0") || "0");
  if (!Number.isSafeInteger(minor) || minor <= 0) return null;
  return minor;
}

/* ── 1 · JSON-LD ── */

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const typesOf = (n: Json): string[] =>
  asList(n["@type"]).filter((t): t is string => typeof t === "string");
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" ? String(v) : null;

const ITEM_TYPES = new Set(["Product", "Service", "IndividualProduct", "ProductModel"]);
const OFFER_TYPES = new Set(["Offer", "AggregateOffer"]);

/** The JSON-LD blocks of a page, parsed; a block that doesn't parse is skipped. */
export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re =
    /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const m of html.matchAll(re)) {
    const body = (m[1] ?? "")
      .replace(/^\s*<!--/, "")
      .replace(/-->\s*$/, "")
      .replace(/^\s*\/\/\s*<!\[CDATA\[/, "")
      .replace(/\/\/\s*\]\]>\s*$/, "")
      .trim();
    try {
      out.push(JSON.parse(body));
    } catch {
      /* a broken block is not evidence */
    }
  }
  return out;
}

function offerPrice(offer: Json): { minor: number; currency: string; from: boolean } | null {
  const spec = asList(offer.priceSpecification).find(isObj);
  const currency = (str(offer.priceCurrency) ?? (spec ? str(spec.priceCurrency) : null))
    ?.toUpperCase()
    .trim();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
  const aggregate = typesOf(offer).includes("AggregateOffer");
  const raw =
    str(offer.price) ?? (spec ? str(spec.price) : null) ?? (aggregate ? str(offer.lowPrice) : null);
  if (raw === null) return null;
  const minor = parseAmount(raw, currency, true) ?? parseAmount(raw, currency);
  if (minor === null) return null;
  return { minor, currency, from: aggregate && str(offer.price) === null };
}

/** Pure: offers and a business-level rating from a page's JSON-LD. */
export function fromJsonLd(html: string): { offers: SeenOffer[]; rating: SeenRating | null } {
  const offers: SeenOffer[] = [];
  const used = new WeakSet<object>();
  let rating: SeenRating | null = null;
  let nodes = 0;

  const push = (name: string | null, offer: Json): void => {
    used.add(offer);
    const n = name ? cleanName(name) : "";
    const price = offerPrice(offer);
    if (n === "" || !price || offerKey(n) === "") return;
    offers.push({
      key: offerKey(n),
      name: n,
      price: money(price.minor, price.currency),
      from: price.from,
      method: "jsonld",
    });
  };

  const takeRating = (r: Json, owner: Json | null): void => {
    // A product's stars are not the business's: only a rating on the
    // business itself (or reviewing it) counts.
    if (owner && typesOf(owner).some((t) => ITEM_TYPES.has(t))) return;
    const reviewed = isObj(r.itemReviewed) ? r.itemReviewed : null;
    if (reviewed && typesOf(reviewed).some((t) => ITEM_TYPES.has(t))) return;
    const value = Number(str(r.ratingValue)?.replace(",", "."));
    const best = Number(str(r.bestRating)?.replace(",", ".") ?? 5);
    const countRaw = str(r.reviewCount) ?? str(r.ratingCount);
    const count = countRaw !== null && /^\d+$/.test(countRaw) ? Number(countRaw) : null;
    if (!Number.isFinite(value) || !Number.isFinite(best) || best <= 0 || value <= 0) return;
    if (value > best) return;
    if (rating === null || (count ?? 0) > (rating.count ?? 0)) {
      rating = { rating: value, best, count, method: "jsonld" };
    }
  };

  const walk = (v: unknown, parent: Json | null, depth: number): void => {
    if (depth > 12 || nodes > 4000) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, parent, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    nodes++;
    const types = typesOf(v);

    if (types.includes("AggregateRating")) takeRating(v, parent);
    if (isObj(v.aggregateRating)) takeRating(v.aggregateRating, v);

    if (types.some((t) => ITEM_TYPES.has(t))) {
      const list = asList(v.offers).filter(isObj);
      const name = str(v.name);
      for (const offer of list) {
        const offerName = str(offer.name);
        push(
          list.length > 1 && offerName && name && offerName !== name
            ? `${name} · ${offerName}`
            : (name ?? offerName),
          offer,
        );
      }
    } else if (types.some((t) => OFFER_TYPES.has(t)) && !used.has(v)) {
      const item = isObj(v.itemOffered) ? v.itemOffered : null;
      push((item ? str(item.name) : null) ?? str(v.name), v);
    }

    for (const [k, child] of Object.entries(v)) {
      if (k === "@context") continue;
      walk(child, v, depth + 1);
    }
  };

  for (const block of jsonLdBlocks(html)) walk(block, null, 0);
  return { offers, rating };
}

/* ── 2 · OpenGraph ── */

function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && content !== undefined && !out.has(key)) out.set(key, decodeEntities(content));
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

/** Pure: the one offer a product page declares in its OpenGraph tags. */
export function fromOpenGraph(html: string): SeenOffer[] {
  const meta = metaTags(html);
  const amount = meta.get("product:price:amount") ?? meta.get("og:price:amount");
  const currency = (meta.get("product:price:currency") ?? meta.get("og:price:currency"))
    ?.trim()
    .toUpperCase();
  const name = cleanName(meta.get("og:title") ?? "");
  if (!amount || !currency || !/^[A-Z]{3}$/.test(currency) || name === "") return [];
  const minor = parseAmount(amount, currency, true) ?? parseAmount(amount, currency);
  if (minor === null) return [];
  return [{ key: offerKey(name), name, price: money(minor, currency), from: false, method: "og" }];
}

/* ── 3 · visible price patterns ── */

const NUMBER = String.raw`\d{1,3}(?:[.,\u00a0\u202f ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?(?:[.,][-–])?`;
const SYMBOL = String.raw`€|£|\$`;
const WORD = String.raw`EUR|GBP|USD|HUF|PLN|CZK|RON|CHF|Ft|zł|Kč|lei`;

/** A price token: symbol/code before or after the digits. */
const PRICE_RE = new RegExp(
  String.raw`(?:(${SYMBOL}|(?<!\p{L})(?:${WORD})(?!\p{L}))\s?(${NUMBER}))|(?:(?<![\d.,])(${NUMBER})\s?(${SYMBOL}|(?:${WORD})(?!\p{L})))`,
  "giu",
);

/** Lines that carry a price but are not an offer. */
const NOT_AN_OFFER =
  /\b(shipping|delivery|postage|over|orders?|minimum|spend|vouchers?|gift ?cards?|save|off|deposit|total|subtotal|basket|cart|discount|cancellation|fee|tip)\b|%/i;
const FROM_RE = /\b(from|starting at|ab|od|desde|à partir de|tól|től)\b/i;

interface Token {
  index: number;
  length: number;
  minor: number;
  currency: string;
}

function tokensOf(line: string): Token[] {
  const out: Token[] = [];
  for (const m of line.matchAll(PRICE_RE)) {
    const word = m[1] ?? m[4] ?? "";
    const digits = m[2] ?? m[3] ?? "";
    const currency = currencyOf(word);
    if (!currency) continue;
    const minor = parseAmount(digits, currency);
    if (minor === null) continue;
    out.push({ index: m.index ?? 0, length: m[0].length, minor, currency });
  }
  return out;
}

const looksLikeName = (s: string): boolean =>
  /\p{L}{2,}/u.test(s) && s.length <= MAX_NAME && !NOT_AN_OFFER.test(s);

/** Pure: "name … price" lines from visible text; a name on the line above counts too. */
export function fromPatterns(text: string): {
  offers: SeenOffer[];
  tokens: number;
  currencies: string[];
} {
  const offers: SeenOffer[] = [];
  const currencies = new Set<string>();
  let tokens = 0;
  let previous = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const found = tokensOf(line);
    tokens += found.length;
    for (const t of found) currencies.add(t.currency);

    let take: { minor: number; currency: string; from: boolean } | null = null;
    let rest = line;
    if (found.length === 1) {
      const t = found[0]!;
      rest = line.slice(0, t.index) + " " + line.slice(t.index + t.length);
      take = { minor: t.minor, currency: t.currency, from: FROM_RE.test(line) };
    } else if (found.length === 2) {
      // "€40 – €60" is a range: the low end, as a "from". Anything else
      // with two prices (a was/now pair) is too ambiguous to read.
      const [a, b] = found as [Token, Token];
      const between = line.slice(a.index + a.length, b.index);
      if (/^\s*[-–—]\s*$/.test(between) && a.currency === b.currency && a.minor < b.minor) {
        rest = line.slice(0, a.index) + " " + line.slice(b.index + b.length);
        take = { minor: a.minor, currency: a.currency, from: true };
      }
    }

    if (take && line.length <= 160 && !NOT_AN_OFFER.test(line)) {
      let name = cleanName(rest.replace(FROM_RE, " "));
      if (
        !looksLikeName(name) &&
        looksLikeName(cleanName(previous)) &&
        tokensOf(previous).length === 0
      ) {
        name = cleanName(previous);
      }
      if (looksLikeName(name) && offerKey(name) !== "") {
        offers.push({
          key: offerKey(name),
          name,
          price: money(take.minor, take.currency),
          from: take.from,
          method: "pattern",
        });
      }
    }
    previous = line;
  }
  return { offers, tokens, currencies: [...currencies] };
}

/* ── the page ── */

/** Pure: one offer per key, the earlier method winning, then the first seen. */
export function mergeOffers(lists: readonly SeenOffer[][]): SeenOffer[] {
  const out = new Map<string, SeenOffer>();
  for (const list of lists) {
    for (const o of list) {
      const had = out.get(o.key);
      if (!had || METHOD_ORDER.indexOf(o.method) < METHOD_ORDER.indexOf(had.method)) {
        out.set(o.key, o);
      }
    }
  }
  return [...out.values()].slice(0, MAX_OFFERS_PER_PAGE);
}

/** Pure: everything the deterministic methods read off one page. */
export function extractPage(html: string): PageExtract {
  const ld = fromJsonLd(html);
  const og = fromOpenGraph(html);
  // Source line breaks are not visible ones: collapse them first, so only
  // block elements (rows, items, paragraphs) break the text into lines.
  const text = stripHtml(
    html
      .replace(/\s+/g, " ")
      .replace(/&euro;|&#0*8364;|&#x0*20ac;/gi, "€")
      .replace(/&pound;|&#0*163;|&#x0*a3;/gi, "£"),
  );
  const pattern = fromPatterns(text);
  return {
    offers: mergeOffers([ld.offers, og, pattern.offers]),
    rating: ld.rating,
    price_tokens: pattern.tokens,
    currencies: pattern.currencies,
    text,
  };
}

/**
 * Pure: whether a page shows prices the parsers could not pair with
 * names — at least three price tokens, under half of them read. Only
 * then may the model look (./model.ts, under its caps).
 */
export function needsModel(page: PageExtract): boolean {
  return page.price_tokens >= 3 && page.offers.length * 2 < page.price_tokens;
}
