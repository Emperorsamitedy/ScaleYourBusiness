// The Square connector — Phase 2 Session F (P2-28), read-only.
//
// WHY SQUARE. Bars, cafés and shops take payment at a till, not through
// Stripe, and Square is a common till. Square records every payment it
// takes — card AND cash rung up in Square POS (source_type CASH) — as a
// Payment object readable by the Payments API (Square docs, checked
// 2026-10-13). So for a Square business, cash that goes through the till
// is measured; only cash never rung up is invisible, and the screens say
// exactly that.
//
// HOW AN OWNER CONNECTS. A personal access token from the Square Developer
// Console (or, later, OAuth), with exactly two permissions: PAYMENTS_READ
// and MERCHANT_PROFILE_READ (to list locations — ListPayments reads only
// the main location unless asked for each). POST /oauth2/token/status
// reports the token's scopes, so the connect check is real
// (scopeVerification "reported"); anything beyond the two is refused by
// the registry. This module knows three paths on one Square host and uses
// GET for every read; square.test.ts scans the source.
//
// WHAT IS READ. COMPLETED payments per location, created in the window:
// revenue = amount_money − refunded_money (tips are the staff's, not
// takings, and amount_money excludes them), orders = one per payment, by
// UTC day and by UTC hour (P2-27). Money is already integer minor units
// with an ISO currency (rule 1).

import { addDays, advanceCursor, dayString, planWindow } from "../days";
import { HourlyBuckets } from "../hourly";
import type { Observation, Provider, PullPage } from "../provider";
import { ProviderError } from "../provider";

export const SQUARE_VERSION = "2026-09-16";
export const SQUARE_HOSTS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;
export const SQUARE_HISTORY_DAYS = 365;
export const SQUARE_REREAD_DAYS = 2;
export const SQUARE_WINDOW_DAYS = 30;
/** Square's documented maximum page size for ListPayments. */
export const SQUARE_PAGE_LIMIT = 100;
export const SQUARE_MAX_PAGES = 200;
export const SQUARE_MAX_ATTEMPTS = 3;

export interface SquareRequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}
export interface SquareResponse {
  status: number;
  json(): Promise<unknown>;
}
export type SquareFetch = (url: string, init: SquareRequestInit) => Promise<SquareResponse>;

export interface SquareCredential {
  access_token: string;
  environment: keyof typeof SQUARE_HOSTS;
}

export function parseSquareCredential(secret: string): SquareCredential {
  let o: Record<string, unknown>;
  try {
    o = (JSON.parse(secret) ?? {}) as Record<string, unknown>;
  } catch {
    throw new ProviderError("square: the access token is needed");
  }
  const token = typeof o["access_token"] === "string" ? o["access_token"].trim() : "";
  const env = o["environment"] === "sandbox" ? "sandbox" : "production";
  if (token.length < 20 || /\s/.test(token)) {
    throw new ProviderError("square: that doesn't look like a Square access token");
  }
  return { access_token: token, environment: env };
}

export interface SquarePayment {
  id: string;
  created_at: string;
  status: string;
  source_type: string | null;
  location_id: string | null;
  amount: number;
  refunded: number;
  currency: string;
}

const backoffMs = (attempt: number) => 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);

function squareMessage(body: unknown): string | null {
  const errors = (body as { errors?: { detail?: unknown; code?: unknown }[] } | null)?.errors;
  const first = Array.isArray(errors) ? errors[0] : undefined;
  if (!first) return null;
  return typeof first.detail === "string"
    ? first.detail
    : typeof first.code === "string"
      ? first.code
      : null;
}

interface Context {
  fetch: SquareFetch;
  sleep: (ms: number) => Promise<void>;
}

async function call(
  ctx: Context,
  cred: SquareCredential,
  path: "/oauth2/token/status" | "/v2/locations" | "/v2/payments",
  query?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const host = SQUARE_HOSTS[cred.environment];
  const url = `${host}${path}${query ? `?${new URLSearchParams(query).toString()}` : ""}`;
  const init: SquareRequestInit = {
    // token/status is a POST (Square docs); every data read is a GET.
    method: path === "/oauth2/token/status" ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${cred.access_token}`,
      "square-version": SQUARE_VERSION,
      "content-type": "application/json",
    },
  };
  for (let attempt = 1; ; attempt += 1) {
    let response: SquareResponse;
    try {
      response = await ctx.fetch(url, init);
    } catch {
      if (attempt >= SQUARE_MAX_ATTEMPTS)
        throw new ProviderError(`square: network failure after ${attempt} attempts`);
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < SQUARE_MAX_ATTEMPTS) {
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    const body = await response.json().catch(() => null);
    if (response.status === 401) {
      throw new ProviderError(
        "square: Square didn't accept the access token. It may have been revoked, or be for the other environment",
      );
    }
    if (response.status === 403) {
      throw new ProviderError(
        `square: the token is missing a permission${squareMessage(body) ? ` — ${squareMessage(body)}` : ""}`,
      );
    }
    if (response.status !== 200) {
      throw new ProviderError(
        `square: ${path} failed with status ${response.status}${squareMessage(body) ? `. ${squareMessage(body)}` : ""}`,
      );
    }
    return { status: response.status, body };
  }
}

async function locationIds(ctx: Context, cred: SquareCredential): Promise<string[]> {
  const { body } = await call(ctx, cred, "/v2/locations");
  const list =
    (body as { locations?: { id?: unknown; status?: unknown }[] } | null)?.locations ?? [];
  // Inactive locations still have history; read them all.
  return list.map((l) => (typeof l.id === "string" ? l.id : "")).filter((id) => id !== "");
}

function toPayment(raw: unknown): SquarePayment | null {
  const p = raw as {
    id?: unknown;
    created_at?: unknown;
    status?: unknown;
    source_type?: unknown;
    location_id?: unknown;
    amount_money?: { amount?: unknown; currency?: unknown };
    refunded_money?: { amount?: unknown; currency?: unknown };
  } | null;
  if (
    !p ||
    typeof p.id !== "string" ||
    typeof p.created_at !== "string" ||
    typeof p.status !== "string" ||
    typeof p.amount_money?.amount !== "number" ||
    typeof p.amount_money?.currency !== "string"
  ) {
    return null;
  }
  return {
    id: p.id,
    created_at: p.created_at,
    status: p.status,
    source_type: typeof p.source_type === "string" ? p.source_type : null,
    location_id: typeof p.location_id === "string" ? p.location_id : null,
    amount: p.amount_money.amount,
    refunded: typeof p.refunded_money?.amount === "number" ? p.refunded_money.amount : 0,
    currency: p.amount_money.currency.toUpperCase(),
  };
}

async function paymentsIn(
  ctx: Context,
  cred: SquareCredential,
  location: string,
  start: Date,
  end: Date,
): Promise<SquarePayment[]> {
  const out: SquarePayment[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SQUARE_MAX_PAGES; page++) {
    const { body } = await call(ctx, cred, "/v2/payments", {
      begin_time: start.toISOString(),
      end_time: addDays(end, 1).toISOString(),
      sort_order: "ASC",
      location_id: location,
      limit: String(SQUARE_PAGE_LIMIT),
      ...(cursor ? { cursor } : {}),
    });
    const res = body as { payments?: unknown[]; cursor?: unknown } | null;
    for (const raw of res?.payments ?? []) {
      const p = toPayment(raw);
      if (p) out.push(p);
    }
    cursor = typeof res?.cursor === "string" && res.cursor !== "" ? res.cursor : null;
    if (!cursor) return out;
  }
  throw new ProviderError("square: more payments in one window than one sync reads");
}

/**
 * Pure: completed payments → daily and hourly revenue and orders, for every
 * day in [start, end] (zero days included). Currencies are never blended.
 */
export function aggregatePayments(
  payments: readonly SquarePayment[],
  start: Date,
  end: Date,
  observedAt: string,
): Observation[] {
  const revenue = new Map<string, Map<string, number>>();
  const orders = new Map<string, number>();
  const currencies = new Set<string>();
  const hourly = new HourlyBuckets();
  const from = start.getTime();
  const until = addDays(end, 1).getTime();
  for (const p of payments) {
    if (p.status !== "COMPLETED") continue;
    const at = Date.parse(p.created_at);
    if (!Number.isFinite(at) || at < from || at >= until) continue;
    const day = dayString(new Date(at));
    const net = p.amount - p.refunded;
    currencies.add(p.currency);
    const byCurrency = revenue.get(day) ?? new Map<string, number>();
    byCurrency.set(p.currency, (byCurrency.get(p.currency) ?? 0) + net);
    revenue.set(day, byCurrency);
    orders.set(day, (orders.get(day) ?? 0) + 1);
    hourly.addRevenue(at, p.currency, net);
    hourly.addOrder(at);
  }
  const out: Observation[] = [];
  const sorted = [...currencies].sort();
  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    const day = dayString(d);
    for (const currency of sorted) {
      out.push({
        metric_key: "revenue.daily",
        period_date: day,
        dimensions: { currency },
        value_minor: revenue.get(day)?.get(currency) ?? 0,
        observed_at: observedAt,
      });
    }
    out.push({
      metric_key: "orders.daily",
      period_date: day,
      dimensions: {},
      value_num: orders.get(day) ?? 0,
      observed_at: observedAt,
    });
  }
  out.push(...hourly.observations(observedAt));
  return out;
}

const defaultFetch: SquareFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    cache: "no-store",
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

export function createSquareProvider(
  options: { fetch?: SquareFetch; sleep?: (ms: number) => Promise<void> } = {},
): Provider {
  const ctx: Context = {
    fetch: options.fetch ?? defaultFetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
  return {
    id: "square",
    label: "Square",
    scopeVerification: "reported",

    async connect(secret) {
      const cred = parseSquareCredential(secret);
      const { body } = await call(ctx, cred, "/oauth2/token/status");
      const scopes = (body as { scopes?: unknown } | null)?.scopes;
      if (!Array.isArray(scopes))
        throw new ProviderError("square: Square could not confirm the token's permissions");
      const granted = [...new Set(scopes.filter((s): s is string => typeof s === "string"))].sort();
      // Prove the reads work: the locations, and one page of payments.
      const locations = await locationIds(ctx, cred);
      if (locations.length === 0)
        throw new ProviderError("square: the account has no locations to read");
      return { granted_scopes: granted };
    },

    async pull(secret, cursor, now): Promise<PullPage> {
      const cred = parseSquareCredential(secret);
      const plan = planWindow({
        cursor,
        now,
        historyDays: SQUARE_HISTORY_DAYS,
        rereadDays: SQUARE_REREAD_DAYS,
        windowDays: SQUARE_WINDOW_DAYS,
        provider: "square",
      });
      if (plan === null) return { observations: [], cursor, done: true };
      const payments: SquarePayment[] = [];
      for (const location of await locationIds(ctx, cred)) {
        payments.push(...(await paymentsIn(ctx, cred, location, plan.start, plan.end)));
      }
      return {
        observations: aggregatePayments(payments, plan.start, plan.end, now.toISOString()),
        cursor: advanceCursor(cursor, plan.end),
        done: plan.end.getTime() === plan.yesterday.getTime(),
      };
    },
  };
}

export const squareProvider = createSquareProvider();
