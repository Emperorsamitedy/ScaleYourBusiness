// The Google Analytics 4 connector — Phase 2 Session D (P2-18).
//
// HOW AN OWNER CONNECTS. Google Analytics has a genuinely read-only scope,
// analytics.readonly, so this connector is read-only by construction. The
// owner creates a service account in Google Cloud, downloads its JSON key,
// and adds the service account's email to their GA4 property with the
// Viewer role. We store the property ID and the key, encrypted (rule 10),
// sign a one-hour JWT asking for analytics.readonly and nothing else, and
// exchange it for an access token.
//
// READ-ONLY, PROVEN. Google's tokeninfo endpoint reports the scopes a token
// actually carries, so the connect check is real (scopeVerification:
// "reported"). This module knows exactly four URLs: the token endpoint,
// tokeninfo, and runReport and runRealtimeReport on the owner's property
// (the realtime one since 2026-11-16, for Home's live line; same scope,
// same host, a read like the others). It never uses the
// token_uri written in the key file, so a doctored key cannot point it
// anywhere else. ga4.test.ts scans this source and fails the build if the
// full analytics scope, or any other Google host, ever appears.
//
// WHAT IS READ. Sessions per day per default channel group. Sessions add up
// across channels, so the business total is their sum. Users do not add up
// across channels or across days, so they are deliberately not stored. Days
// are the property's own reporting days, in its time zone. GA4 keeps
// processing recent data for a while, so every sync re-reads the last 3.
// Since P2-29/P2-34 also: sessions per hour (dateHour, placed in UTC from
// the property zone the response states), landing pages with sessions and
// bounced sessions, and site-search terms (view_search_results). Same
// scope, same URL, three more reports per window.

import { createSign } from "node:crypto";
import { addDays, advanceCursor, dayString, planWindow } from "../days";
import { HourlyBuckets, utcOfZonedHour } from "../hourly";
import type { ExternalProduct, Observation, Provider, PullPage } from "../provider";
import { ProviderError } from "../provider";

export const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
export const GA4_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GA4_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
export const GA4_DATA_ORIGIN = "https://analyticsdata.googleapis.com";

export const GA4_HISTORY_DAYS = 365;
export const GA4_REREAD_DAYS = 3;
export const GA4_WINDOW_DAYS = 30;
export const GA4_ROW_LIMIT = 10_000;
export const GA4_MAX_PAGES = 20;
export const GA4_CHANNEL_LOOKBACK_DAYS = 90;
export const GA4_MAX_ATTEMPTS = 3;

/** The only reports this module can run. */
export const GA4_REPORTS = {
  sessions_by_day_and_channel: {
    dimensions: ["date", "sessionDefaultChannelGroup"],
    metrics: ["sessions"],
  },
  channels: { dimensions: ["sessionDefaultChannelGroup"], metrics: ["sessions"] },
  probe: { dimensions: [], metrics: ["sessions"] },
  /** P2-29: dateHour is YYYYMMDDHH in the PROPERTY's time zone (response metadata.timeZone). */
  sessions_by_hour: { dimensions: ["dateHour"], metrics: ["sessions"] },
  /** P2-34: where sessions begin, and how many bounced. GA4 has no exits metric. */
  landing_pages: { dimensions: ["date", "landingPage"], metrics: ["sessions", "bounceRate"] },
  /** P2-34: the site's own search box — Enhanced Measurement's view_search_results event. */
  site_search: {
    dimensions: ["date", "searchTerm"],
    metrics: ["eventCount"],
    filter: { fieldName: "eventName", value: "view_search_results" },
  },
} as const satisfies Record<
  string,
  {
    dimensions: readonly string[];
    metrics: readonly string[];
    filter?: { fieldName: string; value: string };
  }
>;

export type Ga4ReportName = keyof typeof GA4_REPORTS;

export interface Ga4RequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface Ga4Response {
  status: number;
  json(): Promise<unknown>;
}

export type Ga4Fetch = (url: string, init: Ga4RequestInit) => Promise<Ga4Response>;

export interface Ga4ProviderOptions {
  fetch?: Ga4Fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds since the epoch, for the JWT's issued-at. */
  clock?: () => number;
}

export interface Ga4Credential {
  property_id: string;
  client_email: string;
  private_key: string;
}

export function parseGa4Credential(secret: string): Ga4Credential {
  let outer: unknown;
  try {
    outer = JSON.parse(secret);
  } catch {
    throw new ProviderError("ga4: the property ID and the service account key are both needed");
  }
  const o = (outer ?? {}) as Record<string, unknown>;
  const property =
    typeof o["property_id"] === "string"
      ? o["property_id"].trim().replace(/^properties\//, "")
      : "";
  if (!/^\d{4,}$/.test(property)) {
    throw new ProviderError(
      "ga4: the property ID is the number shown in GA4 Admin, under Property details",
    );
  }
  let key: Record<string, unknown>;
  try {
    key = JSON.parse(
      typeof o["service_account_json"] === "string" ? o["service_account_json"] : "",
    );
  } catch {
    throw new ProviderError("ga4: paste the whole service account key file, which is JSON");
  }
  const email = typeof key["client_email"] === "string" ? key["client_email"] : "";
  const privateKey = typeof key["private_key"] === "string" ? key["private_key"] : "";
  if (
    key["type"] !== "service_account" ||
    !email.endsWith(".iam.gserviceaccount.com") ||
    !privateKey.includes("PRIVATE KEY")
  ) {
    throw new ProviderError("ga4: that isn't a Google service account key file");
  }
  return { property_id: property, client_email: email, private_key: privateKey };
}

const base64url = (text: string): string => Buffer.from(text).toString("base64url");

/** A one-hour JWT asking for analytics.readonly and nothing else, signed RS256. */
export function signAssertion(cred: Ga4Credential, issuedAtSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: cred.client_email,
      scope: GA4_SCOPE,
      aud: GA4_TOKEN_URL,
      iat: issuedAtSeconds,
      exp: issuedAtSeconds + 3600,
    }),
  );
  const input = `${header}.${claims}`;
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(input).sign(cred.private_key, "base64url");
  } catch {
    throw new ProviderError("ga4: the service account's private key couldn't be read");
  }
  return `${input}.${signature}`;
}

const runReportUrl = (propertyId: string): string =>
  `${GA4_DATA_ORIGIN}/v1beta/properties/${propertyId}:runReport`;
const runRealtimeReportUrl = (propertyId: string): string =>
  `${GA4_DATA_ORIGIN}/v1beta/properties/${propertyId}:runRealtimeReport`;

/** The minutes a standard GA4 property's realtime report covers (360 properties: 60). */
export const GA4_REALTIME_MINUTES = 30;

interface Token {
  value: string;
  expiresAt: number;
}

interface Context {
  fetch: Ga4Fetch;
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
  tokens: Map<string, Token>;
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

function googleMessage(body: unknown): string | null {
  const message = (body as { error?: { message?: unknown } | string } | null)?.error;
  if (typeof message === "string") return message;
  return typeof message?.message === "string" ? message.message : null;
}

/** One request to one of the three known URLs, retried on 429, 5xx and network failure. */
async function request(
  ctx: Context,
  cred: Ga4Credential,
  url: string,
  init: Ga4RequestInit,
): Promise<{ status: number; body: unknown }> {
  const allowed =
    url === GA4_TOKEN_URL ||
    url === GA4_TOKENINFO_URL ||
    url === runReportUrl(cred.property_id) ||
    url === runRealtimeReportUrl(cred.property_id);
  if (!allowed) throw new ProviderError("ga4: refusing to call an unregistered address");

  for (let attempt = 1; ; attempt += 1) {
    let response: Ga4Response;
    try {
      response = await ctx.fetch(url, init);
    } catch {
      if (attempt >= GA4_MAX_ATTEMPTS) {
        throw new ProviderError(`ga4: network failure after ${attempt} attempts`);
      }
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < GA4_MAX_ATTEMPTS) {
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    return { status: response.status, body: await response.json().catch(() => null) };
  }
}

async function accessToken(ctx: Context, cred: Ga4Credential, fresh = false): Promise<string> {
  const cacheKey = `${cred.client_email}|${cred.property_id}`;
  const cached = ctx.tokens.get(cacheKey);
  if (!fresh && cached && cached.expiresAt - 60_000 > ctx.clock()) return cached.value;

  const { status, body } = await request(ctx, cred, GA4_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signAssertion(cred, Math.floor(ctx.clock() / 1000)),
    }).toString(),
  });
  const token = body as { access_token?: unknown; expires_in?: unknown } | null;
  if (status !== 200 || typeof token?.access_token !== "string") {
    throw new ProviderError(
      "ga4: Google did not accept the service account key. It may have been deleted or disabled",
    );
  }
  const seconds = typeof token.expires_in === "number" ? token.expires_in : 3600;
  ctx.tokens.set(cacheKey, { value: token.access_token, expiresAt: ctx.clock() + seconds * 1000 });
  return token.access_token;
}

/** The scopes Google says this token carries. */
async function tokenScopes(ctx: Context, cred: Ga4Credential, token: string): Promise<string[]> {
  // The token goes in a header, never a URL, where proxies, APM and
  // fetch breadcrumbs would keep it (the security review of 2026-10-17).
  const { status, body } = await request(ctx, cred, GA4_TOKENINFO_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  const info = body as { scope?: unknown } | null;
  if (status !== 200 || typeof info?.scope !== "string") {
    throw new ProviderError("ga4: Google could not confirm the token's permissions");
  }
  return info.scope.split(/\s+/).filter((s) => s !== "");
}

interface ReportRow {
  dimensions: string[];
  metrics: string[];
}

async function runReport(
  ctx: Context,
  cred: Ga4Credential,
  name: Ga4ReportName,
  startDate: string,
  endDate: string,
): Promise<ReportRow[]> {
  return (await runReportWithZone(ctx, cred, name, startDate, endDate)).rows;
}

/** A report, with the property's own time zone from the response metadata. */
async function runReportWithZone(
  ctx: Context,
  cred: Ga4Credential,
  name: Ga4ReportName,
  startDate: string,
  endDate: string,
): Promise<{ rows: ReportRow[]; timeZone: string | null }> {
  const spec: {
    dimensions: readonly string[];
    metrics: readonly string[];
    filter?: { fieldName: string; value: string };
  } = GA4_REPORTS[name];
  const out: ReportRow[] = [];
  let timeZone: string | null = null;
  let fresh = false;

  for (let page = 0; page < GA4_MAX_PAGES;) {
    const token = await accessToken(ctx, cred, fresh);
    fresh = false;
    const { status, body } = await request(ctx, cred, runReportUrl(cred.property_id), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: spec.dimensions.map((d) => ({ name: d })),
        metrics: spec.metrics.map((m) => ({ name: m })),
        limit: GA4_ROW_LIMIT,
        offset: out.length,
        keepEmptyRows: false,
        ...(spec.filter
          ? {
              dimensionFilter: {
                filter: {
                  fieldName: spec.filter.fieldName,
                  stringFilter: { matchType: "EXACT", value: spec.filter.value },
                },
              },
            }
          : {}),
      }),
    });
    if (status === 401 && page === 0 && out.length === 0 && !fresh) {
      fresh = true; // the cached token expired early: exchange once and retry
      page += 1;
      continue;
    }
    if (status === 403) {
      throw new ProviderError(
        `ga4: ${cred.client_email} can't read property ${cred.property_id}. In GA4 Admin, open Property access management and add it as a Viewer`,
      );
    }
    if (status !== 200) {
      const message = googleMessage(body);
      throw new ProviderError(
        `ga4: the report failed with status ${status}${message ? `. ${message}` : ""}`,
      );
    }
    const report = body as {
      rows?: unknown;
      rowCount?: unknown;
      metadata?: { timeZone?: unknown };
    } | null;
    if (typeof report?.metadata?.timeZone === "string") timeZone = report.metadata.timeZone;
    const rows = Array.isArray(report?.rows) ? report.rows : [];
    for (const row of rows) {
      const r = row as {
        dimensionValues?: { value?: unknown }[];
        metricValues?: { value?: unknown }[];
      } | null;
      out.push({
        dimensions: (r?.dimensionValues ?? []).map((v) => String(v?.value ?? "")),
        metrics: (r?.metricValues ?? []).map((v) => String(v?.value ?? "0")),
      });
    }
    const total = typeof report?.rowCount === "number" ? report.rowCount : out.length;
    if (rows.length === 0 || out.length >= total) return { rows: out, timeZone };
    page += 1;
  }
  throw new ProviderError("ga4: the report had more rows than one sync reads");
}

/* ── P2-29 / P2-34: attention by hour, landing pages, site search ── */

/**
 * Sessions per UTC hour from dateHour rows in the property's zone. A row
 * for an hour that doesn't exist in that zone (the spring-forward gap)
 * can't be placed and is dropped rather than guessed.
 */
export function aggregateHourlySessions(
  rows: readonly ReportRow[],
  timeZone: string,
  observedAt: string,
): Observation[] {
  const buckets = new HourlyBuckets();
  for (const row of rows) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(row.dimensions[0] ?? "");
    const sessions = Number(row.metrics[0]);
    if (!m || !Number.isFinite(sessions) || sessions <= 0) continue;
    const at = utcOfZonedHour(`${m[1]}-${m[2]}-${m[3]}`, Number(m[4]), timeZone);
    if (at) buckets.addSessions(at.getTime(), sessions);
  }
  return buckets.observations(observedAt);
}

/** Landing pages per day: sessions, and bounced sessions = round(sessions × bounceRate). */
export function aggregateLandingPages(
  rows: readonly ReportRow[],
  observedAt: string,
): Observation[] {
  const out: Observation[] = [];
  for (const row of rows) {
    const date = isoFromGa4Date(row.dimensions[0] ?? "");
    const page = (row.dimensions[1] ?? "").trim();
    const sessions = Number(row.metrics[0]);
    const bounceRate = Number(row.metrics[1]);
    if (date === null || page === "" || page === "(not set)" || !(sessions > 0)) continue;
    const dims = { page_ref: page.slice(0, 300) };
    out.push({
      metric_key: "landing_sessions.daily",
      period_date: date,
      dimensions: dims,
      value_num: sessions,
      observed_at: observedAt,
    });
    if (Number.isFinite(bounceRate)) {
      out.push({
        metric_key: "landing_bounces.daily",
        period_date: date,
        dimensions: dims,
        value_num: Math.round(sessions * Math.min(1, Math.max(0, bounceRate))),
        observed_at: observedAt,
      });
    }
  }
  return out;
}

/** Site-search terms per day. Lower-cased, trimmed, capped — and summed when they then coincide. */
export function aggregateSiteSearch(rows: readonly ReportRow[], observedAt: string): Observation[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const date = isoFromGa4Date(row.dimensions[0] ?? "");
    const term = (row.dimensions[1] ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 100);
    const count = Number(row.metrics[0]);
    if (date === null || term === "" || term === "(not set)" || !(count > 0)) continue;
    const key = `${date}|${term}`;
    totals.set(key, (totals.get(key) ?? 0) + count);
  }
  return [...totals.entries()].sort().map(([key, count]) => {
    const [date, term] = key.split("|") as [string, string];
    return {
      metric_key: "site_search.daily",
      period_date: date,
      dimensions: { term_ref: term },
      value_num: count,
      observed_at: observedAt,
    };
  });
}

/* ── arithmetic ── */

export interface Ga4DayRow {
  /** "YYYY-MM-DD". */
  date: string;
  channel: string;
  sessions: number;
}

function isoFromGa4Date(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Sessions for every day in [start, end]: the business total (zero days
 * included) and one row per channel group that had any sessions.
 */
export function aggregateSessions(
  rows: readonly Ga4DayRow[],
  start: Date,
  end: Date,
  observedAt: string,
): Observation[] {
  const totals = new Map<string, number>();
  const byChannel = new Map<string, Map<string, number>>();
  const from = dayString(start);
  const to = dayString(end);

  for (const row of rows) {
    if (row.date < from || row.date > to || row.sessions <= 0) continue;
    totals.set(row.date, (totals.get(row.date) ?? 0) + row.sessions);
    const channels = byChannel.get(row.date) ?? new Map<string, number>();
    channels.set(row.channel, (channels.get(row.channel) ?? 0) + row.sessions);
    byChannel.set(row.date, channels);
  }

  const out: Observation[] = [];
  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    const day = dayString(d);
    out.push({
      metric_key: "sessions.daily",
      period_date: day,
      dimensions: {},
      value_num: totals.get(day) ?? 0,
      observed_at: observedAt,
    });
    const channels = byChannel.get(day);
    if (channels) {
      for (const [channel, sessions] of [...channels.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        out.push({
          metric_key: "sessions.daily",
          period_date: day,
          dimensions: { channel_ref: channel },
          value_num: sessions,
          observed_at: observedAt,
        });
      }
    }
  }
  return out;
}

function toDayRows(rows: readonly ReportRow[]): Ga4DayRow[] {
  const out: Ga4DayRow[] = [];
  for (const row of rows) {
    const date = isoFromGa4Date(row.dimensions[0] ?? "");
    const sessions = Number(row.metrics[0]);
    if (date === null || !Number.isFinite(sessions)) {
      throw new ProviderError("ga4: a report row is missing its date or sessions");
    }
    out.push({ date, channel: row.dimensions[1] ?? "(not set)", sessions });
  }
  return out;
}

/* ── the provider ── */

const defaultFetch: Ga4Fetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    cache: "no-store",
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

/** People active in one minute: `minutes_ago` 0 is the minute now under way. */
export interface ActiveMinute {
  minutes_ago: number;
  active: number;
}

/**
 * Pure: the realtime report's rows as one figure per minute, oldest first.
 * GA4 leaves out a minute nobody was active in, so a missing minute is a 0,
 * not a gap; a row outside the span or with no number is ignored.
 */
export function activeByMinute(
  rows: readonly ReportRow[],
  span: number = GA4_REALTIME_MINUTES,
): ActiveMinute[] {
  const counts = new Map<number, number>();
  for (const row of rows) {
    const minutesAgo = Number(row.dimensions[0]);
    const active = Number(row.metrics[0]);
    if (!Number.isInteger(minutesAgo) || minutesAgo < 0 || minutesAgo >= span) continue;
    if (!Number.isFinite(active) || active < 0) continue;
    counts.set(minutesAgo, (counts.get(minutesAgo) ?? 0) + active);
  }
  return Array.from({ length: span }, (_, i) => {
    const minutesAgo = span - 1 - i;
    return { minutes_ago: minutesAgo, active: counts.get(minutesAgo) ?? 0 };
  });
}

/**
 * The realtime read behind Home's live line: people active on the site in
 * each of the last 30 minutes. A read with the same analytics.readonly token
 * as every other report here; nothing is stored, the figure goes to the
 * screen only.
 */
export function createGa4Live(options: Ga4ProviderOptions = {}) {
  const ctx: Context = {
    fetch: options.fetch ?? defaultFetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    clock: options.clock ?? (() => Date.now()),
    tokens: new Map(),
  };
  return {
    async activeNow(secret: string): Promise<ActiveMinute[]> {
      const cred = parseGa4Credential(secret);
      let token = await accessToken(ctx, cred);
      const call = () =>
        request(ctx, cred, runRealtimeReportUrl(cred.property_id), {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            dimensions: [{ name: "minutesAgo" }],
            metrics: [{ name: "activeUsers" }],
            limit: GA4_REALTIME_MINUTES,
          }),
        });
      let { status, body } = await call();
      if (status === 401) {
        token = await accessToken(ctx, cred, true); // the cached token expired early
        ({ status, body } = await call());
      }
      if (status === 403) {
        throw new ProviderError(
          `ga4: ${cred.client_email} can't read property ${cred.property_id}'s realtime figures`,
        );
      }
      if (status !== 200) {
        throw new ProviderError(
          `ga4: the realtime report failed (${status}${googleMessage(body) ? `: ${googleMessage(body)}` : ""})`,
        );
      }
      const rows = ((body as { rows?: unknown } | null)?.rows ?? []) as {
        dimensionValues?: { value?: unknown }[];
        metricValues?: { value?: unknown }[];
      }[];
      return activeByMinute(
        rows.map((r) => ({
          dimensions: (r.dimensionValues ?? []).map((d) => String(d.value ?? "")),
          metrics: (r.metricValues ?? []).map((m) => String(m.value ?? "")),
        })),
      );
    },
  };
}

export function createGa4Provider(options: Ga4ProviderOptions = {}): Provider {
  const ctx: Context = {
    fetch: options.fetch ?? defaultFetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    clock: options.clock ?? (() => Date.now()),
    tokens: new Map(),
  };

  return {
    id: "ga4",
    label: "Google Analytics",
    scopeVerification: "reported",

    async connect(secret) {
      const cred = parseGa4Credential(secret);
      const token = await accessToken(ctx, cred, true);
      const granted = [...new Set(await tokenScopes(ctx, cred, token))].sort();
      if (!granted.includes(GA4_SCOPE)) {
        throw new ProviderError("ga4: the token doesn't carry read-only analytics access");
      }
      // Prove the property is readable: one tiny report.
      const yesterday = dayString(addDays(new Date(ctx.clock()), -1));
      await runReport(ctx, cred, "probe", yesterday, yesterday);
      return { granted_scopes: granted };
    },

    async pull(secret, cursor, now): Promise<PullPage> {
      const cred = parseGa4Credential(secret);
      const plan = planWindow({
        cursor,
        now,
        historyDays: GA4_HISTORY_DAYS,
        rereadDays: GA4_REREAD_DAYS,
        windowDays: GA4_WINDOW_DAYS,
        provider: "ga4",
      });
      if (plan === null) return { observations: [], cursor, done: true };

      const startDay = dayString(plan.start);
      const endDay = dayString(plan.end);
      const observedAt = now.toISOString();
      const rows = await runReport(ctx, cred, "sessions_by_day_and_channel", startDay, endDay);
      const hourly = await runReportWithZone(ctx, cred, "sessions_by_hour", startDay, endDay);
      const landing = await runReport(ctx, cred, "landing_pages", startDay, endDay);
      const search = await runReport(ctx, cred, "site_search", startDay, endDay);
      return {
        observations: [
          ...aggregateSessions(toDayRows(rows), plan.start, plan.end, observedAt),
          // Without the property's zone an hour can't be placed — none rather than wrong.
          ...(hourly.timeZone
            ? aggregateHourlySessions(hourly.rows, hourly.timeZone, observedAt)
            : []),
          ...aggregateLandingPages(landing, observedAt),
          ...aggregateSiteSearch(search, observedAt),
        ],
        cursor: advanceCursor(cursor, plan.end),
        done: plan.end.getTime() === plan.yesterday.getTime(),
      };
    },

    async listChannels(secret): Promise<ExternalProduct[]> {
      const cred = parseGa4Credential(secret);
      const today = new Date(ctx.clock());
      const rows = await runReport(
        ctx,
        cred,
        "channels",
        dayString(addDays(today, -GA4_CHANNEL_LOOKBACK_DAYS)),
        dayString(addDays(today, -1)),
      );
      return rows
        .map((r) => ({ channel: r.dimensions[0] ?? "", sessions: Number(r.metrics[0]) }))
        .filter((r) => r.channel !== "")
        .sort((a, b) => b.sessions - a.sessions || (a.channel < b.channel ? -1 : 1))
        .map((r) => ({ ref: r.channel, title: r.channel, status: null }));
    },
  };
}

export const ga4Provider = createGa4Provider();
export const ga4Live = createGa4Live();
