// The Meta Ad Library reader — Phase 3 Session K (P3-50).
//
// READ-ONLY, FOREVER (rule 9). This module issues GET requests to exactly
// two Graph paths — /me/permissions and /ads_archive — and nothing else;
// its fetch type admits no other verb, and ad-library.test.ts scans this
// source and fails the build if that changes. The token travels in an
// Authorization header, never in a URL. Before the Library is asked, the
// token's own permissions are read and checked against the research
// registry (lib/connectors/scopes.ts): a token that could write anything
// is refused before it is used for anything.
//
// WHO HOLDS THE TOKEN. SYB does, not the owner: a user access token from a
// developer account whose identity Meta has confirmed, in
// META_AD_LIBRARY_TOKEN. No OAuth flow — there is nothing the owner grants,
// because the Library is public. Absent token: the read never starts and
// the screen says what is missing (lib/research/niche.ts).
//
// WHAT THE LIBRARY HAS, HONESTLY. Commercial (non-political) ads appear in
// the API only for ads delivered in the EU — the Digital Services Act's
// transparency rule — and, by the owner's brief, the UK (verify at build).
// Anywhere else it returns political and issue ads only, so a business
// outside that coverage gets no read and a sentence saying why. The Library
// carries NO performance figures for commercial ads: no spend, no
// impressions, no results. Running time and the number of versions an
// advertiser keeps live are the only honest proxies for "working", and the
// screen says that in words (lib/research/niche-ads.ts).
//
// WHAT IS NEVER ASKED FOR. Targeting, reach breakdowns, beneficiaries and
// payers, bylines, spend — none of it is requested, so none of it can be
// stored. Nor is ad_snapshot_url: it embeds the reader's access token
// (verify at build); the public Library link is built from the ad's id.
//
// PROVISIONAL. Parameter and field names follow Meta's Ad Library API as
// documented (ads_archive: search_terms, search_page_ids,
// ad_reached_countries, ad_active_status, ad_type, media_type,
// ad_delivery_date_min, search_type, fields, limit) and are on the
// verify-at-build list in TASKS-PHASE3.md, Session K.

import { RESEARCH_SOURCE_REGISTRY, verifyResearchGrant } from "../connectors/scopes";

export const AD_LIBRARY_API_VERSION = "v26.0";
export const AD_LIBRARY_ORIGIN = "https://graph.facebook.com";
export const AD_LIBRARY_SOURCE = "meta_ad_library" as const;

/** Rule 2, research edition: every one of these is a ceiling. */
export const AD_LIBRARY_CAPS = {
  /** HTTP requests per read, the permission check included. */
  max_requests_per_read: 10,
  /** Ads asked for per request (the API's `limit`). */
  page_size: 25,
  /** Ads kept per read, across every query. */
  max_ads_per_read: 100,
  /** Characters of an ad's body kept — enough for its hook, offer, CTA and the copy check. */
  max_body_chars: 600,
  /** Characters of an ad's headline kept. */
  max_title_chars: 120,
  /** search_terms is limited to 100 characters by Meta. */
  max_term_chars: 100,
  /** search_page_ids takes at most ten ids per request. */
  max_page_ids: 10,
  /** How far back delivery is read: long runners started a while ago. */
  lookback_days: 365,
  /** Attempts per request on a rate limit or a 5xx. */
  max_attempts: 3,
} as const;

/** The fields asked for — and so the only ones that can ever be stored. */
export const AD_LIBRARY_FIELDS = [
  "id",
  "page_id",
  "page_name",
  "ad_creative_bodies",
  "ad_creative_link_titles",
  "ad_delivery_start_time",
  "ad_delivery_stop_time",
  "publisher_platforms",
] as const;

/* ── coverage ── */

/** EU member states: the DSA's transparency rule puts their commercial ads in the Library. */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

/** The UK, per the owner's brief — verify at build that commercial ads come back for GB. */
export const COVERED_COUNTRIES: ReadonlySet<string> = new Set([...EU_COUNTRIES, "GB"]);

/** Free-text country (question 1.1b) → ISO alpha-2. Normalised; unknown → null, never a guess. */
const COUNTRY_CODES: Readonly<Record<string, string>> = {
  austria: "AT",
  belgium: "BE",
  bulgaria: "BG",
  croatia: "HR",
  cyprus: "CY",
  czechia: "CZ",
  czech: "CZ",
  denmark: "DK",
  estonia: "EE",
  finland: "FI",
  france: "FR",
  germany: "DE",
  deutschland: "DE",
  greece: "GR",
  hungary: "HU",
  magyarorszag: "HU",
  ireland: "IE",
  eire: "IE",
  italy: "IT",
  italia: "IT",
  latvia: "LV",
  lithuania: "LT",
  luxembourg: "LU",
  malta: "MT",
  netherlands: "NL",
  holland: "NL",
  poland: "PL",
  polska: "PL",
  portugal: "PT",
  romania: "RO",
  slovakia: "SK",
  slovenia: "SI",
  spain: "ES",
  espana: "ES",
  sweden: "SE",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  "united states": "US",
  "united states america": "US",
  usa: "US",
  us: "US",
  america: "US",
  canada: "CA",
  australia: "AU",
  "new zealand": "NZ",
  switzerland: "CH",
  norway: "NO",
  iceland: "IS",
  serbia: "RS",
  ukraine: "UA",
  turkey: "TR",
  india: "IN",
  "south africa": "ZA",
  mexico: "MX",
  brazil: "BR",
  japan: "JP",
};

function normalise(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\b(the|republic|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pure: the ISO alpha-2 code for a country the owner typed, or null. */
export function countryCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const up = trimmed.toUpperCase();
    return up === "UK" ? "GB" : up;
  }
  return COUNTRY_CODES[normalise(trimmed)] ?? null;
}

export type Coverage =
  { covered: true; country: string } | { covered: false; country: string | null; why: string };

/** Pure: whether the Library can show commercial ads for this business's country, in words when not. */
export function adLibraryCoverage(rawCountry: unknown): Coverage {
  const country = countryCode(rawCountry);
  if (country === null) {
    return {
      covered: false,
      country: null,
      why: "I don't know which country the business is in, and Meta's Ad Library only shows ordinary business ads that reached the EU or the UK. Add your country to your fact sheet and I can look.",
    };
  }
  if (COVERED_COUNTRIES.has(country)) return { covered: true, country };
  return {
    covered: false,
    country,
    why: "Meta's Ad Library only shows ordinary business ads that reached the EU or the UK. Outside them it shows political and issue ads only, so there is nothing about your niche for me to read.",
  };
}

/* ── the HTTP seam: GET, and nothing else ── */

export interface AdLibraryRequestInit {
  /** The only verb the type admits. */
  method: "GET";
  headers: Record<string, string>;
}

export interface AdLibraryResponse {
  status: number;
  json(): Promise<unknown>;
}

export type AdLibraryFetch = (
  url: string,
  init: AdLibraryRequestInit,
) => Promise<AdLibraryResponse>;

export class AdLibraryError extends Error {
  /** "token" — the token is missing, refused or over-permissive; "library" — Meta failed. */
  readonly kind: "token" | "library";
  constructor(kind: "token" | "library", message: string) {
    super(message);
    this.name = "AdLibraryError";
    this.kind = kind;
  }
}

type LibraryPath = "permissions" | "ads_archive";

function pathFor(which: LibraryPath): string {
  return which === "permissions"
    ? `/${AD_LIBRARY_API_VERSION}/me/permissions`
    : `/${AD_LIBRARY_API_VERSION}/ads_archive`;
}

const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613]);
const AUTH_CODES: ReadonlySet<number> = new Set([102, 190]);
/** 10 / 200: permission denied — for ads_archive, an unconfirmed identity looks like this (verify at build). */
const PERMISSION_CODES: ReadonlySet<number> = new Set([10, 200, 294]);

function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

/* ── what one ad becomes ── */

export type AdFormat = "video" | "image" | "multi";

/** One ad, minimised to what the analysis needs. Page names are businesses. */
export interface LibraryAd {
  /** The Library's id: the public link is https://www.facebook.com/ads/library/?id=<id>. */
  id: string;
  page_id: string;
  page_name: string;
  /** The first creative body, trimmed and capped. "" when the ad has no text. */
  body: string;
  /** How many distinct bodies the ad carries (dynamic creative or several cards). */
  bodies: number;
  /** The first headline, capped; null when none. */
  title: string | null;
  /** How many distinct headlines (several cards or versions). */
  titles: number;
  /** "YYYY-MM-DD". */
  started: string;
  /** "YYYY-MM-DD", or null while it is still running. */
  stopped: string | null;
  platforms: string[];
  /** From which query found it (media_type), and several headlines meaning several cards or versions. */
  format: AdFormat;
  /** Which query found it: the term, or the listed competitor. */
  found_by: { kind: "term"; term: string } | { kind: "competitor"; competitor_id: string };
}

/** The public, token-free Library link for an ad. */
export function libraryUrl(adId: string): string {
  return `https://www.facebook.com/ads/library/?id=${encodeURIComponent(adId)}`;
}

const day = (raw: unknown): string | null =>
  typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;

const strings = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim())
    : [];

const cap = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Pure: one row of an ads_archive response, minimised. Null when it lacks
 * what the analysis needs (an id, a page, a start date) — skipped, not guessed.
 */
export function parseAd(
  raw: unknown,
  media: "VIDEO" | "IMAGE",
  foundBy: LibraryAd["found_by"],
): LibraryAd | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r["id"] === "string" ? r["id"] : null;
  const pageId = typeof r["page_id"] === "string" ? r["page_id"] : null;
  const pageName = typeof r["page_name"] === "string" ? r["page_name"].trim() : "";
  const started = day(r["ad_delivery_start_time"]);
  if (!id || !pageId || pageName === "" || !started) return null;
  const bodies = [...new Set(strings(r["ad_creative_bodies"]))];
  const titles = [...new Set(strings(r["ad_creative_link_titles"]))];
  const platforms = strings(r["publisher_platforms"]).map((p) => p.toLowerCase());
  return {
    id,
    page_id: pageId,
    page_name: cap(pageName, 120),
    body: cap(bodies[0] ?? "", AD_LIBRARY_CAPS.max_body_chars),
    bodies: bodies.length,
    title: titles[0] ? cap(titles[0], AD_LIBRARY_CAPS.max_title_chars) : null,
    titles: titles.length,
    started,
    stopped: day(r["ad_delivery_stop_time"]),
    platforms,
    format: media === "VIDEO" ? "video" : titles.length >= 2 ? "multi" : "image",
    found_by: foundBy,
  };
}

/* ── the client ── */

export interface AdLibraryQuery {
  country: string;
  /** A keyword search… */
  term?: string;
  /** …or a listed competitor's Facebook page ids (at most ten). */
  page_ids?: readonly string[];
  /** Exact phrase for a business's name; unordered keywords for a niche term. */
  exact?: boolean;
  media: "VIDEO" | "IMAGE";
  /** "YYYY-MM-DD": ads delivered on or after it. */
  delivered_since: string;
}

export interface AdLibraryClient {
  /** The token's permissions, verified read-only against the research registry. Throws when not. */
  checkToken(): Promise<string[]>;
  /** One page of ads for one query. */
  search(query: AdLibraryQuery): Promise<unknown[]>;
  /** Requests made so far, against AD_LIBRARY_CAPS.max_requests_per_read. */
  readonly requests: number;
}

export interface AdLibraryClientOptions {
  token: string;
  fetch?: AdLibraryFetch;
  sleep?: (ms: number) => Promise<void>;
}

/** The query string for one ads_archive request. Pure, exported for tests. */
export function archiveParams(query: AdLibraryQuery): URLSearchParams {
  const params = new URLSearchParams({
    ad_reached_countries: JSON.stringify([query.country]),
    ad_active_status: "ALL",
    ad_type: "ALL",
    media_type: query.media,
    ad_delivery_date_min: query.delivered_since,
    fields: AD_LIBRARY_FIELDS.join(","),
    limit: String(AD_LIBRARY_CAPS.page_size),
  });
  if (query.page_ids && query.page_ids.length > 0) {
    params.set(
      "search_page_ids",
      JSON.stringify(query.page_ids.slice(0, AD_LIBRARY_CAPS.max_page_ids)),
    );
  } else if (query.term) {
    params.set("search_terms", query.term.slice(0, AD_LIBRARY_CAPS.max_term_chars));
    params.set("search_type", query.exact ? "KEYWORD_EXACT_PHRASE" : "KEYWORD_UNORDERED");
  }
  return params;
}

const realFetch: AdLibraryFetch = async (url, init) => {
  const response = await fetch(url, { method: init.method, headers: init.headers });
  return { status: response.status, json: () => response.json() };
};

export function createAdLibraryClient(options: AdLibraryClientOptions): AdLibraryClient {
  const doFetch = options.fetch ?? realFetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let requests = 0;

  async function get(
    which: LibraryPath,
    params: URLSearchParams,
  ): Promise<Record<string, unknown>> {
    const query = params.toString();
    const url = `${AD_LIBRARY_ORIGIN}${pathFor(which)}${query ? `?${query}` : ""}`;
    for (let attempt = 1; ; attempt += 1) {
      if (requests >= AD_LIBRARY_CAPS.max_requests_per_read) {
        throw new AdLibraryError(
          "library",
          `this read's ${AD_LIBRARY_CAPS.max_requests_per_read} requests are used`,
        );
      }
      requests += 1;
      let response: AdLibraryResponse;
      try {
        response = await doFetch(url, {
          method: "GET",
          headers: { authorization: `Bearer ${options.token}`, accept: "application/json" },
        });
      } catch {
        if (attempt >= AD_LIBRARY_CAPS.max_attempts) {
          throw new AdLibraryError("library", "Meta's Ad Library could not be reached");
        }
        await sleep(backoffMs(attempt));
        continue;
      }
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: unknown; message?: unknown };
      } | null;
      const error = body?.error;
      if (response.status === 200 && error === undefined && body !== null) {
        return body as Record<string, unknown>;
      }
      const code = typeof error?.code === "number" ? error.code : null;
      if (code !== null && AUTH_CODES.has(code)) {
        throw new AdLibraryError(
          "token",
          "Meta didn't accept the Ad Library token. It may have expired: make a new one",
        );
      }
      if (code !== null && PERMISSION_CODES.has(code)) {
        throw new AdLibraryError(
          "token",
          "Meta refused the Ad Library token. The account behind it must have confirmed its identity with Meta",
        );
      }
      const retryable =
        (code !== null && RATE_LIMIT_CODES.has(code)) ||
        response.status === 429 ||
        response.status >= 500;
      if (retryable && attempt < AD_LIBRARY_CAPS.max_attempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new AdLibraryError(
        "library",
        retryable
          ? "Meta's Ad Library is busy or unavailable. Try again later"
          : `Meta's Ad Library refused the search (status ${response.status})`,
      );
    }
  }

  return {
    get requests() {
      return requests;
    },
    async checkToken() {
      const body = await get("permissions", new URLSearchParams());
      const data = Array.isArray(body["data"]) ? (body["data"] as unknown[]) : [];
      const granted = data.flatMap((row) => {
        const r = (row ?? {}) as { permission?: unknown; status?: unknown };
        return typeof r.permission === "string" && r.status === "granted" ? [r.permission] : [];
      });
      try {
        verifyResearchGrant(AD_LIBRARY_SOURCE, granted);
      } catch {
        throw new AdLibraryError(
          "token",
          `The Ad Library token carries more than reading needs (${granted
            .filter(
              (p) => !(RESEARCH_SOURCE_REGISTRY.meta_ad_library as readonly string[]).includes(p),
            )
            .join(", ")}). Make one with no extra permissions`,
        );
      }
      return granted;
    },
    async search(query) {
      const body = await get("ads_archive", archiveParams(query));
      return Array.isArray(body["data"]) ? (body["data"] as unknown[]) : [];
    },
  };
}
