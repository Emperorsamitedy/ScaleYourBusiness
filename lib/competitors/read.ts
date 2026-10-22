// Fetching a competitor's listed pages — feature 35.
//
// Only the pages the owner listed (url, listing_url, price_pages), at most
// five per competitor, each through the hardened site fetcher
// (lib/site/fetch: every hop resolved once, vetted against private and
// reserved ranges, pinned, redirects re-vetted, bytes capped) with a plain
// user agent and a short timeout. GET only, no cookies, no credentials:
// a page that asks for a login is refused, never logged into. robots.txt
// is read first for every origin and obeyed (./robots.ts).

import type { PageFetcher } from "../site/fetch";
import { createGuardedFetcher, SiteFetchError } from "../site/fetch";
import type { PageExtract } from "./extract";
import { extractPage } from "./extract";
import type { RobotsRules } from "./robots";
import { DISALLOW_ALL, robotsAllows, robotsFromResponse } from "./robots";

export const READ_CAPS = {
  /** Pages read per competitor, robots.txt not counted. */
  max_pages_per_competitor: 5,
  /** Per request, every redirect hop included in the helper's own timer. */
  page_timeout_ms: 8_000,
  /** A price list, not a data dump. */
  max_bytes: 600_000,
} as const;

/** Plain and honest: who we are and what we do. robots.txt groups match on "Ledgerline". */
export const COMPETITOR_USER_AGENT =
  "Ledgerline-CompetitorRead/1.0 (reads public pages a customer listed, weekly; honours robots.txt)";

/** The live fetcher: the hardened helper with this reader's agent, timeout and byte cap. */
export const competitorFetcher: PageFetcher = createGuardedFetcher({
  userAgent: COMPETITOR_USER_AGENT,
  timeoutMs: READ_CAPS.page_timeout_ms,
  maxBytes: READ_CAPS.max_bytes,
});

export type PageOutcomeKind = "read" | "refused" | "failed";

export interface PageOutcome {
  url: string;
  outcome: PageOutcomeKind;
  /** Why it was refused or failed, in words for the owner. Null when read. */
  reason: string | null;
  fetched_at: string;
  extract: PageExtract | null;
}

/** Paths that are a sign-in, an account, or a till — never read. */
const LOGIN_PATH =
  /\/(login|log-in|signin|sign-in|signup|sign-up|register|account|accounts|my-account|profile|wp-admin|wp-login\.php|admin|auth|oauth|sso|checkout|cart|basket)(?=[/?#.]|$)/i;

/** Pure: a listed address as a URL we may fetch, or null. */
export function normalizePageUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  url.hash = "";
  return url.toString();
}

/** Pure: whether a URL is a sign-in, account or checkout page. */
export function looksBehindLogin(url: URL): boolean {
  return LOGIN_PATH.test(url.pathname);
}

/** Pure: whether a fetched page is a login form rather than content. */
export function pageAsksForLogin(html: string): boolean {
  return /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html);
}

const reasonOf = (error: unknown): string =>
  error instanceof SiteFetchError
    ? error.message
    : /abort|timeout/i.test(String((error as { name?: string })?.name ?? error))
      ? `no answer within ${READ_CAPS.page_timeout_ms / 1000} seconds`
      : "the page couldn't be reached";

/** The helper's refusals (a private address, credentials, a non-web scheme), as opposed to failures. */
function refusedByHelper(error: unknown): boolean {
  return (
    error instanceof SiteFetchError && /private network|credentials|only http/.test(error.message)
  );
}

/** robots.txt for an origin, read once per run through the same fetcher. */
async function robotsFor(
  origin: string,
  fetcher: PageFetcher,
  cache: Map<string, RobotsRules | { refused: string }>,
): Promise<RobotsRules | { refused: string }> {
  const held = cache.get(origin);
  if (held) return held;
  let rules: RobotsRules | { refused: string };
  try {
    const res = await fetcher(`${origin}/robots.txt`);
    rules = robotsFromResponse(res.status, res.html);
  } catch (error) {
    // An address the helper refuses is refused for every page on it; a
    // robots.txt that can't be reached means no permission (RFC 9309).
    rules = error instanceof SiteFetchError ? { refused: error.message } : DISALLOW_ALL;
  }
  cache.set(origin, rules);
  return rules;
}

/**
 * Read a competitor's listed pages, in the order listed, up to the cap.
 * Never throws: every page ends as read, refused or failed, with a reason.
 */
export async function readListedPages(args: {
  urls: readonly string[];
  fetcher: PageFetcher;
  now: () => Date;
  robotsCache?: Map<string, RobotsRules | { refused: string }>;
}): Promise<PageOutcome[]> {
  const cache = args.robotsCache ?? new Map();
  const out: PageOutcome[] = [];
  const seen = new Set<string>();
  let attempted = 0;
  for (const raw of args.urls) {
    const normal = normalizePageUrl(raw);
    const at = () => args.now().toISOString();
    if (normal === null) {
      out.push({
        url: raw,
        outcome: "refused",
        reason: "that isn't a web address I can read",
        fetched_at: at(),
        extract: null,
      });
      continue;
    }
    if (seen.has(normal)) continue;
    seen.add(normal);
    if (attempted >= READ_CAPS.max_pages_per_competitor) {
      out.push({
        url: normal,
        outcome: "refused",
        reason: CAP_REASON,
        fetched_at: at(),
        extract: null,
      });
      continue;
    }
    attempted++;
    const url = new URL(normal);
    if (looksBehindLogin(url)) {
      out.push({
        url: normal,
        outcome: "refused",
        reason: LOGIN_REASON,
        fetched_at: at(),
        extract: null,
      });
      continue;
    }
    const robots = await robotsFor(url.origin, args.fetcher, cache);
    if ("refused" in robots) {
      out.push({
        url: normal,
        outcome: "refused",
        reason: robots.refused,
        fetched_at: at(),
        extract: null,
      });
      continue;
    }
    if (!robotsAllows(robots, url)) {
      out.push({
        url: normal,
        outcome: "refused",
        reason:
          robots.blanket === "none"
            ? "their robots.txt couldn't be read, so I didn't read the page"
            : "their robots.txt asks robots not to read this page",
        fetched_at: at(),
        extract: null,
      });
      continue;
    }
    try {
      const page = await args.fetcher(normal);
      const fetchedAt = at();
      const landed = new URL(page.url);
      if (
        page.status === 401 ||
        page.status === 403 ||
        looksBehindLogin(landed) ||
        pageAsksForLogin(page.html)
      ) {
        out.push({
          url: normal,
          outcome: "refused",
          reason: LOGIN_REASON,
          fetched_at: fetchedAt,
          extract: null,
        });
        continue;
      }
      if (landed.origin !== url.origin) {
        // A redirect elsewhere: that origin's robots.txt must agree too.
        const theirs = await robotsFor(landed.origin, args.fetcher, cache);
        if ("refused" in theirs || !robotsAllows(theirs, landed)) {
          out.push({
            url: normal,
            outcome: "refused",
            reason: "it redirects to a site whose robots.txt says no",
            fetched_at: fetchedAt,
            extract: null,
          });
          continue;
        }
      }
      if (page.status < 200 || page.status >= 300) {
        out.push({
          url: normal,
          outcome: "failed",
          reason: `the page answered ${page.status}`,
          fetched_at: fetchedAt,
          extract: null,
        });
        continue;
      }
      const type = page.headers["content-type"] ?? "text/html";
      if (!/text\/html|application\/xhtml/i.test(type)) {
        out.push({
          url: normal,
          outcome: "failed",
          reason: "it isn't a web page",
          fetched_at: fetchedAt,
          extract: null,
        });
        continue;
      }
      out.push({
        url: normal,
        outcome: "read",
        reason: null,
        fetched_at: fetchedAt,
        extract: extractPage(page.html),
      });
    } catch (error) {
      out.push({
        url: normal,
        outcome: refusedByHelper(error) ? "refused" : "failed",
        reason: reasonOf(error),
        fetched_at: at(),
        extract: null,
      });
    }
  }
  return out;
}

export const LOGIN_REASON = "it asks for a login, and I never read pages behind one";
export const CAP_REASON = `past the ${READ_CAPS.max_pages_per_competitor}-page limit per competitor`;
