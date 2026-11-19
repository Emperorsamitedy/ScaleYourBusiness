// The Google Search Console connector — Phase 2 Session G (P2-33).
//
// WHAT IT ANSWERS. The real searches a business's site appeared for: per
// day and per query, how often it was shown (impressions), clicked, and
// at what average position. That is half of a blindspot — "people search
// for this" — and lib/blindspots supplies the other half.
//
// HOW AN OWNER CONNECTS. Like GA4: a Google Cloud service account, its
// JSON key, and the account's email added as a user on the Search Console
// property. We sign a one-hour JWT asking for webmasters.readonly and
// nothing else, and tokeninfo confirms that is all the token carries
// (scopeVerification "reported"). This module knows exactly three URLs:
// the token endpoint, tokeninfo, and searchAnalytics.query on the owner's
// own property. search-console.test.ts scans this source and fails the
// build if a broader scope or another host appears.
//
// SHAPES, from Google's docs (checked 2026-10-13):
//   POST https://searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
//   body { startDate, endDate (YYYY-MM-DD, PT), dimensions, type, dataState,
//          rowLimit ≤ 25 000, startRow } → rows[{ keys, clicks, impressions, ctr, position }]
//   Data lands 2–3 days late, so every sync re-reads the last 4 days. Rare
//   queries are anonymised and left out of rows (they still count in
//   Google's own totals), so the stored queries sum to LESS than the
//   property's total — every screen that uses them says so.
//
// STORED. Per day, per query (query_ref): impressions, clicks, and
// position × impressions, so an average position over any window is a
// sum ÷ a sum instead of an average of averages.

import { createSign } from "node:crypto";
import { addDays, advanceCursor, dayString, planWindow } from "../days";
import type { Observation, Provider, PullPage } from "../provider";
import { ProviderError } from "../provider";

export const SC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const SC_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SC_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
export const SC_ORIGIN = "https://searchconsole.googleapis.com";

/** Blindspots need recent demand, not a long history; 90 days keeps the rows small. */
export const SC_HISTORY_DAYS = 90;
export const SC_REREAD_DAYS = 4;
export const SC_WINDOW_DAYS = 30;
export const SC_ROW_LIMIT = 25_000;
export const SC_MAX_PAGES = 8;
export const SC_MAX_ATTEMPTS = 3;

export interface ScRequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}
export interface ScResponse {
  status: number;
  json(): Promise<unknown>;
}
export type ScFetch = (url: string, init: ScRequestInit) => Promise<ScResponse>;

export interface ScProviderOptions {
  fetch?: ScFetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

export interface ScCredential {
  site_url: string;
  client_email: string;
  private_key: string;
}

/** "sc-domain:example.com" for a Domain property, "https://www.example.com/" for a URL-prefix one. */
export function normaliseSiteUrl(raw: string): string | null {
  const value = raw.trim();
  if (/^sc-domain:[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) return value.toLowerCase();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.protocol}//${url.host}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`;
  } catch {
    return null;
  }
}

export function parseScCredential(secret: string): ScCredential {
  let outer: Record<string, unknown>;
  try {
    outer = (JSON.parse(secret) ?? {}) as Record<string, unknown>;
  } catch {
    throw new ProviderError(
      "search console: the property and the service account key are both needed",
    );
  }
  const site = normaliseSiteUrl(typeof outer["site_url"] === "string" ? outer["site_url"] : "");
  if (site === null) {
    throw new ProviderError(
      "search console: the property is your site's address as Search Console shows it, https://www.example.com/ or sc-domain:example.com",
    );
  }
  let key: Record<string, unknown>;
  try {
    key = JSON.parse(
      typeof outer["service_account_json"] === "string" ? outer["service_account_json"] : "",
    );
  } catch {
    throw new ProviderError(
      "search console: paste the whole service account key file, which is JSON",
    );
  }
  const email = typeof key["client_email"] === "string" ? key["client_email"] : "";
  const privateKey = typeof key["private_key"] === "string" ? key["private_key"] : "";
  if (
    key["type"] !== "service_account" ||
    !email.endsWith(".iam.gserviceaccount.com") ||
    !privateKey.includes("PRIVATE KEY")
  ) {
    throw new ProviderError("search console: that isn't a Google service account key file");
  }
  return { site_url: site, client_email: email, private_key: privateKey };
}

const base64url = (text: string): string => Buffer.from(text).toString("base64url");

/** A one-hour JWT asking for webmasters.readonly and nothing else, signed RS256. */
export function signScAssertion(cred: ScCredential, issuedAtSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: cred.client_email,
      scope: SC_SCOPE,
      aud: SC_TOKEN_URL,
      iat: issuedAtSeconds,
      exp: issuedAtSeconds + 3600,
    }),
  );
  const input = `${header}.${claims}`;
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(input).sign(cred.private_key, "base64url");
  } catch {
    throw new ProviderError("search console: the service account's private key couldn't be read");
  }
  return `${input}.${signature}`;
}

export const queryUrl = (siteUrl: string): string =>
  `${SC_ORIGIN}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

interface Context {
  fetch: ScFetch;
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
  tokens: Map<string, { value: string; expiresAt: number }>;
}

const backoffMs = (attempt: number) => 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);

function googleMessage(body: unknown): string | null {
  const message = (body as { error?: { message?: unknown } | string } | null)?.error;
  if (typeof message === "string") return message;
  return typeof message?.message === "string" ? message.message : null;
}

async function request(
  ctx: Context,
  cred: ScCredential,
  url: string,
  init: ScRequestInit,
): Promise<{ status: number; body: unknown }> {
  const allowed =
    url === SC_TOKEN_URL || url === SC_TOKENINFO_URL || url === queryUrl(cred.site_url);
  if (!allowed) throw new ProviderError("search console: refusing to call an unregistered address");
  for (let attempt = 1; ; attempt += 1) {
    let response: ScResponse;
    try {
      response = await ctx.fetch(url, init);
    } catch {
      if (attempt >= SC_MAX_ATTEMPTS)
        throw new ProviderError(`search console: network failure after ${attempt} attempts`);
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < SC_MAX_ATTEMPTS) {
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    return { status: response.status, body: await response.json().catch(() => null) };
  }
}

async function accessToken(ctx: Context, cred: ScCredential, fresh = false): Promise<string> {
  const cacheKey = `${cred.client_email}|${cred.site_url}`;
  const cached = ctx.tokens.get(cacheKey);
  if (!fresh && cached && cached.expiresAt - 60_000 > ctx.clock()) return cached.value;
  const { status, body } = await request(ctx, cred, SC_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signScAssertion(cred, Math.floor(ctx.clock() / 1000)),
    }).toString(),
  });
  const token = body as { access_token?: unknown; expires_in?: unknown } | null;
  if (status !== 200 || typeof token?.access_token !== "string") {
    throw new ProviderError(
      "search console: Google did not accept the service account key. It may have been deleted or disabled",
    );
  }
  const seconds = typeof token.expires_in === "number" ? token.expires_in : 3600;
  ctx.tokens.set(cacheKey, { value: token.access_token, expiresAt: ctx.clock() + seconds * 1000 });
  return token.access_token;
}

async function tokenScopes(ctx: Context, cred: ScCredential, token: string): Promise<string[]> {
  // The token goes in a header, never a URL, where proxies, APM and
  // fetch breadcrumbs would keep it (the security review of 2026-10-17).
  const { status, body } = await request(ctx, cred, SC_TOKENINFO_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  const info = body as { scope?: unknown } | null;
  if (status !== 200 || typeof info?.scope !== "string") {
    throw new ProviderError("search console: Google could not confirm the token's permissions");
  }
  return info.scope.split(/\s+/).filter((s) => s !== "");
}

export interface ScRow {
  date: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number;
}

/** Every (date, query) row for [start, end], paged by startRow until a page comes back empty. */
async function queryRows(
  ctx: Context,
  cred: ScCredential,
  start: string,
  end: string,
  rowLimit = SC_ROW_LIMIT,
): Promise<ScRow[]> {
  const out: ScRow[] = [];
  let fresh = false;
  for (let page = 0; page < SC_MAX_PAGES;) {
    const token = await accessToken(ctx, cred, fresh);
    fresh = false;
    const { status, body } = await request(ctx, cred, queryUrl(cred.site_url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        startDate: start,
        endDate: end,
        dimensions: ["date", "query"],
        type: "web",
        dataState: "final",
        rowLimit,
        startRow: out.length,
      }),
    });
    if (status === 401 && out.length === 0 && page === 0) {
      fresh = true;
      page += 1;
      continue;
    }
    if (status === 403) {
      throw new ProviderError(
        `search console: ${cred.client_email} can't read ${cred.site_url}. In Search Console, open Settings, then Users and permissions, and add it as a user`,
      );
    }
    if (status !== 200) {
      const message = googleMessage(body);
      throw new ProviderError(
        `search console: the query failed with status ${status}${message ? `. ${message}` : ""}`,
      );
    }
    const rows = Array.isArray((body as { rows?: unknown } | null)?.rows)
      ? (body as { rows: unknown[] }).rows
      : [];
    for (const raw of rows) {
      const r = raw as {
        keys?: unknown[];
        clicks?: unknown;
        impressions?: unknown;
        position?: unknown;
      };
      const date = typeof r.keys?.[0] === "string" ? r.keys[0] : "";
      const query = typeof r.keys?.[1] === "string" ? r.keys[1] : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || query.trim() === "") continue;
      out.push({
        date,
        query,
        clicks: Number(r.clicks ?? 0),
        impressions: Number(r.impressions ?? 0),
        position: Number(r.position ?? 0),
      });
    }
    // Google's documented paging: raise startRow until a page comes back
    // EMPTY — a short page is not proof there is nothing after it. A
    // single-row probe stops at once.
    if (rows.length === 0 || rowLimit === 1) return out;
    page += 1;
  }
  throw new ProviderError("search console: the property had more rows than one sync reads");
}

/** Pure: rows → observations. Queries are lower-cased and trimmed, and summed when they then coincide. */
export function aggregateQueries(rows: readonly ScRow[], observedAt: string): Observation[] {
  const totals = new Map<string, { impressions: number; clicks: number; weighted: number }>();
  for (const r of rows) {
    if (!(r.impressions > 0)) continue;
    const query = r.query.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
    const key = `${r.date}|${query}`;
    const t = totals.get(key) ?? { impressions: 0, clicks: 0, weighted: 0 };
    t.impressions += r.impressions;
    t.clicks += r.clicks;
    t.weighted += r.position * r.impressions;
    totals.set(key, t);
  }
  const out: Observation[] = [];
  for (const [key, t] of [...totals.entries()].sort()) {
    const [date, query] = key.split("|") as [string, string];
    const dims = { query_ref: query };
    out.push({
      metric_key: "search_impressions.daily",
      period_date: date,
      dimensions: dims,
      value_num: t.impressions,
      observed_at: observedAt,
    });
    out.push({
      metric_key: "search_clicks.daily",
      period_date: date,
      dimensions: dims,
      value_num: t.clicks,
      observed_at: observedAt,
    });
    out.push({
      metric_key: "search_position_weighted.daily",
      period_date: date,
      dimensions: dims,
      value_num: Math.round(t.weighted * 100) / 100,
      observed_at: observedAt,
    });
  }
  return out;
}

const defaultFetch: ScFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    cache: "no-store",
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

export function createSearchConsoleProvider(options: ScProviderOptions = {}): Provider {
  const ctx: Context = {
    fetch: options.fetch ?? defaultFetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    clock: options.clock ?? (() => Date.now()),
    tokens: new Map(),
  };

  return {
    id: "search_console",
    label: "Google Search Console",
    scopeVerification: "reported",

    async connect(secret) {
      const cred = parseScCredential(secret);
      const token = await accessToken(ctx, cred, true);
      const granted = [...new Set(await tokenScopes(ctx, cred, token))].sort();
      if (!granted.includes(SC_SCOPE)) {
        throw new ProviderError(
          "search console: the token doesn't carry read-only Search Console access",
        );
      }
      // Prove the property is readable: one row from a settled day.
      const day = dayString(addDays(new Date(ctx.clock()), -(SC_REREAD_DAYS + 1)));
      await queryRows(ctx, cred, day, day, 1);
      return { granted_scopes: granted };
    },

    async pull(secret, cursor, now): Promise<PullPage> {
      const cred = parseScCredential(secret);
      const plan = planWindow({
        cursor,
        now,
        historyDays: SC_HISTORY_DAYS,
        rereadDays: SC_REREAD_DAYS,
        windowDays: SC_WINDOW_DAYS,
        provider: "search_console",
      });
      if (plan === null) return { observations: [], cursor, done: true };
      const rows = await queryRows(ctx, cred, dayString(plan.start), dayString(plan.end));
      return {
        observations: aggregateQueries(rows, now.toISOString()),
        cursor: advanceCursor(cursor, plan.end),
        done: plan.end.getTime() === plan.yesterday.getTime(),
      };
    },
  };
}

export const searchConsoleProvider = createSearchConsoleProvider();
