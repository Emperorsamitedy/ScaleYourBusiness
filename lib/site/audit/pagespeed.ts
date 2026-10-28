// Page speed and mobile — Phase 5 Session C (P5-11), site-audit §2 Tier 1.
//
// READ-ONLY, FOREVER (rules 9 and 30). This module asks Google's public
// PageSpeed Insights API v5 about a public page, with one GET to one path
// (/pagespeedonline/v5/runPagespeed) and nothing else: its fetch type
// admits no other verb, and audit.test.ts scans this source and fails the
// build if that changes. Google loads the page in its own browser; SYB
// runs no browser and renders nothing itself.
//
// THE KEY. PAGESPEED_API_KEY is needed in practice: the keyless quota is
// zero (every keyless call answered 429, "limit value 0", checked against
// the live API 2026-10-28), so the service never calls without one. The
// client still accepts null so its tests can prove a keyless call sends no key.
// With it, the key travels in the X-Goog-Api-Key header, never in a URL
// (verify at build: that the header is honoured for this API as for other
// Google REST APIs; the documented form is a "key" query parameter). A Google API key
// restricted to this one API reads public pages and nothing else, so it
// carries no scope at all; the research registry records exactly that.
//
// WHAT COMES BACK, HONESTLY. Two kinds of number, never mixed:
//   · FIELD data — real Chrome users' experience over the last 28 days
//     (the Chrome UX Report, `loadingExperience`), present only for pages
//     with enough visitors. When Google has none for the page but has some
//     for the whole site it says so (`origin_fallback`), and so do we.
//   · LAB data — one Lighthouse load on Google's emulated phone or desktop
//     (`lighthouseResult`). Lab has no INP: interaction needs a real user.
//     Total Blocking Time is shown in its place, named as the stand-in.
//
// PROVISIONAL. Field and audit names follow the API as remembered and are
// on the verify-at-build list in TASKS-PHASE5.md, Session C.

export const PAGESPEED_ORIGIN = "https://www.googleapis.com";
export const PAGESPEED_PATH = "/pagespeedonline/v5/runPagespeed";
export const PAGESPEED_SOURCE = "pagespeed_insights" as const;

export const STRATEGIES = ["mobile", "desktop"] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** Rule 2, research edition: every one of these is a ceiling. */
export const PAGESPEED_CAPS = {
  /** The home page and up to four key pages (P5-11). */
  max_pages: 5,
  /** Calls per site per rolling 7 days: two full audits (5 pages × 2 strategies × 2). */
  max_calls_per_site_per_week: 20,
  /** Attempts per call on a rate limit, a 5xx or a network failure. */
  max_attempts: 2,
  /** Calls in flight at once. */
  concurrency: 3,
  /** Google loads the page in a real browser: allow it time. */
  timeout_ms: 90_000,
} as const;

/** The Lighthouse categories asked for — and so the only audits that can come back. */
export const PAGESPEED_CATEGORIES = ["performance", "accessibility"] as const;

/* ── the HTTP seam: GET, and nothing else ── */

export interface PageSpeedRequestInit {
  /** The only verb the type admits. */
  method: "GET";
  headers: Record<string, string>;
}

export interface PageSpeedResponse {
  status: number;
  json(): Promise<unknown>;
}

export type PageSpeedFetch = (
  url: string,
  init: PageSpeedRequestInit,
) => Promise<PageSpeedResponse>;

export class PageSpeedError extends Error {
  /** "quota" — the shared or keyed quota is spent; "page" — Google couldn't load it; "service" — the API failed. */
  readonly kind: "quota" | "page" | "service";
  constructor(kind: "quota" | "page" | "service", message: string) {
    super(message);
    this.name = "PageSpeedError";
    this.kind = kind;
  }
}

/** The query string for one runPagespeed call. Pure, exported for tests. The key is never here. */
export function pagespeedParams(pageUrl: string, strategy: Strategy): URLSearchParams {
  const params = new URLSearchParams({ url: pageUrl, strategy });
  for (const category of PAGESPEED_CATEGORIES) params.append("category", category);
  return params;
}

export function pagespeedUrl(pageUrl: string, strategy: Strategy): string {
  return `${PAGESPEED_ORIGIN}${PAGESPEED_PATH}?${pagespeedParams(pageUrl, strategy).toString()}`;
}

/* ── what one call becomes ── */

/** Google's Chrome UX Report buckets, verbatim from the API. */
export type FieldCategory = "FAST" | "AVERAGE" | "SLOW";

export interface FieldMetric {
  /** The 75th percentile, in the metric's own unit (ms, or unitless for CLS). */
  p75: number;
  category: FieldCategory | null;
}

export interface FieldData {
  lcp_ms: FieldMetric | null;
  cls: FieldMetric | null;
  inp_ms: FieldMetric | null;
  /** True when Google had no data for this page and answered for the whole site instead. */
  origin_fallback: boolean;
}

export interface LabData {
  lcp_ms: number | null;
  cls: number | null;
  /** Total Blocking Time — the lab's stand-in for INP, which only real users can produce. */
  tbt_ms: number | null;
  /** Every byte the page loaded, scripts and images included. */
  page_bytes: number | null;
  /** Lighthouse performance score, 0–100. */
  performance_score: number | null;
  /** Elements whose text fails the contrast check; null when the audit didn't run. */
  contrast_failures: number | null;
  /** Tap targets too small or too close; null when the audit didn't run. */
  tap_target_failures: number | null;
}

/** One page, one strategy, as measured — with where every number came from (rule 2). */
export interface PageSpeedResult {
  page_url: string;
  strategy: Strategy;
  /** Field data where Google has it; null when the page and site have too few visitors. */
  field: FieldData | null;
  lab: LabData;
  provenance: {
    source: typeof PAGESPEED_SOURCE;
    api: "v5 runPagespeed";
    /** When Google ran Lighthouse (lighthouseResult.fetchTime), else when we asked. */
    measured_at: string;
    lighthouse_version: string | null;
    /** The page Lighthouse ended on, after redirects. */
    final_url: string | null;
    /** True when PAGESPEED_API_KEY was set; false means no key was sent. */
    keyed: boolean;
  };
}

const num = (raw: unknown): number | null =>
  typeof raw === "number" && Number.isFinite(raw) ? raw : null;

const obj = (raw: unknown): Record<string, unknown> | null =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;

function fieldMetric(
  metrics: Record<string, unknown>,
  keys: readonly string[],
  scale = 1,
): FieldMetric | null {
  for (const key of keys) {
    const m = obj(metrics[key]);
    const p = num(m?.["percentile"]);
    if (m && p !== null) {
      const c = m["category"];
      return {
        p75: p / scale,
        category: c === "FAST" || c === "AVERAGE" || c === "SLOW" ? c : null,
      };
    }
  }
  return null;
}

/** Pure: the CrUX block, or null when it carries no metric at all. */
export function parseFieldData(raw: unknown): FieldData | null {
  const block = obj(raw);
  const metrics = obj(block?.["metrics"]);
  if (!block || !metrics) return null;
  const field: FieldData = {
    lcp_ms: fieldMetric(metrics, ["LARGEST_CONTENTFUL_PAINT_MS"]),
    // CrUX reports CLS ×100 as an integer percentile (verify at build): 5 means 0.05.
    cls: fieldMetric(metrics, ["CUMULATIVE_LAYOUT_SHIFT_SCORE"], 100),
    inp_ms: fieldMetric(metrics, [
      "INTERACTION_TO_NEXT_PAINT",
      "EXPERIMENTAL_INTERACTION_TO_NEXT_PAINT",
    ]),
    origin_fallback: block["origin_fallback"] === true,
  };
  if (!field.lcp_ms && !field.cls && !field.inp_ms) return null;
  return field;
}

function audit(audits: Record<string, unknown>, id: string): Record<string, unknown> | null {
  return obj(audits[id]);
}

/** Failing items of a binary accessibility audit: 0 when it passed, null when it didn't run. */
function failures(a: Record<string, unknown> | null): number | null {
  if (!a) return null;
  const score = a["score"];
  if (score === 1) return 0;
  if (score !== 0) return null; // null score: not applicable or errored — unknown, not zero (rule 5)
  const items = obj(a["details"])?.["items"];
  return Array.isArray(items) ? Math.max(items.length, 1) : 1;
}

/** Pure: one runPagespeed body → a result. Throws PageSpeedError when Lighthouse couldn't load the page. */
export function parsePageSpeed(
  body: unknown,
  pageUrl: string,
  strategy: Strategy,
  keyed: boolean,
  askedAt: Date,
): PageSpeedResult {
  const root = obj(body) ?? {};
  const lh = obj(root["lighthouseResult"]);
  if (!lh) throw new PageSpeedError("page", "Google returned no page measurement");
  const runtime = obj(lh["runtimeError"]);
  if (runtime && typeof runtime["code"] === "string" && runtime["code"] !== "NO_ERROR") {
    throw new PageSpeedError("page", `Google couldn't load the page (${runtime["code"]})`);
  }
  const audits = obj(lh["audits"]) ?? {};
  const perf = num(obj(obj(lh["categories"])?.["performance"])?.["score"]);
  const tap = audit(audits, "target-size") ?? audit(audits, "tap-targets");
  const lab: LabData = {
    lcp_ms: num(audit(audits, "largest-contentful-paint")?.["numericValue"]),
    cls: num(audit(audits, "cumulative-layout-shift")?.["numericValue"]),
    tbt_ms: num(audit(audits, "total-blocking-time")?.["numericValue"]),
    page_bytes: num(audit(audits, "total-byte-weight")?.["numericValue"]),
    performance_score: perf === null ? null : Math.round(perf * 100),
    contrast_failures: failures(audit(audits, "color-contrast")),
    tap_target_failures: failures(tap),
  };
  const fetchTime = typeof lh["fetchTime"] === "string" ? lh["fetchTime"] : null;
  const finalUrl =
    typeof lh["finalDisplayedUrl"] === "string"
      ? lh["finalDisplayedUrl"]
      : typeof lh["finalUrl"] === "string"
        ? lh["finalUrl"]
        : null;
  return {
    page_url: pageUrl,
    strategy,
    field: parseFieldData(root["loadingExperience"]),
    lab,
    provenance: {
      source: PAGESPEED_SOURCE,
      api: "v5 runPagespeed",
      measured_at:
        fetchTime && !Number.isNaN(Date.parse(fetchTime))
          ? new Date(fetchTime).toISOString()
          : askedAt.toISOString(),
      lighthouse_version:
        typeof lh["lighthouseVersion"] === "string" ? lh["lighthouseVersion"] : null,
      final_url: finalUrl,
      keyed,
    },
  };
}

/* ── the client ── */

export interface PageSpeedClient {
  /** One page at one strategy. Counts against the caller's cap before it is sent. */
  run(pageUrl: string, strategy: Strategy): Promise<PageSpeedResult>;
  /** HTTP requests made so far, retries included. */
  readonly requests: number;
}

export interface PageSpeedClientOptions {
  /** PAGESPEED_API_KEY, or null to send none (the service never calls keyless). */
  apiKey: string | null;
  fetch?: PageSpeedFetch;
  sleep?: (ms: number) => Promise<void>;
  /** Requests this client may make in all — the weekly budget left for the site. */
  maxRequests: number;
  now?: () => Date;
}

const realFetch: PageSpeedFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    signal: AbortSignal.timeout(PAGESPEED_CAPS.timeout_ms),
  });
  return { status: response.status, json: () => response.json() };
};

function backoffMs(attempt: number): number {
  return 2000 * 2 ** (attempt - 1);
}

export function createPageSpeedClient(options: PageSpeedClientOptions): PageSpeedClient {
  const doFetch = options.fetch ?? realFetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => new Date());
  const keyed = options.apiKey !== null;
  let requests = 0;

  return {
    get requests() {
      return requests;
    },
    async run(pageUrl, strategy) {
      const url = pagespeedUrl(pageUrl, strategy);
      const headers: Record<string, string> = { accept: "application/json" };
      if (options.apiKey !== null) headers["x-goog-api-key"] = options.apiKey;
      for (let attempt = 1; ; attempt += 1) {
        if (requests >= options.maxRequests) {
          throw new PageSpeedError("quota", "this week's PageSpeed calls for the site are used");
        }
        requests += 1;
        const askedAt = now();
        let response: PageSpeedResponse;
        try {
          response = await doFetch(url, { method: "GET", headers });
        } catch {
          if (attempt >= PAGESPEED_CAPS.max_attempts) {
            throw new PageSpeedError("service", "Google's PageSpeed service could not be reached");
          }
          await sleep(backoffMs(attempt));
          continue;
        }
        const body = await response.json().catch(() => null);
        if (response.status === 200) return parsePageSpeed(body, pageUrl, strategy, keyed, askedAt);
        const message = String(obj(obj(body)?.["error"])?.["message"] ?? "");
        if (response.status === 429) {
          if (attempt < PAGESPEED_CAPS.max_attempts) {
            await sleep(backoffMs(attempt));
            continue;
          }
          throw new PageSpeedError(
            "quota",
            keyed
              ? "Google's PageSpeed quota for SYB's key is spent for now"
              : "Google's shared PageSpeed quota is spent for now (no PAGESPEED_API_KEY is set)",
          );
        }
        if (response.status >= 500 && attempt < PAGESPEED_CAPS.max_attempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        if (response.status === 400 || response.status === 404) {
          // Lighthouse failing to load the page comes back as a 400 (verify at build).
          throw new PageSpeedError(
            "page",
            /FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|NO_FCP|unable to process/i.test(
              message,
            )
              ? "Google couldn't load the page to measure it"
              : `Google refused to measure the page (status ${response.status})`,
          );
        }
        throw new PageSpeedError(
          "service",
          response.status === 403
            ? "Google refused the PageSpeed key (status 403) — check that the key allows the PageSpeed Insights API"
            : `Google's PageSpeed service failed (status ${response.status})`,
        );
      }
    },
  };
}
