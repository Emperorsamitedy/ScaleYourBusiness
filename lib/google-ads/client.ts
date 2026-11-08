// The Google Ads READ client — P2-20. Reads spend and results, and nothing else.
//
// Google offers one scope for the Google Ads API, adwords, and it can change
// campaigns, budgets and ads as well as read them; there is no read-only
// scope. The owner holds it as a write consent (lib/execution/scopes,
// google_ads), and the daily read uses it only to READ. That promise is held
// here, in code: every request this module sends goes through gadsRequest,
// which sends only to an endpoint in GADS_READ_ENDPOINTS, with that
// endpoint's method. Google's search endpoints are POSTs (the GAQL query
// travels in the body), so the fence is the URL path, not the verb: no path
// naming a mutate method, or any other path, can leave from here. GAQL itself is
// a query language with no write statement, and a query must start SELECT.
//
// The only module allowed to name a mutate endpoint is the execution
// provider (lib/execution/providers/google-ads.ts), reached only through
// the engine after a recorded approval. client.test.ts fails the build if
// a mutate method is named in any other source file, if this fence admits a
// mutate path, or if any file in lib/google-ads calls fetch directly.
//
// Read in Google's documentation on 2026-11-08 (specs/google-ads-api-v1.md
// keeps the list, each fact verified: true|false):
//   · newest version v26 (released 2026-10-14, sunset November 2027);
//     base https://googleads.googleapis.com/v26/customers/{id}/googleAds
//   · search: POST …/googleAds:search, body {query, pageToken}; pageSize is
//     refused (PAGE_SIZE_NOT_SUPPORTED), pages are 10,000 rows; the answer
//     holds results, nextPageToken (only when more remain) and fieldMask
//   · searchStream: POST …/googleAds:searchStream, answer a JSON array of
//     batches, each with its own results
//   · headers: Authorization: Bearer <token>; login-customer-id (ten digits,
//     no hyphens) only when reached through a manager account. A developer
//     token is optional and ignored since 2026-09-09 (sent when configured)
//   · REST JSON is lowerCamelCase (metrics.costMicros in a result), GAQL
//     stays snake_case (metrics.cost_micros in the query)
//
// Tokens come from Google's OAuth token endpoint through the Business
// Profile client's own fenced token exchange (lib/google-business/client),
// so SYB has one way to talk to oauth2.googleapis.com.
//
// No line logs a token, a code, a client secret or a response body: only
// the endpoint id and the HTTP status.

import type { GoogleAdsEnv } from "../env";
import { minorUnitExponent } from "../core/money";

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
export const GOOGLE_ADS_API_VERSION = "v26";
export const GOOGLE_ADS_ORIGIN = "https://googleads.googleapis.com";

export type GadsMethod = "GET" | "POST";

export interface GadsEndpoint {
  method: GadsMethod;
  /** The whole path, anchored: no other segment or suffix (such as a mutate method) can match. */
  path: RegExp;
}

const V = GOOGLE_ADS_API_VERSION;
/** A Google Ads customer id: ten digits, no hyphens. */
export const CUSTOMER_ID_RE = /^\d{10}$/;

/** THE FENCE: the only requests the read side can send. Search is a POST; it still only reads. */
export const GADS_READ_ENDPOINTS = {
  search: { method: "POST", path: new RegExp(`^/${V}/customers/\\d{10}/googleAds:search$`) },
  searchStream: {
    method: "POST",
    path: new RegExp(`^/${V}/customers/\\d{10}/googleAds:searchStream$`),
  },
  accessible: { method: "GET", path: new RegExp(`^/${V}/customers:listAccessibleCustomers$`) },
} as const satisfies Record<string, GadsEndpoint>;

export type GadsReadEndpointId = keyof typeof GADS_READ_ENDPOINTS;

/** Pure: which read endpoint a request is, or null when it is on no list (and must not be sent). */
export function allowedReadEndpoint(method: string, url: string): GadsReadEndpointId | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== GOOGLE_ADS_ORIGIN) return null;
  if (u.username !== "" || u.password !== "" || u.hash !== "" || u.search !== "") return null;
  for (const [id, e] of Object.entries(GADS_READ_ENDPOINTS) as [
    GadsReadEndpointId,
    GadsEndpoint,
  ][]) {
    if (method.toUpperCase() === e.method && e.path.test(u.pathname)) return id;
  }
  return null;
}

/** Pure: a GAQL query the read side may send — one SELECT, nothing else. */
export function isReadQuery(query: string): boolean {
  return /^\s*SELECT\s/i.test(query) && !query.includes(";");
}

export type GadsFailureKind =
  "fence" | "auth" | "permission" | "access_level" | "quota" | "unavailable" | "refused";

/** A refusal, in the owner's words, with a kind the read beat and the screens map to fixed text. */
export class GadsRequestError extends Error {
  readonly kind: GadsFailureKind;
  readonly status: number | null;
  constructor(kind: GadsFailureKind, message: string, status: number | null = null) {
    super(message);
    this.name = "GadsRequestError";
    this.kind = kind;
    this.status = status;
  }
}

export const GADS_TIMEOUT_MS = 20_000;
/** Attempts for a read Google says to retry (429, 5xx, no answer). */
export const GADS_MAX_ATTEMPTS = 2;
/** Search pages one read follows at most (Google's pages are 10,000 rows). */
export const GADS_MAX_PAGES = 20;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** What every Google Ads request carries beside the bearer token. */
export type GadsHeaderEnv = Pick<GoogleAdsEnv, "developer_token" | "login_customer_id">;

/** Pure: the request headers. Never logged. */
export function gadsHeaders(accessToken: string, env: GadsHeaderEnv): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
    ...(env.developer_token ? { "developer-token": env.developer_token } : {}),
    ...(env.login_customer_id ? { "login-customer-id": env.login_customer_id } : {}),
  };
}

/** Error codes Google names in a failure's details that mean the access level, not the owner. */
const ACCESS_LEVEL_CODES = [
  "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
  "DEVELOPER_TOKEN_NOT_APPROVED",
  "DEVELOPER_TOKEN_PROHIBITED",
];

/** Pure: a failed answer, in the owner's words. Shared with the execution provider. */
export function gadsFailure(status: number, body: unknown): GadsRequestError {
  const text = JSON.stringify(body ?? "");
  if (ACCESS_LEVEL_CODES.some((code) => text.includes(code))) {
    return new GadsRequestError(
      "access_level",
      "Google hasn't approved SYB's Google Ads access for real ad accounts yet. Nothing was read or changed.",
      status,
    );
  }
  if (status === 401) {
    return new GadsRequestError("auth", "Google no longer accepts SYB's access.", status);
  }
  if (status === 403) {
    return new GadsRequestError(
      "permission",
      "Google says SYB isn't allowed into this Google Ads account.",
      status,
    );
  }
  if (status === 429) {
    return new GadsRequestError("quota", "Google asked SYB to slow down.", status);
  }
  if (status >= 500) return new GadsRequestError("unavailable", "Google didn't answer.", status);
  return new GadsRequestError("refused", "Google refused the request.", status);
}

/**
 * The ONE place the read side sends anything. The request must be on
 * GADS_READ_ENDPOINTS, with that endpoint's method, and a search must carry
 * a single SELECT, or it never leaves.
 */
export async function gadsRequest(
  id: GadsReadEndpointId,
  url: string,
  init: {
    accessToken: string;
    env: GadsHeaderEnv;
    body?: { query: string; pageToken?: string };
  },
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const endpoint: GadsEndpoint = GADS_READ_ENDPOINTS[id];
  if (allowedReadEndpoint(endpoint.method, url) !== id) {
    throw new GadsRequestError("fence", "refusing a request that isn't on SYB's read list");
  }
  if (endpoint.method === "GET" && init.body !== undefined) {
    throw new GadsRequestError("fence", "a read carries no body");
  }
  if (endpoint.method === "POST" && (init.body === undefined || !isReadQuery(init.body.query))) {
    throw new GadsRequestError("fence", "a search carries one SELECT query");
  }
  let last: GadsRequestError | null = null;
  for (let attempt = 1; attempt <= GADS_MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: endpoint.method,
        headers: gadsHeaders(init.accessToken, init.env),
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(GADS_TIMEOUT_MS),
      });
    } catch {
      last = new GadsRequestError("unavailable", "Google didn't answer.");
      continue;
    }
    if (res.ok) {
      try {
        return (await res.json()) as unknown;
      } catch {
        throw new GadsRequestError("refused", "Google's answer couldn't be read.", res.status);
      }
    }
    const body = (await res.json().catch(() => null)) as unknown;
    last = gadsFailure(res.status, body);
    console.log(JSON.stringify({ event: "gads_request_failed", endpoint: id, status: res.status }));
    if (last.kind !== "quota" && last.kind !== "unavailable") throw last;
  }
  throw last ?? new GadsRequestError("unavailable", "Google didn't answer.");
}

/* ── numbers ─────────────────────────────────────────────────────────── */

/** Pure: a protobuf int64 as REST JSON may carry it (a string, or a number) — null if it isn't one. */
export function readInt64(v: unknown): number | null {
  const raw = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof raw !== "string" || !/^-?\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** Pure: a double as REST JSON carries it — null if it isn't a finite number. */
export function readDouble(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Micros per minor unit: 10,000 for a two-decimal currency (EUR, HUF), 1,000,000 for JPY. */
function microsPerMinor(currency: string): number {
  const exponent = minorUnitExponent(currency.toUpperCase());
  if (exponent > 6) throw new RangeError(`${currency} has more decimals than micros carry`);
  return 10 ** (6 - exponent);
}

/**
 * Pure (rule 1): micros of the account currency → integer minor units,
 * rounded half away from zero. Google: "One million micros is equivalent to
 * one currency unit" (CampaignBudget reference).
 */
export function microsToMinor(micros: number, currency: string): number {
  if (!Number.isSafeInteger(micros))
    throw new RangeError(`micros must be an integer, got ${micros}`);
  const per = microsPerMinor(currency);
  const minor = Math.sign(micros) * Math.round(Math.abs(micros) / per);
  return minor === 0 ? 0 : minor;
}

/** Pure: integer minor units → micros, exactly (a budget SYB sends is whole minor units). */
export function minorToMicros(minor: number, currency: string): number {
  if (!Number.isSafeInteger(minor))
    throw new RangeError(`minor units must be an integer, got ${minor}`);
  const micros = minor * microsPerMinor(currency);
  if (!Number.isSafeInteger(micros)) throw new RangeError("that budget is too large to send");
  return micros;
}

/** Pure: an amount in the account currency (a double, such as conversions_value) → minor units. */
export function amountToMinor(amount: number, currency: string): number {
  const scale = 10 ** minorUnitExponent(currency.toUpperCase());
  const minor = Math.round(amount * scale);
  if (!Number.isSafeInteger(minor)) throw new RangeError("that amount is too large");
  return minor;
}

/* ── reads ─────────────────────────────────────────────────────────── */

const searchUrl = (customerId: string) =>
  `${GOOGLE_ADS_ORIGIN}/${V}/customers/${customerId}/googleAds:search`;

/** Every row of one GAQL query, following nextPageToken, at most GADS_MAX_PAGES pages. */
export async function searchAll(
  args: { accessToken: string; env: GadsHeaderEnv; customerId: string; query: string },
  fetchImpl?: FetchLike,
): Promise<Record<string, unknown>[]> {
  if (!CUSTOMER_ID_RE.test(args.customerId)) {
    throw new GadsRequestError("fence", "that isn't a Google Ads customer id");
  }
  const rows: Record<string, unknown>[] = [];
  let pageToken: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= GADS_MAX_PAGES) {
      throw new GadsRequestError("refused", "Google returned more pages than one read takes.");
    }
    const body = (await gadsRequest(
      "search",
      searchUrl(args.customerId),
      {
        accessToken: args.accessToken,
        env: args.env,
        body: { query: args.query, ...(pageToken ? { pageToken } : {}) },
      },
      fetchImpl,
    )) as { results?: unknown; nextPageToken?: unknown } | null;
    for (const r of Array.isArray(body?.results) ? body.results : []) {
      if (r && typeof r === "object") rows.push(r as Record<string, unknown>);
    }
    pageToken =
      typeof body?.nextPageToken === "string" && body.nextPageToken !== ""
        ? body.nextPageToken
        : null;
    if (pageToken === null) return rows;
  }
}

/** The customer ids the signed-in Google account reaches directly (customers:listAccessibleCustomers). */
export async function listAccessibleCustomers(
  args: { accessToken: string; env: GadsHeaderEnv },
  fetchImpl?: FetchLike,
): Promise<string[]> {
  const body = (await gadsRequest(
    "accessible",
    `${GOOGLE_ADS_ORIGIN}/${V}/customers:listAccessibleCustomers`,
    { accessToken: args.accessToken, env: args.env },
    fetchImpl,
  )) as { resourceNames?: unknown } | null;
  const names = Array.isArray(body?.resourceNames) ? body.resourceNames : [];
  return [
    ...new Set(
      names.flatMap((n) => {
        const m = typeof n === "string" ? /^customers\/(\d{10})$/.exec(n) : null;
        return m?.[1] ? [m[1]] : [];
      }),
    ),
  ];
}

/** One ad account as SYB keeps it. */
export interface GadsCustomer {
  customer_id: string;
  name: string;
  /** ISO 4217, upper case: the currency the account operates in (rule 1). */
  currency: string;
  time_zone: string | null;
  manager: boolean;
}

/** Pure: Google's customer row into SYB's shape, or null when it isn't one. */
export function readCustomerRow(row: Record<string, unknown>): GadsCustomer | null {
  const c = (row["customer"] ?? {}) as Record<string, unknown>;
  const id = readInt64(c["id"]);
  const currency = typeof c["currencyCode"] === "string" ? c["currencyCode"].toUpperCase() : "";
  if (id === null || !CUSTOMER_ID_RE.test(String(id)) || !/^[A-Z]{3}$/.test(currency)) return null;
  const name =
    typeof c["descriptiveName"] === "string" && c["descriptiveName"].trim() !== ""
      ? c["descriptiveName"].trim().slice(0, 200)
      : String(id);
  return {
    customer_id: String(id),
    name,
    currency,
    time_zone: typeof c["timeZone"] === "string" ? c["timeZone"] : null,
    manager: c["manager"] === true,
  };
}

export const CUSTOMER_QUERY =
  "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer";

/** The ad account's own name, currency and time zone. */
export async function readCustomer(
  args: { accessToken: string; env: GadsHeaderEnv; customerId: string },
  fetchImpl?: FetchLike,
): Promise<GadsCustomer> {
  const rows = await searchAll({ ...args, query: CUSTOMER_QUERY }, fetchImpl);
  const customer = rows.map(readCustomerRow).find((c) => c !== null) ?? null;
  if (customer === null || customer.customer_id !== args.customerId) {
    throw new GadsRequestError("refused", "Google didn't describe that ad account.");
  }
  return customer;
}
