// A recorded-shape Meta Graph API, for tests only (P2-19).
//
// Implements the three GET paths the connector calls: /me/permissions, the
// ad account, and its daily insights, with bearer-token auth, Graph-style
// error bodies, and cursor paging (paging.cursors.after plus paging.next).
// Days with no delivery are absent from insights, as Meta omits them.
// Nothing in app code imports this file.

import type { MetaAction, MetaFetch, MetaRequestInit, MetaResponse } from "./meta-ads";

export const FAKE_META_TOKEN = "EAAFakeSystemUserTokenForTestsOnly";
export const FAKE_META_ACCOUNT = "1234567890";
export const FAKE_META_SECRET = JSON.stringify({
  ad_account_id: `act_${FAKE_META_ACCOUNT}`,
  access_token: FAKE_META_TOKEN,
});

export interface FakeMetaDay {
  date: string;
  spend: string;
  actions?: MetaAction[];
}

export interface FakeMetaCall {
  url: URL;
  init: MetaRequestInit;
}

export interface FakeMetaCampaignDay {
  date: string;
  campaign_id: string;
  campaign_name: string;
  spend: string;
  /** Attributed purchase value, as Meta reports it under action_values. */
  purchase_value?: string;
}

export interface FakeMetaOptions {
  days?: FakeMetaDay[];
  /** P3-22a: per-campaign rows, answered when insights is asked at level=campaign. */
  campaigns?: FakeMetaCampaignDay[];
  currency?: string;
  permissions?: { permission: string; status: string }[];
  respond?: (call: FakeMetaCall, n: number) => MetaResponse | null;
}

export interface FakeMeta {
  fetch: MetaFetch;
  calls: FakeMetaCall[];
  days: FakeMetaDay[];
}

export function metaJson(status: number, body: unknown): MetaResponse {
  return { status, json: async () => body };
}

export function metaError(code: number, message: string, subcode?: number): MetaResponse {
  return metaJson(400, {
    error: {
      message,
      type: "OAuthException",
      code,
      ...(subcode ? { error_subcode: subcode } : {}),
    },
  });
}

export function fakeMeta(options: FakeMetaOptions = {}): FakeMeta {
  const days = options.days ?? [];
  const currency = options.currency ?? "EUR";
  const permissions = options.permissions ?? [
    { permission: "ads_read", status: "granted" },
    { permission: "public_profile", status: "granted" },
  ];
  const calls: FakeMetaCall[] = [];

  const fetch: MetaFetch = async (url, init) => {
    const call: FakeMetaCall = { url: new URL(url), init };
    calls.push(call);
    const forced = options.respond?.(call, calls.length) ?? null;
    if (forced !== null) return forced;

    if (init.headers["authorization"] !== `Bearer ${FAKE_META_TOKEN}`) {
      return metaError(190, "Invalid OAuth access token - Cannot parse access token");
    }
    const path = call.url.pathname;
    if (path === "/v25.0/me/permissions") {
      return metaJson(200, { data: permissions });
    }
    if (path === `/v25.0/act_${FAKE_META_ACCOUNT}`) {
      return metaJson(200, { id: `act_${FAKE_META_ACCOUNT}`, currency, name: "Ember & Oak" });
    }
    if (
      path === `/v25.0/act_${FAKE_META_ACCOUNT}/insights` &&
      call.url.searchParams.get("level") === "campaign"
    ) {
      const range = JSON.parse(call.url.searchParams.get("time_range") ?? "{}") as {
        since?: string;
        until?: string;
      };
      const rows = (options.campaigns ?? []).filter(
        (d) => (!range.since || d.date >= range.since) && (!range.until || d.date <= range.until),
      );
      return metaJson(200, {
        data: rows.map((d) => ({
          campaign_id: d.campaign_id,
          campaign_name: d.campaign_name,
          spend: d.spend,
          account_currency: currency,
          ...(d.purchase_value
            ? { action_values: [{ action_type: "omni_purchase", value: d.purchase_value }] }
            : {}),
          date_start: d.date,
          date_stop: d.date,
        })),
        paging: { cursors: { before: "0", after: "0" } },
      });
    }
    if (path === `/v25.0/act_${FAKE_META_ACCOUNT}/insights`) {
      const range = JSON.parse(call.url.searchParams.get("time_range") ?? "{}") as {
        since?: string;
        until?: string;
      };
      const matching = days
        .filter(
          (d) => (!range.since || d.date >= range.since) && (!range.until || d.date <= range.until),
        )
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const limit = Number(call.url.searchParams.get("limit") ?? "25");
      const from = Number(call.url.searchParams.get("after") ?? "0");
      const page = matching.slice(from, from + limit);
      const next = from + page.length;
      return metaJson(200, {
        data: page.map((d) => ({
          spend: d.spend,
          account_currency: currency,
          ...(d.actions ? { actions: d.actions } : {}),
          date_start: d.date,
          date_stop: d.date,
        })),
        paging: {
          cursors: { before: String(from), after: String(next) },
          ...(next < matching.length
            ? {
                next: `https://graph.facebook.com/v25.0/act_${FAKE_META_ACCOUNT}/insights?after=${next}`,
              }
            : {}),
        },
      });
    }
    if (path.startsWith("/v25.0/act_")) {
      return metaError(
        100,
        "Unsupported get request. Object does not exist or missing permissions",
        33,
      );
    }
    return metaError(803, "Some of the aliases you requested do not exist");
  };

  return { fetch, calls, days };
}
