// A recorded-shape Stripe, for tests only (P2-07..11).
//
// Implements exactly the one endpoint the connector calls, with the list
// behaviour Stripe documents for the balance transaction list: newest
// first, created[gte] and created[lt] filters, a limit of 1 to 100,
// starting_after cursors, and has_more. An unknown key gets Stripe's 401.
// Nothing in app code imports this file.

import type { BalanceTransaction, StripeFetch, StripeRequestInit, StripeResponse } from "./stripe";

export const FAKE_STRIPE_KEY = "rk_test_51FakeRestrictedKeyForTestsOnly";

export interface FakeStripeCall {
  url: URL;
  init: StripeRequestInit;
}

export interface FakeStripe {
  fetch: StripeFetch;
  calls: FakeStripeCall[];
}

export function jsonResponse(status: number, body: unknown): StripeResponse {
  return { status, json: async () => body };
}

/**
 * @param ledger the account's balance transactions. Read on every call, so
 *   pushing to it between syncs simulates new activity.
 * @param respond return a response to short-circuit a call (a 429, a 403),
 *   or null to let the fake answer normally. `n` counts calls from 1.
 */
export function fakeStripe(
  ledger: BalanceTransaction[],
  respond?: (call: FakeStripeCall, n: number) => StripeResponse | null,
  key: string = FAKE_STRIPE_KEY,
): FakeStripe {
  const calls: FakeStripeCall[] = [];

  const fetch: StripeFetch = async (url, init) => {
    const call: FakeStripeCall = { url: new URL(url), init };
    calls.push(call);

    const forced = respond?.(call, calls.length) ?? null;
    if (forced !== null) return forced;

    if (init.headers["authorization"] !== `Bearer ${key}`) {
      return jsonResponse(401, {
        error: { type: "invalid_request_error", message: "Invalid API Key provided" },
      });
    }
    if (call.url.pathname !== "/v1/balance_transactions") {
      return jsonResponse(404, {
        error: { type: "invalid_request_error", message: "Unrecognized request URL" },
      });
    }

    const params = call.url.searchParams;
    const gte = params.get("created[gte]");
    const lt = params.get("created[lt]");
    const limit = Math.min(100, Math.max(1, Number(params.get("limit") ?? "10")));
    const after = params.get("starting_after");

    let rows = ledger
      .filter(
        (t) =>
          (gte === null || t.created >= Number(gte)) && (lt === null || t.created < Number(lt)),
      )
      .sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    if (after !== null) {
      const index = rows.findIndex((t) => t.id === after);
      rows = index === -1 ? [] : rows.slice(index + 1);
    }

    return jsonResponse(200, {
      object: "list",
      url: call.url.pathname,
      data: rows.slice(0, limit),
      has_more: rows.length > limit,
    });
  };

  return { fetch, calls };
}

let sequence = 0;

/** One balance transaction. Amounts are signed minor units, as Stripe sends them. */
export function txn(
  at: string,
  amount: number,
  reporting_category = "charge",
  currency = "eur",
): BalanceTransaction {
  sequence += 1;
  return {
    id: `txn_${String(sequence).padStart(9, "0")}`,
    amount,
    currency,
    created: Math.floor(Date.parse(at) / 1000),
    reporting_category,
  };
}
