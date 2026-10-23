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
// BOOKINGS (specs/bookings.md §2). When the token also carries Square's two
// read-only Bookings permissions, APPOINTMENTS_READ and APPOINTMENTS_ALL_READ
// (seller-level: every booking at the seller's locations), the same windows
// read GET /v2/bookings: status, start, service, team member, duration, and
// the customer id, which the sync turns into a keyed hash before storing.
// Notes and addresses are never read. They are optional: a payments-only
// token reads payments exactly as before.
//
// WHAT IS READ. COMPLETED payments per location, created in the window:
// revenue = amount_money − refunded_money (tips are the staff's, not
// takings, and amount_money excludes them), orders = one per payment, by
// UTC day and by UTC hour (P2-27). Money is already integer minor units
// with an ISO currency (rule 1).

import { squareStatusTarget } from "../../bookings/import-map";
import { dailyBookingObservations } from "../../bookings/measures";
import type { BookingInput } from "../../bookings/types";
import { addDays, advanceCursor, dayString, planWindow } from "../days";
import { HourlyBuckets } from "../hourly";
import type { Observation, Provider, PullContext, PullPage } from "../provider";
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
/** ListBookings page size. Square's guide caps one request's start-time range at 31 days; windows are 30. */
export const SQUARE_BOOKINGS_PAGE_LIMIT = 100;
/** Both are needed for seller-level reads (Square's permissions table, read 2026-10-22). */
export const SQUARE_BOOKINGS_SCOPES = ["APPOINTMENTS_READ", "APPOINTMENTS_ALL_READ"] as const;

/** Bookings are read only when the token was granted both read permissions. */
export function readsBookings(granted: readonly string[]): boolean {
  return SQUARE_BOOKINGS_SCOPES.every((s) => granted.includes(s));
}

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
  path: "/oauth2/token/status" | "/v2/locations" | "/v2/payments" | "/v2/bookings",
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
 * Pure: one Square Booking → an appointment, or null when it doesn't count.
 * Statuses come from the map file's square_api table: ACCEPTED in the past
 * is the attended booking (Square has no "completed"), PENDING in the past
 * was never accepted and is left out. `today` is the UTC date of the read.
 */
export function toBookingInput(raw: unknown, today: string): BookingInput | null {
  const b = raw as {
    id?: unknown;
    status?: unknown;
    start_at?: unknown;
    customer_id?: unknown;
    appointment_segments?: unknown;
  } | null;
  if (!b || typeof b.id !== "string" || typeof b.status !== "string") return null;
  if (typeof b.start_at !== "string") return null;
  const at = Date.parse(b.start_at);
  if (!Number.isFinite(at)) return null;
  const iso = new Date(at).toISOString();
  const day = iso.slice(0, 10);
  const target = squareStatusTarget(b.status);
  if (target === null) return null;
  let status: BookingInput["status"];
  if (target === "accepted" || target === "booked") {
    if (day > today) status = "booked_future";
    else if (target === "accepted") status = "completed";
    else return null; // a pending request whose day has passed: never closed out
  } else {
    status = target;
  }
  const segments = (Array.isArray(b.appointment_segments) ? b.appointment_segments : []) as {
    duration_minutes?: unknown;
    service_variation_id?: unknown;
    team_member_id?: unknown;
  }[];
  const minutes = segments.reduce(
    (sum, seg) => sum + (typeof seg?.duration_minutes === "number" ? seg.duration_minutes : 0),
    0,
  );
  const first = segments[0];
  return {
    source_ref: `square:${b.id}`,
    day,
    start_time: iso.slice(11, 16),
    status,
    service: typeof first?.service_variation_id === "string" ? first.service_variation_id : null,
    staff_ref: typeof first?.team_member_id === "string" ? first.team_member_id : null,
    client:
      typeof b.customer_id === "string" && b.customer_id !== ""
        ? { kind: "id", value: b.customer_id }
        : null,
    duration_minutes: segments.length > 0 && minutes <= 1440 ? minutes : null,
    // Square bookings carry no price; Square takings come from the payments read.
    price_minor: null,
    currency: null,
  };
}

async function bookingsIn(
  ctx: Context,
  cred: SquareCredential,
  start: Date,
  end: Date,
  today: string,
): Promise<BookingInput[]> {
  const out: BookingInput[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SQUARE_MAX_PAGES; page++) {
    const { body } = await call(ctx, cred, "/v2/bookings", {
      // No location_id: Square then returns every location's bookings.
      start_at_min: start.toISOString(),
      start_at_max: addDays(end, 1).toISOString(),
      limit: String(SQUARE_BOOKINGS_PAGE_LIMIT),
      ...(cursor ? { cursor } : {}),
    });
    const res = body as { bookings?: unknown[]; cursor?: unknown } | null;
    for (const raw of res?.bookings ?? []) {
      const b = toBookingInput(raw, today);
      // The window's own days only: a booking at the next midnight belongs to the next window.
      if (b && b.day >= dayString(start) && b.day <= dayString(end)) out.push(b);
    }
    cursor = typeof res?.cursor === "string" && res.cursor !== "" ? res.cursor : null;
    if (!cursor) return out;
  }
  throw new ProviderError("square: more bookings in one window than one sync reads");
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

/** A Square call that stalls must not hang the sync cron (review 2026-10-23, #24). */
export const SQUARE_FETCH_TIMEOUT_MS = 20_000;

/** The live fetch, with its timeout. Exported for its test. */
export const squareLiveFetch: SquareFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(SQUARE_FETCH_TIMEOUT_MS),
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

const defaultFetch: SquareFetch = squareLiveFetch;

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
      // With the Bookings permissions, prove that read too: one day, one row.
      if (readsBookings(granted)) {
        const now = new Date();
        await call(ctx, cred, "/v2/bookings", {
          start_at_min: addDays(now, -1).toISOString(),
          start_at_max: now.toISOString(),
          limit: "1",
        });
      }
      return { granted_scopes: granted };
    },

    async pull(secret, cursor, now, context?: PullContext): Promise<PullPage> {
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
      const observations = aggregatePayments(payments, plan.start, plan.end, now.toISOString());
      let appointments: BookingInput[] | undefined;
      if (readsBookings(context?.granted_scopes ?? [])) {
        appointments = await bookingsIn(ctx, cred, plan.start, plan.end, dayString(now));
        observations.push(
          ...dailyBookingObservations(
            appointments,
            dayString(plan.start),
            dayString(plan.end),
            now.toISOString(),
            // Square's NO_SHOW covers a cancellation without enough notice.
            { lateSeparated: false },
          ),
        );
      }
      return {
        observations,
        cursor: advanceCursor(cursor, plan.end),
        done: plan.end.getTime() === plan.yesterday.getTime(),
        ...(appointments !== undefined ? { appointments } : {}),
      };
    },
  };
}

export const squareProvider = createSquareProvider();
