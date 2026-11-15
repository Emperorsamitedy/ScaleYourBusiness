// The Google Business Profile client — I-45a. Reads reviews, and nothing else.
//
// Google offers one scope for the Business Profile APIs, business.manage,
// and it can also reply to reviews and edit the listing. The owner holds it
// as a write consent (lib/execution/scopes, google_business_reviews), and
// SYB uses it only to READ. That promise is held here, in code, not hoped
// for: every request goes through gbpRequest, which sends only to an
// endpoint in GBP_ENDPOINTS, with that endpoint's method. Every endpoint is
// a GET, except Google's OAuth token endpoint (the code exchange and the
// refresh), which is a POST to oauth2.googleapis.com and touches no
// business. There is no reply, update, or delete endpoint on the list, and
// client.test.ts fails the build if one appears, if any other verb is sent,
// or if any file in lib/google-business calls fetch outside gbpRequest.
//
// Read in Google's documentation on 2026-11-01:
//   · reviews.list — GET https://mybusiness.googleapis.com/v4/{parent=accounts/*/locations/*}/reviews,
//     pageSize at most 50, pageToken, orderBy (default "updateTime desc");
//     the response holds reviews[], averageRating, totalReviewCount and
//     nextPageToken (only when more remain). A Review has name
//     (accounts/{a}/locations/{l}/reviews/{r}), reviewId, reviewer
//     {displayName, profilePhotoUrl, isAnonymous}, starRating
//     (STAR_RATING_UNSPECIFIED, ONE … FIVE), comment, createTime, updateTime
//     and reviewReply. Its other methods (updateReply, deleteReply) are
//     writes and are not on the list below.
//   · accounts.list — GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts,
//     pageSize at most 20; an Account has name (accounts/{id}), accountName, type.
//   · locations.list — GET https://mybusinessbusinessinformation.googleapis.com/v1/{parent=accounts/*}/locations,
//     readMask REQUIRED, pageSize at most 100; a Location has name
//     (locations/{id}), title, and metadata.mapsUri ("a link to the
//     location on Maps").
//   · OAuth for web servers — authorize at accounts.google.com/o/oauth2/v2/auth
//     with access_type=offline and prompt=consent for a refresh token; the
//     token endpoint is https://oauth2.googleapis.com/token and its answer's
//     `scope` is the space-delimited list of scopes actually granted (a
//     person can untick a scope on Google's screen).
//
// No line logs a token, a code, a client secret or a response body: only
// the endpoint id and the HTTP status.

import type { GoogleBusinessEnv } from "../env";

export const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";
export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export type GbpMethod = "GET" | "POST";

export interface GbpEndpoint {
  method: GbpMethod;
  origin: string;
  /** The whole path, anchored: no extra segment (such as /reply) can match. */
  path: RegExp;
}

const ID = "[A-Za-z0-9_-]+";

/** THE FENCE: the only requests this client can send. Each is a read, but the token exchange. */
export const GBP_ENDPOINTS = {
  token: { method: "POST", origin: "https://oauth2.googleapis.com", path: /^\/token$/ },
  accounts: {
    method: "GET",
    origin: "https://mybusinessaccountmanagement.googleapis.com",
    path: /^\/v1\/accounts$/,
  },
  locations: {
    method: "GET",
    origin: "https://mybusinessbusinessinformation.googleapis.com",
    path: new RegExp(`^/v1/accounts/${ID}/locations$`),
  },
  reviews: {
    method: "GET",
    origin: "https://mybusiness.googleapis.com",
    path: new RegExp(`^/v4/accounts/${ID}/locations/${ID}/reviews$`),
  },
} as const satisfies Record<string, GbpEndpoint>;

export type GbpEndpointId = keyof typeof GBP_ENDPOINTS;

/** Pure: the endpoint a request is, or null when it is on no list (and must not be sent). */
export function allowedEndpoint(method: string, url: string): GbpEndpointId | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username !== "" || u.password !== "" || u.hash !== "") return null;
  for (const [id, e] of Object.entries(GBP_ENDPOINTS) as [GbpEndpointId, GbpEndpoint][]) {
    if (method.toUpperCase() === e.method && u.origin === e.origin && e.path.test(u.pathname)) {
      return id;
    }
  }
  return null;
}

export type GbpFailureKind = "fence" | "auth" | "permission" | "quota" | "unavailable" | "refused";

/** A refusal, in the owner's words, with a kind the read beat and the screens map to fixed text. */
export class GbpRequestError extends Error {
  readonly kind: GbpFailureKind;
  readonly status: number | null;
  constructor(kind: GbpFailureKind, message: string, status: number | null = null) {
    super(message);
    this.name = "GbpRequestError";
    this.kind = kind;
    this.status = status;
  }
}

export const GBP_TIMEOUT_MS = 15_000;
/** Attempts for a read Google says to retry (429, 5xx, no answer). The token POST is tried once. */
export const GBP_MAX_ATTEMPTS = 2;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function failureFor(status: number): GbpRequestError {
  if (status === 401) {
    return new GbpRequestError("auth", "Google no longer accepts ScaleX's access.", status);
  }
  if (status === 403) {
    return new GbpRequestError(
      "permission",
      "Google says ScaleX isn't allowed to read this Business Profile.",
      status,
    );
  }
  if (status === 429) {
    return new GbpRequestError("quota", "Google asked ScaleX to slow down.", status);
  }
  if (status >= 500) {
    return new GbpRequestError("unavailable", "Google didn't answer.", status);
  }
  return new GbpRequestError("refused", "Google refused the request.", status);
}

/**
 * The ONE place this module sends anything. The request must be on
 * GBP_ENDPOINTS, with that endpoint's method, or it never leaves.
 */
export async function gbpRequest(
  id: GbpEndpointId,
  url: string,
  init: { headers?: Record<string, string>; body?: URLSearchParams },
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const endpoint: GbpEndpoint = GBP_ENDPOINTS[id];
  if (allowedEndpoint(endpoint.method, url) !== id) {
    throw new GbpRequestError("fence", `refusing a request that isn't on ScaleX's read list`);
  }
  if (endpoint.method === "GET" && init.body !== undefined) {
    throw new GbpRequestError("fence", "a read carries no body");
  }
  const attempts = endpoint.method === "GET" ? GBP_MAX_ATTEMPTS : 1;
  let last: GbpRequestError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: endpoint.method,
        headers: { accept: "application/json", ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(GBP_TIMEOUT_MS),
      });
    } catch {
      last = new GbpRequestError("unavailable", "Google didn't answer.");
      continue;
    }
    if (res.ok) {
      try {
        return (await res.json()) as unknown;
      } catch {
        throw new GbpRequestError("refused", "Google's answer couldn't be read.", res.status);
      }
    }
    // The token endpoint says a revoked or expired grant with 400 invalid_grant.
    if (id === "token" && res.status === 400) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (body?.error === "invalid_grant") {
        throw new GbpRequestError("auth", "Google no longer accepts ScaleX's access.", 400);
      }
    }
    last = failureFor(res.status);
    console.log(JSON.stringify({ event: "gbp_request_failed", endpoint: id, status: res.status }));
    if (last.kind !== "quota" && last.kind !== "unavailable") throw last;
  }
  throw last ?? new GbpRequestError("unavailable", "Google didn't answer.");
}

/* ── OAuth ─────────────────────────────────────────────────────────── */

export interface GoogleTokens {
  access_token: string;
  /** Only on the code exchange, and only with access_type=offline and prompt=consent. */
  refresh_token: string | null;
  /** What Google says it granted, verbatim, split. */
  scopes: string[];
}

function readTokens(raw: unknown): GoogleTokens {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (typeof t["access_token"] !== "string" || t["access_token"] === "") {
    throw new GbpRequestError("refused", "Google's answer had no access.");
  }
  return {
    access_token: t["access_token"],
    refresh_token:
      typeof t["refresh_token"] === "string" && t["refresh_token"] !== ""
        ? t["refresh_token"]
        : null,
    scopes: typeof t["scope"] === "string" ? t["scope"].split(/\s+/).filter(Boolean) : [],
  };
}

type OAuthClient = Pick<GoogleBusinessEnv, "client_id" | "client_secret">;

const TOKEN_URL = `${GBP_ENDPOINTS.token.origin}/token`;

/** The authorization code for tokens, with the PKCE verifier. */
export async function exchangeCode(
  client: OAuthClient,
  args: { code: string; redirectUri: string; codeVerifier: string },
  fetchImpl?: FetchLike,
): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: client.client_id,
    client_secret: client.client_secret,
    code_verifier: args.codeVerifier,
  });
  return readTokens(
    await gbpRequest(
      "token",
      TOKEN_URL,
      { headers: { "content-type": "application/x-www-form-urlencoded" }, body },
      fetchImpl,
    ),
  );
}

/** A fresh access token from the stored refresh token. */
export async function refreshAccess(
  client: OAuthClient,
  refreshToken: string,
  fetchImpl?: FetchLike,
): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.client_id,
    client_secret: client.client_secret,
  });
  return readTokens(
    await gbpRequest(
      "token",
      TOKEN_URL,
      { headers: { "content-type": "application/x-www-form-urlencoded" }, body },
      fetchImpl,
    ),
  );
}

/* ── reads ─────────────────────────────────────────────────────────── */

export const ACCOUNT_NAME_RE = new RegExp(`^accounts/${ID}$`);
export const LOCATION_NAME_RE = new RegExp(`^locations/${ID}$`);

export interface GbpLocation {
  /** accounts/{a} */
  account: string;
  /** locations/{l} */
  location: string;
  title: string;
  /** Google Maps' link to the listing, when Google gave an https one. */
  maps_uri: string | null;
}

/** The most locations listed for the owner to pick from. */
export const GBP_LOCATIONS_CAP = 50;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function httpsGoogleLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const google =
      host === "maps.google.com" ||
      host === "www.google.com" ||
      host === "google.com" ||
      host === "g.page" ||
      host === "maps.app.goo.gl" ||
      host === "goo.gl";
    return u.protocol === "https:" && google ? u.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}

/**
 * Every location the access reaches, capped: the first page of accounts
 * (Google's 20), and the first page of each account's locations (100), at
 * most GBP_LOCATIONS_CAP in all.
 */
export async function listLocations(
  accessToken: string,
  fetchImpl?: FetchLike,
): Promise<GbpLocation[]> {
  const accountsUrl = new URL(`${GBP_ENDPOINTS.accounts.origin}/v1/accounts`);
  accountsUrl.searchParams.set("pageSize", "20");
  const a = (await gbpRequest(
    "accounts",
    accountsUrl.toString(),
    { headers: bearer(accessToken) },
    fetchImpl,
  )) as { accounts?: unknown } | null;
  const accounts = Array.isArray(a?.accounts) ? a.accounts : [];
  const out: GbpLocation[] = [];
  for (const raw of accounts) {
    const name = (raw as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !ACCOUNT_NAME_RE.test(name)) continue;
    const url = new URL(`${GBP_ENDPOINTS.locations.origin}/v1/${name}/locations`);
    url.searchParams.set("readMask", "name,title,metadata.mapsUri");
    url.searchParams.set("pageSize", "100");
    const l = (await gbpRequest(
      "locations",
      url.toString(),
      { headers: bearer(accessToken) },
      fetchImpl,
    )) as { locations?: unknown } | null;
    for (const loc of Array.isArray(l?.locations) ? l.locations : []) {
      const r = (loc ?? {}) as { name?: unknown; title?: unknown; metadata?: unknown };
      if (typeof r.name !== "string" || !LOCATION_NAME_RE.test(r.name)) continue;
      const title = typeof r.title === "string" && r.title.trim() !== "" ? r.title.trim() : r.name;
      out.push({
        account: name,
        location: r.name,
        title: title.slice(0, 200),
        maps_uri: httpsGoogleLink((r.metadata as { mapsUri?: unknown } | undefined)?.mapsUri),
      });
      if (out.length >= GBP_LOCATIONS_CAP) return out;
    }
  }
  return out;
}

/** One review as SYB keeps it. The words are content, never instructions (rule 24). */
export interface GbpReview {
  /** accounts/{a}/locations/{l}/reviews/{r}: the key a re-read files nothing twice on. */
  name: string;
  stars: number | null;
  /** The name Google shows publicly; null when the reviewer chose to be anonymous. */
  reviewer: string | null;
  text: string | null;
  created_at: string;
}

const STARS: Readonly<Record<string, number>> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/** Pure: Google's Review into SYB's shape, or null when it isn't one. Photos and replies are left. */
export function readReview(raw: unknown): GbpReview | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = r["name"];
  if (
    typeof name !== "string" ||
    !new RegExp(`^accounts/${ID}/locations/${ID}/reviews/${ID}$`).test(name)
  ) {
    return null;
  }
  const created = r["createTime"];
  if (typeof created !== "string" || Number.isNaN(Date.parse(created))) return null;
  const reviewer = (r["reviewer"] ?? {}) as Record<string, unknown>;
  const shown =
    reviewer["isAnonymous"] === true || typeof reviewer["displayName"] !== "string"
      ? null
      : reviewer["displayName"].trim() || null;
  const comment = typeof r["comment"] === "string" ? r["comment"].trim() : "";
  const star = typeof r["starRating"] === "string" ? (STARS[r["starRating"]] ?? null) : null;
  return {
    name,
    stars: star,
    reviewer: shown,
    text: comment === "" ? null : comment,
    created_at: new Date(Date.parse(created)).toISOString(),
  };
}

export const GBP_REVIEWS_PAGE_SIZE = 50;

/** One page of a location's reviews, newest update first (Google's default order). */
export async function listReviewsPage(
  accessToken: string,
  loc: Pick<GbpLocation, "account" | "location">,
  pageToken: string | null,
  fetchImpl?: FetchLike,
): Promise<{ reviews: GbpReview[]; next: string | null }> {
  if (!ACCOUNT_NAME_RE.test(loc.account) || !LOCATION_NAME_RE.test(loc.location)) {
    throw new GbpRequestError("fence", "that isn't a Business Profile location");
  }
  const url = new URL(`${GBP_ENDPOINTS.reviews.origin}/v4/${loc.account}/${loc.location}/reviews`);
  url.searchParams.set("pageSize", String(GBP_REVIEWS_PAGE_SIZE));
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const page = (await gbpRequest(
    "reviews",
    url.toString(),
    { headers: bearer(accessToken) },
    fetchImpl,
  )) as { reviews?: unknown; nextPageToken?: unknown } | null;
  const reviews = (Array.isArray(page?.reviews) ? page.reviews : [])
    .map(readReview)
    .filter((r): r is GbpReview => r !== null);
  const next =
    typeof page?.nextPageToken === "string" && page.nextPageToken !== ""
      ? page.nextPageToken
      : null;
  return { reviews, next };
}
