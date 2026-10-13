// The Stripe connector — Phase 2 Session B (P2-07..09).
//
// Stripe is "the most reliable truth about revenue" (TASKS-PHASE2). The
// connector reads exactly one thing: the balance transaction list, the
// ledger every charge, refund and fee lands in. From it come two daily
// series, revenue net of refunds and order count, which P2-05 sums into the
// monthly facts that supersede the owner's estimates.
//
// READ-ONLY, AS FAR AS CAN BE PROVEN (owner decision, 2026-09-14). Stripe
// offers no API to list a restricted key's permissions, so rule 9 is
// enforced in the three places it CAN be:
//
//   1. Full-access secret keys are refused before any request is made.
//      Only restricted keys (rk_test_..., rk_live_...) are accepted.
//   2. This module only issues GET requests, to paths listed in
//      STRIPE_READ_ENDPOINTS. The request type admits no other verb,
//      stripeGet refuses any other path at runtime, and stripe.test.ts
//      fails the build if either guard is loosened.
//   3. Every read we need is proven at connect time. A missing permission
//      comes back as Stripe's own 403 message, shown to the owner verbatim.
//
// What cannot be proven, that the owner's key carries no OTHER permission,
// is stated on the connections screen rather than implied away
// (scopeVerification: "probed").
//
// Days are UTC calendar days. Revenue is gross sales minus refunds and
// partial-capture reversals, before Stripe's fees. Disputes, fees, payouts
// and transfers are excluded, because none of them is a sale.

import { HourlyBuckets } from "../hourly";
import type { Observation, Provider, PullPage } from "../provider";
import { ProviderError } from "../provider";

/** Pinned, so a Stripe release cannot reshape what we parse. */
export const STRIPE_API_VERSION = "2026-08-26.dahlia";
const API_ORIGIN = "https://api.stripe.com";

/** Every path this module may call, keyed by the registry capability it proves. */
export const STRIPE_READ_ENDPOINTS = {
  read_balance_transactions: "/v1/balance_transactions",
} as const;

export const STRIPE_BACKFILL_DAYS = 365;
/** Days per pull. One pull is one unit of the sync runner's page cap. */
export const STRIPE_WINDOW_DAYS = 30;
/** Stripe's list maximum. */
export const STRIPE_PAGE_LIMIT = 100;
/** HTTP pages per window before the window shrinks to a single day. */
export const STRIPE_MAX_PAGES_PER_WINDOW = 50;
/** Incremental runs re-read this many most recent complete days: Stripe lists are eventually consistent. */
export const STRIPE_OVERLAP_DAYS = 2;
/** Attempts per HTTP call on 429, 5xx or a network failure. Every retry loop has a hard cap. */
export const STRIPE_MAX_ATTEMPTS = 3;

/** reporting_category values that count toward revenue. Amounts carry their own sign. */
export const REVENUE_CATEGORIES: ReadonlySet<string> = new Set([
  "charge",
  "refund",
  "partial_capture_reversal",
]);

export interface StripeRequestInit {
  /** The only verb the type admits. */
  method: "GET";
  headers: Record<string, string>;
}

export interface StripeResponse {
  status: number;
  json(): Promise<unknown>;
}

export type StripeFetch = (url: string, init: StripeRequestInit) => Promise<StripeResponse>;

export interface StripeProviderOptions {
  fetch?: StripeFetch;
  sleep?: (ms: number) => Promise<void>;
}

/** The fields of a balance transaction this connector relies on. */
export interface BalanceTransaction {
  id: string;
  /** Signed, smallest currency unit. */
  amount: number;
  /** Lowercase ISO 4217, as Stripe sends it. */
  currency: string;
  /** Unix seconds. */
  created: number;
  reporting_category: string;
}

export type StripeKeyKind = "restricted_test" | "restricted_live";

/**
 * Accept restricted keys only. A full-access secret key can move money,
 * so it is refused before a single request is sent.
 */
export function classifyStripeKey(secret: string): StripeKeyKind {
  const key = secret.trim();
  if (key.startsWith("rk_test_")) return "restricted_test";
  if (key.startsWith("rk_live_")) return "restricted_live";
  if (key.startsWith("sk_")) {
    throw new ProviderError(
      "that is a full-access secret key, which can move money. Create a restricted key with read access instead",
    );
  }
  if (key.startsWith("pk_")) {
    throw new ProviderError(
      "that is a publishable key, which cannot read payments. Create a restricted key instead",
    );
  }
  throw new ProviderError(
    "that doesn't look like a Stripe restricted key. They start with rk_test_ or rk_live_",
  );
}

/* ── days ── */

const DAY_MS = 86_400_000;

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseCursor(cursor: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cursor)) {
    throw new ProviderError(`stripe: malformed cursor "${cursor}"`);
  }
  return new Date(`${cursor}T00:00:00Z`);
}

/* ── HTTP ── */

function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

function stripeMessage(body: unknown): string | null {
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" ? error.message : null;
}

const READ_PATHS: readonly string[] = Object.values(STRIPE_READ_ENDPOINTS);

async function stripeGet(
  options: Required<StripeProviderOptions>,
  key: string,
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  if (!READ_PATHS.includes(path)) {
    throw new ProviderError(`stripe: refusing to call ${path}, which is not a registered read`);
  }
  const url = `${API_ORIGIN}${path}?${new URLSearchParams(params).toString()}`;

  for (let attempt = 1; ; attempt += 1) {
    let response: StripeResponse;
    try {
      response = await options.fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${key}`,
          "stripe-version": STRIPE_API_VERSION,
        },
      });
    } catch {
      if (attempt >= STRIPE_MAX_ATTEMPTS) {
        throw new ProviderError(`stripe: network failure after ${attempt} attempts`);
      }
      await options.sleep(backoffMs(attempt));
      continue;
    }

    if (response.status === 200) return response.json();

    const body = await response.json().catch(() => null);
    const message = stripeMessage(body);
    if (response.status === 401) {
      throw new ProviderError(
        "stripe: that key was not accepted. It may be mistyped, revoked, or expired",
      );
    }
    if (response.status === 403) {
      throw new ProviderError(
        `stripe: the key is missing a read permission${message ? `. Stripe says: ${message}` : ""}`,
      );
    }
    if ((response.status === 429 || response.status >= 500) && attempt < STRIPE_MAX_ATTEMPTS) {
      await options.sleep(backoffMs(attempt));
      continue;
    }
    throw new ProviderError(
      `stripe: request failed with status ${response.status}${message ? `. ${message}` : ""}`,
    );
  }
}

function parseList(body: unknown): { data: BalanceTransaction[]; has_more: boolean } {
  const b = body as { data?: unknown; has_more?: unknown } | null;
  if (
    b === null ||
    typeof b !== "object" ||
    !Array.isArray(b.data) ||
    typeof b.has_more !== "boolean"
  ) {
    throw new ProviderError("stripe: unexpected list response shape");
  }
  const data = b.data.map((item) => {
    const t = item as Partial<BalanceTransaction> | null;
    if (
      t === null ||
      typeof t.id !== "string" ||
      !Number.isSafeInteger(t.amount) ||
      typeof t.currency !== "string" ||
      typeof t.created !== "number" ||
      typeof t.reporting_category !== "string"
    ) {
      throw new ProviderError(
        "stripe: a balance transaction is missing a field the connector relies on",
      );
    }
    return t as BalanceTransaction;
  });
  return { data, has_more: b.has_more };
}

/** Every transaction created in [start, end] (whole UTC days), or "too_many" at the page cap. */
async function fetchWindow(
  options: Required<StripeProviderOptions>,
  key: string,
  start: Date,
  end: Date,
): Promise<BalanceTransaction[] | "too_many"> {
  const out: BalanceTransaction[] = [];
  let startingAfter: string | null = null;
  for (let page = 0; page < STRIPE_MAX_PAGES_PER_WINDOW; page += 1) {
    const params: Record<string, string> = {
      limit: String(STRIPE_PAGE_LIMIT),
      "created[gte]": String(Math.floor(start.getTime() / 1000)),
      "created[lt]": String(Math.floor(addDays(end, 1).getTime() / 1000)),
    };
    if (startingAfter !== null) params["starting_after"] = startingAfter;

    const list = parseList(
      await stripeGet(options, key, STRIPE_READ_ENDPOINTS.read_balance_transactions, params),
    );
    out.push(...list.data);
    if (!list.has_more) return out;
    const last = list.data[list.data.length - 1];
    if (last === undefined) {
      throw new ProviderError(
        "stripe: has_more on an empty page, so there is nothing to continue from",
      );
    }
    startingAfter = last.id;
  }
  return "too_many";
}

/* ── arithmetic ── */

/**
 * Turn raw transactions into daily observations for every day in
 * [start, end]. Zero days are emitted, so a quiet day reads as zero sales
 * rather than a gap. Revenue rows exist for each currency seen in the
 * window and are never blended (rule 1).
 */
export function aggregateDays(
  transactions: readonly BalanceTransaction[],
  start: Date,
  end: Date,
  observedAt: string,
): Observation[] {
  const revenue = new Map<string, Map<string, number>>();
  const orders = new Map<string, number>();
  const currencies = new Set<string>();
  const hourly = new HourlyBuckets(); // P2-27
  const from = start.getTime();
  const until = addDays(end, 1).getTime();

  for (const t of transactions) {
    const at = t.created * 1000;
    if (at < from || at >= until) continue;
    const day = dayString(new Date(at));
    if (REVENUE_CATEGORIES.has(t.reporting_category)) {
      const currency = t.currency.toUpperCase();
      currencies.add(currency);
      const byCurrency = revenue.get(day) ?? new Map<string, number>();
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + t.amount);
      revenue.set(day, byCurrency);
      hourly.addRevenue(at, currency, t.amount);
    }
    if (t.reporting_category === "charge" && t.amount > 0) {
      orders.set(day, (orders.get(day) ?? 0) + 1);
      hourly.addOrder(at);
    }
  }

  const sortedCurrencies = [...currencies].sort();
  const out: Observation[] = [];
  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    const day = dayString(d);
    for (const currency of sortedCurrencies) {
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

/* ── the provider ── */

const defaultFetch: StripeFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    cache: "no-store",
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

export function createStripeProvider(options: StripeProviderOptions = {}): Provider {
  const resolved: Required<StripeProviderOptions> = {
    fetch: options.fetch ?? defaultFetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };

  return {
    id: "stripe",
    label: "Stripe",
    scopeVerification: "probed",

    async connect(secret) {
      const key = secret.trim();
      classifyStripeKey(key);
      // Prove the one read we need. limit=1: a credential check, not a sync.
      parseList(
        await stripeGet(resolved, key, STRIPE_READ_ENDPOINTS.read_balance_transactions, {
          limit: "1",
        }),
      );
      return { granted_scopes: Object.keys(STRIPE_READ_ENDPOINTS) };
    },

    async pull(secret, cursor, now): Promise<PullPage> {
      const key = secret.trim();
      classifyStripeKey(key);

      // The last complete day is yesterday; today is still being written.
      const yesterday = addDays(utcMidnight(now), -1);
      const tailStart = addDays(yesterday, -(STRIPE_OVERLAP_DAYS - 1));
      const resume = cursor === null ? null : addDays(parseCursor(cursor), 1);

      let start: Date;
      if (resume === null) {
        start = addDays(yesterday, -(STRIPE_BACKFILL_DAYS - 1));
      } else {
        // Mid-backfill, continue from the resume day. Near the present,
        // re-read the most recent days: a charge written moments before
        // the last run's list call may not have been visible to it.
        start = resume.getTime() < tailStart.getTime() ? resume : tailStart;
      }
      if (start.getTime() > yesterday.getTime()) {
        return { observations: [], cursor, done: true };
      }
      let end = new Date(
        Math.min(addDays(start, STRIPE_WINDOW_DAYS - 1).getTime(), yesterday.getTime()),
      );

      let transactions = await fetchWindow(resolved, key, start, end);
      if (transactions === "too_many") {
        // Shrink to one NEW day. Dropping the re-read tail first is what
        // guarantees the cursor advances, so a busy stretch cannot stall.
        const oneDay = resume ?? start;
        if (oneDay.getTime() > yesterday.getTime()) {
          return { observations: [], cursor, done: true };
        }
        start = oneDay;
        end = oneDay;
        transactions = await fetchWindow(resolved, key, start, end);
        if (transactions === "too_many") {
          throw new ProviderError(
            `stripe: more than ${STRIPE_PAGE_LIMIT * STRIPE_MAX_PAGES_PER_WINDOW} balance transactions on ${dayString(start)}, which one sync cannot read yet`,
          );
        }
      }

      const endDay = dayString(end);
      // The cursor never moves backwards: a tail re-read ends where the last run did.
      const nextCursor = cursor !== null && cursor > endDay ? cursor : endDay;
      return {
        observations: aggregateDays(transactions, start, end, now.toISOString()),
        cursor: nextCursor,
        done: end.getTime() === yesterday.getTime(),
      };
    },
  };
}

export const stripeProvider = createStripeProvider();
