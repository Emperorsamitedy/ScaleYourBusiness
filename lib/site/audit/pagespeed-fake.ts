// A recorded-shape PageSpeed Insights v5, for tests and the local demo seed
// only (P5-11). It answers the one GET path the client calls with bodies in
// the API's shape: `loadingExperience` (CrUX field data, CLS ×100) where a
// page is given field numbers, `lighthouseResult` with the audits the
// parser reads, and Google-style error bodies. No network, ever.

import type {
  PageSpeedFetch,
  PageSpeedRequestInit,
  PageSpeedResponse,
  Strategy,
} from "./pagespeed";
import { PAGESPEED_ORIGIN, PAGESPEED_PATH } from "./pagespeed";

export const FAKE_PAGESPEED_KEY = "AIzaFakePageSpeedKeyForTestsOnly";

/** What the fake says about one page at one strategy. */
export interface FakePageSpeedPage {
  /** Lab numbers. */
  lcp_ms: number;
  cls: number;
  tbt_ms: number;
  page_bytes: number;
  performance: number; // 0–1
  contrast_failures?: number;
  tap_target_failures?: number;
  /** CrUX field numbers; absent means "not enough visitors". */
  field?: { lcp_ms: number; cls: number; inp_ms: number; origin_fallback?: boolean };
}

export interface FakePageSpeedCall {
  url: URL;
  init: PageSpeedRequestInit;
}

export interface FakePageSpeedOptions {
  /** page URL → strategy → numbers. A page not listed gets `fallback`. */
  pages?: Record<string, Partial<Record<Strategy, FakePageSpeedPage>>>;
  fallback?: FakePageSpeedPage;
  respond?: (call: FakePageSpeedCall, n: number) => PageSpeedResponse | null;
  /** Only this key is accepted when set; keyless calls are always accepted. */
  key?: string;
}

export interface FakePageSpeed {
  fetch: PageSpeedFetch;
  calls: FakePageSpeedCall[];
}

export function pagespeedJson(status: number, body: unknown): PageSpeedResponse {
  return { status, json: async () => body };
}

export function pagespeedError(status: number, message: string): PageSpeedResponse {
  return pagespeedJson(status, { error: { code: status, message, status: "ERROR" } });
}

export const QUICK_PAGE: FakePageSpeedPage = {
  lcp_ms: 1800,
  cls: 0.02,
  tbt_ms: 90,
  page_bytes: 900_000,
  performance: 0.93,
  contrast_failures: 0,
  tap_target_failures: 0,
};

function category(value: number, good: number, poor: number): "FAST" | "AVERAGE" | "SLOW" {
  return value <= good ? "FAST" : value <= poor ? "AVERAGE" : "SLOW";
}

function binaryAudit(failing: number | undefined): Record<string, unknown> {
  if (failing === undefined) return { score: null };
  if (failing === 0) return { score: 1, details: { items: [] } };
  return {
    score: 0,
    details: {
      items: Array.from({ length: failing }, (_, i) => ({ node: { snippet: `<a id="n${i}">` } })),
    },
  };
}

/** The body Google would return for these numbers. */
export function pagespeedBody(
  pageUrl: string,
  strategy: Strategy,
  p: FakePageSpeedPage,
  fetchTime: string,
): unknown {
  const body: Record<string, unknown> = {
    kind: "pagespeedonline#result",
    id: pageUrl,
    analysisUTCTimestamp: fetchTime,
    lighthouseResult: {
      requestedUrl: pageUrl,
      finalUrl: pageUrl,
      finalDisplayedUrl: pageUrl,
      lighthouseVersion: "12.2.1",
      fetchTime,
      configSettings: { formFactor: strategy },
      categories: { performance: { score: p.performance }, accessibility: { score: 0.9 } },
      audits: {
        "largest-contentful-paint": { numericValue: p.lcp_ms },
        "cumulative-layout-shift": { numericValue: p.cls },
        "total-blocking-time": { numericValue: p.tbt_ms },
        "total-byte-weight": { numericValue: p.page_bytes },
        "color-contrast": binaryAudit(p.contrast_failures),
        "target-size": binaryAudit(p.tap_target_failures),
      },
    },
  };
  if (p.field) {
    body["loadingExperience"] = {
      id: pageUrl,
      overall_category: category(p.field.lcp_ms, 2500, 4000),
      ...(p.field.origin_fallback ? { origin_fallback: true } : {}),
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: {
          percentile: p.field.lcp_ms,
          category: category(p.field.lcp_ms, 2500, 4000),
        },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: {
          percentile: Math.round(p.field.cls * 100),
          category: category(p.field.cls, 0.1, 0.25),
        },
        INTERACTION_TO_NEXT_PAINT: {
          percentile: p.field.inp_ms,
          category: category(p.field.inp_ms, 200, 500),
        },
      },
    };
  }
  return body;
}

export function fakePageSpeed(options: FakePageSpeedOptions = {}): FakePageSpeed {
  const calls: FakePageSpeedCall[] = [];
  const fetch: PageSpeedFetch = async (raw, init) => {
    const url = new URL(raw);
    const call = { url, init };
    calls.push(call);
    const scripted = options.respond?.(call, calls.length);
    if (scripted) return scripted;
    if (url.origin !== PAGESPEED_ORIGIN || url.pathname !== PAGESPEED_PATH) {
      return pagespeedError(404, "Not Found");
    }
    if (url.searchParams.has("key")) return pagespeedError(400, "the key belongs in a header");
    const key = init.headers["x-goog-api-key"];
    if (options.key !== undefined && key !== undefined && key !== options.key) {
      return pagespeedError(400, "API key not valid. Please pass a valid API key.");
    }
    const page = url.searchParams.get("url") ?? "";
    const strategy = (url.searchParams.get("strategy") ?? "mobile") as Strategy;
    const numbers = options.pages?.[page]?.[strategy] ?? options.fallback ?? QUICK_PAGE;
    return pagespeedJson(200, pagespeedBody(page, strategy, numbers, new Date().toISOString()));
  };
  return { fetch, calls };
}
