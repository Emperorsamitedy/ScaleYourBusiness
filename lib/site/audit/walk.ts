// The path to buying, walked by reading pages — Phase 5 Session C (P5-12).
//
// From the home page, the audit follows the site's own links the way a
// visitor clicks them — categories, products, services, the cart, the
// booking page, contact — reading each page through the GET-only, SSRF-
// guarded fetcher (lib/site/fetch.ts). It counts clicks from home to the
// checkout or booking entry, checks whether a price shows on the first
// screen of product and service pages, counts the fields a contact or
// booking form asks for, and tries the site's own links for broken ones.
//
// RULE 30. It never logs in, never submits a form, never adds to a cart
// (cart ACTION links are refused even though they are links), and never
// opens checkout: the checkout entry is found and counted, not visited.
// The fetcher keeps no cookies, so even a page that sets a session starts
// none here. Links that leave the owner's site are not read — a booking
// link to a hosted service is counted as the entry and left alone.
//
// Caps: MAX_READS pages per walk, MAX_DEPTH clicks from home, and
// MAX_LINK_CHECKS further same-origin links tried for broken ones.
//
// L-4c: the step labels, notes and reasons are the "siteWords" catalogue's
// English (lib/site/say.ts), stored as English; lib/site/localize.ts says
// them again in the reader's language.

import type { PageFetcher } from "../fetch";
import type { PlatformVerdict } from "../platform";
import { detectPlatform } from "../platform";
import type { FormCount, NeverFollow, PageLink, PageRole } from "./links";
import {
  countForms,
  firstScreenText,
  hasAddToCart,
  hasCheckoutControl,
  pageLinks,
  showsPrice,
} from "./links";
import { siteEnglish } from "../say";

const EN = siteEnglish();

export const WALK_CAPS = {
  /** Pages read per walk, the home page included. */
  max_reads: 12,
  /** Clicks from home the walk will go. */
  max_depth: 4,
  /** Further same-origin links tried for broken ones, after the reads. */
  max_link_checks: 15,
} as const;

/** The order the walk prefers, after clicks: what a buyer heads for first. */
const ROLE_RANK: Readonly<Record<PageRole, number>> = {
  home: 0,
  cart: 1,
  booking: 2,
  product: 3,
  category: 4,
  service: 5,
  contact: 6,
  checkout: 98,
  other: 99,
};

export interface WalkedPage {
  url: string;
  role: PageRole;
  /** Clicks from the home page. */
  clicks: number;
  /** The page it was reached from; null for home. */
  from: string | null;
  /** The link's words, as the visitor saw them. */
  label: string;
  status: number | null;
  /** Why it couldn't be read, when it couldn't. */
  error: string | null;
  /** Product and service pages: whether a price shows on the first screen (heuristic). */
  price_first_screen: boolean | null;
  /** Contact and booking pages: the forms and their field counts. */
  forms: FormCount[] | null;
  add_to_cart: boolean;
  checkout_control: boolean;
}

export interface PathStep {
  label: string;
  url: string | null;
  /** Clicks from home at this step. */
  clicks: number;
  /** "page" — read; "control" — a button seen, never pressed; "entry" — the entry link, never opened. */
  kind: "page" | "control" | "entry";
}

export interface PurchasePath {
  /** What the site sells through, as far as its own links show. */
  kind: "shop" | "booking" | "contact" | "none";
  steps: PathStep[];
  /** Clicks from home to the checkout or booking entry; null when it wasn't found. */
  clicks: number | null;
  /** Assumptions and limits of the count, in words (rule 25). */
  notes: string[];
}

export interface BrokenLink {
  url: string;
  found_on: string;
  /** The answer's status; null when the page couldn't be loaded at all. */
  status: number | null;
  reason: string;
  /** Linked from a page on the path to buying, or itself a shop/booking page. */
  on_path: boolean;
}

export interface WalkResult {
  home: string;
  pages: WalkedPage[];
  path: PurchasePath;
  broken: BrokenLink[];
  /** Links the audit saw and refused to open, with why (rule 30). */
  refused: { url: string; reason: NeverFollow }[];
  /** Page GETs made, link checks included. */
  reads: number;
  platform: PlatformVerdict | null;
}

interface Pending {
  url: string;
  role: PageRole;
  clicks: number;
  from: string | null;
  label: string;
}

function order(a: Pending, b: Pending): number {
  return a.clicks - b.clicks || ROLE_RANK[a.role] - ROLE_RANK[b.role];
}

const PATH_ROLES: ReadonlySet<PageRole> = new Set([
  "category",
  "product",
  "cart",
  "booking",
  "checkout",
]);

export class SiteWalkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteWalkError";
  }
}

/** Walk the site from its home page. Reads only; throws only when the home page can't be read. */
export async function walkSite(
  homeUrl: string,
  fetcher: PageFetcher,
  caps: { max_reads?: number; max_depth?: number; max_link_checks?: number } = {},
): Promise<WalkResult> {
  const maxReads = caps.max_reads ?? WALK_CAPS.max_reads;
  const maxDepth = caps.max_depth ?? WALK_CAPS.max_depth;
  const maxChecks = caps.max_link_checks ?? WALK_CAPS.max_link_checks;

  const pages: WalkedPage[] = [];
  const statusOf = new Map<string, { status: number | null; error: string | null }>();
  const linksOn = new Map<string, PageLink[]>();
  const refused = new Map<string, NeverFollow>();
  const queued = new Set<string>();
  let reads = 0;
  let platform: PlatformVerdict | null = null;
  let origin: string | null = null;

  const queue: Pending[] = [
    { url: homeUrl, role: "home", clicks: 0, from: null, label: EN("walk.home") },
  ];
  queued.add(homeUrl);

  while (queue.length > 0 && reads < maxReads) {
    queue.sort(order);
    const next = queue.shift() as Pending;
    reads += 1;
    let html = "";
    let status: number | null = null;
    let error: string | null = null;
    let finalUrl = next.url;
    try {
      const page = await fetcher(next.url);
      status = page.status;
      html = page.status < 400 ? page.html : "";
      finalUrl = page.url;
      if (next.role === "home") {
        if (page.status >= 400) {
          throw new SiteWalkError(EN("walk.homeStatus", { status: String(page.status) }));
        }
        origin = new URL(page.url).origin;
        platform = detectPlatform(page.html, page.headers);
      }
    } catch (e) {
      if (next.role === "home") {
        throw e instanceof SiteWalkError
          ? e
          : new SiteWalkError(e instanceof Error ? e.message : EN("walk.homeUnread"));
      }
      error = e instanceof Error ? e.message : EN("walk.unread");
    }
    statusOf.set(next.url, { status, error });
    // A redirect elsewhere (the cart → a hosted checkout) is not followed further.
    const stayed = origin !== null && new URL(finalUrl).origin === origin;
    const links = html && stayed ? pageLinks(html, finalUrl) : [];
    linksOn.set(next.url, links);
    const role = next.role;
    pages.push({
      url: next.url,
      role,
      clicks: next.clicks,
      from: next.from,
      label: next.label,
      status,
      error,
      price_first_screen:
        html && (role === "product" || role === "service")
          ? showsPrice(firstScreenText(html))
          : null,
      forms: html && (role === "contact" || role === "booking") ? countForms(html) : null,
      add_to_cart: html !== "" && role === "product" && hasAddToCart(html),
      checkout_control:
        html !== "" &&
        (role === "cart" || role === "product") &&
        hasCheckoutControl(html, finalUrl),
    });

    if (next.clicks >= maxDepth) continue;
    for (const link of links) {
      if (link.never_follow) {
        if (!refused.has(link.url)) refused.set(link.url, link.never_follow);
        continue;
      }
      if (!link.same_origin || link.role === "other" || link.role === "home") continue;
      if (queued.has(link.url)) continue;
      queued.add(link.url);
      queue.push({
        url: link.url,
        role: link.role,
        clicks: next.clicks + 1,
        from: next.url,
        label: link.text || link.role,
      });
    }
  }

  // Broken links: every same-origin link the read pages offer, read or tried.
  const broken: BrokenLink[] = [];
  const pathPages = new Set(
    pages.filter((p) => PATH_ROLES.has(p.role) || p.role === "home").map((p) => p.url),
  );
  const toCheck: { url: string; found_on: string; role: PageRole }[] = [];
  const considered = new Set<string>();
  for (const page of pages) {
    for (const link of linksOn.get(page.url) ?? []) {
      if (!link.same_origin || link.never_follow || considered.has(link.url)) continue;
      considered.add(link.url);
      toCheck.push({ url: link.url, found_on: page.url, role: link.role });
    }
  }
  let checks = 0;
  for (const link of toCheck) {
    let seen = statusOf.get(link.url);
    if (!seen) {
      if (checks >= maxChecks) continue;
      checks += 1;
      reads += 1;
      try {
        const answer = await fetcher(link.url);
        seen = { status: answer.status, error: null };
      } catch (e) {
        seen = { status: null, error: e instanceof Error ? e.message : EN("walk.unloaded") };
      }
      statusOf.set(link.url, seen);
    }
    if (seen.status !== null && seen.status < 400) continue;
    broken.push({
      url: link.url,
      found_on: link.found_on,
      status: seen.status,
      reason:
        seen.status !== null
          ? EN("walk.answers", { status: String(seen.status) })
          : (seen.error ?? EN("walk.unloaded")),
      on_path: pathPages.has(link.found_on) || PATH_ROLES.has(link.role),
    });
  }

  return {
    home: homeUrl,
    pages,
    path: purchasePath(pages, linksOn, refused),
    broken,
    refused: [...refused.entries()].map(([url, reason]) => ({ url, reason })),
    reads,
    platform,
  };
}

/** The chain of pages from home to `page`, home first. */
function chain(pages: readonly WalkedPage[], page: WalkedPage): WalkedPage[] {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const out: WalkedPage[] = [];
  let at: WalkedPage | undefined = page;
  while (at && out.length < 10) {
    out.unshift(at);
    at = at.from ? byUrl.get(at.from) : undefined;
  }
  return out;
}

const stepOf = (p: WalkedPage): PathStep => ({
  label: p.role === "home" ? EN("walk.home") : p.label,
  url: p.url,
  clicks: p.clicks,
  kind: "page",
});

/** Pure: the path to buying from what the walk read. Exported for tests. */
export function purchasePath(
  pages: readonly WalkedPage[],
  linksOn: ReadonlyMap<string, readonly PageLink[]>,
  refused: ReadonlyMap<string, NeverFollow>,
): PurchasePath {
  const readable = pages.filter((p) => p.status !== null && p.status < 400);
  const byClicks = (role: PageRole) =>
    readable.filter((p) => p.role === role).sort((a, b) => a.clicks - b.clicks)[0];

  const product = readable
    .filter((p) => p.role === "product")
    .sort((a, b) => Number(b.add_to_cart) - Number(a.add_to_cart) || a.clicks - b.clicks)[0];
  const cart = byClicks("cart");
  if (product) {
    const steps = chain(pages, product).map(stepOf);
    const notes = [EN("walk.note.counted")];
    if (!product.add_to_cart) {
      notes.push(EN("walk.note.noAddToCart", { label: product.label }));
      return { kind: "shop", steps, clicks: null, notes };
    }
    steps.push({
      label: EN("walk.addToCart"),
      url: null,
      clicks: product.clicks + 1,
      kind: "control",
    });
    steps.push({
      label: EN("walk.checkout"),
      url: null,
      clicks: product.clicks + 2,
      kind: "entry",
    });
    notes.push(EN("walk.note.assumedCart"));
    if (cart && !cart.checkout_control) notes.push(EN("walk.note.cartEmpty"));
    return { kind: "shop", steps, clicks: product.clicks + 2, notes };
  }

  // No product page: a booking entry, read or only linked.
  const booking = byClicks("booking");
  if (booking) {
    return {
      kind: "booking",
      steps: chain(pages, booking).map(stepOf),
      clicks: booking.clicks,
      notes: [EN("walk.note.booking")],
    };
  }
  for (const page of [...readable].sort((a, b) => a.clicks - b.clicks)) {
    const external = (linksOn.get(page.url) ?? []).find(
      (l) => l.never_follow === "external_booking",
    );
    if (external) {
      return {
        kind: "booking",
        steps: [
          ...chain(pages, page).map(stepOf),
          {
            label: EN("walk.external", {
              text: external.text || EN("walk.book"),
              host: new URL(external.url).hostname,
            }),
            url: external.url,
            clicks: page.clicks + 1,
            kind: "entry",
          },
        ],
        clicks: page.clicks + 1,
        notes: [EN("walk.note.external")],
      };
    }
  }
  if (cart) {
    return {
      kind: "shop",
      steps: chain(pages, cart).map(stepOf),
      clicks: null,
      notes: [EN("walk.note.cartOnly")],
    };
  }
  const contact = byClicks("contact");
  if (contact) {
    return {
      kind: "contact",
      steps: chain(pages, contact).map(stepOf),
      clicks: contact.clicks,
      notes: [EN("walk.note.contact")],
    };
  }
  const sawCheckout = [...refused.values()].includes("checkout");
  return {
    kind: "none",
    steps: readable.filter((p) => p.role === "home").map(stepOf),
    clicks: null,
    notes: [EN(sawCheckout ? "walk.note.checkoutOnly" : "walk.note.none")],
  };
}

/**
 * Pure: the pages worth asking PageSpeed about — the home page and up to
 * four key pages, in this order: a product, a service, the cart or booking
 * entry, contact; a category fills a gap. Only same-origin pages that were
 * read; checkout never.
 */
export function keyPages(walk: WalkResult, max: number): { url: string; role: PageRole }[] {
  const readable = walk.pages.filter((p) => p.status !== null && p.status < 400);
  const first = (roles: readonly PageRole[]) =>
    readable
      .filter((p) => roles.includes(p.role))
      .sort((a, b) => a.clicks - b.clicks || Number(b.add_to_cart) - Number(a.add_to_cart))[0];
  const picks: { url: string; role: PageRole }[] = [];
  const add = (p: WalkedPage | undefined) => {
    if (p && !picks.some((x) => x.url === p.url) && picks.length < max)
      picks.push({ url: p.url, role: p.role });
  };
  add(readable.find((p) => p.role === "home"));
  add(first(["product"]));
  add(first(["service"]));
  add(first(["cart", "booking"]));
  add(first(["contact"]));
  add(first(["category"]));
  return picks;
}
