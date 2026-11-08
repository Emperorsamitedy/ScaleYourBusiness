// A recorded-shape fake of Google for the Google Ads tests — P2-20 / P3-22.
// No network: every test hands this fetch to the code under test, and the
// shapes follow Google's reference pages as read on 2026-11-08
// (specs/google-ads-api-v1.md): REST JSON in lowerCamelCase, int64 as
// strings, search answering {results, nextPageToken?, fieldMask}, mutate
// answering {results:[{resourceName}]}, and the token endpoint answering
// {access_token, refresh_token?, scope}.

import type { FetchLike } from "./client";
import { GOOGLE_ADS_SCOPE } from "./client";

export interface FakeCampaign {
  id: string;
  name: string;
  status: "ENABLED" | "PAUSED" | "REMOVED";
  budget_id: string;
  amount_micros: number;
  shared?: boolean;
  period?: string;
}

export interface FakeCampaignDay {
  date: string;
  campaign_id: string;
  cost_micros: number;
  clicks: number;
  conversions: number;
  conversions_value: number;
}

export interface FakeCustomer {
  id: string;
  name: string;
  currency: string;
  manager?: boolean;
}

export interface FakeGoogleAdsOptions {
  scope?: string;
  refreshToken?: string | null;
  customers?: FakeCustomer[];
  campaigns?: FakeCampaign[];
  days?: FakeCampaignDay[];
  /** HTTP status to answer every mutate with (default 200). */
  mutateStatus?: number;
  /** A body to answer a failed request with. */
  failBody?: unknown;
  /** Answer every search with this status instead. */
  searchStatus?: number;
  /** Rows per search page (to exercise nextPageToken). */
  pageSize?: number;
}

export interface FakeCall {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function fakeGoogleAds(opts: FakeGoogleAdsOptions = {}) {
  const customers = opts.customers ?? [{ id: "1234567890", name: "Lumen Ads", currency: "EUR" }];
  const campaigns = new Map((opts.campaigns ?? []).map((c) => [c.id, { ...c }]));
  const calls: FakeCall[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const raw = init.body;
    const body =
      typeof raw === "string"
        ? (JSON.parse(raw) as unknown)
        : raw instanceof URLSearchParams
          ? Object.fromEntries(raw)
          : null;
    calls.push({
      method,
      url: input,
      body,
      headers: { ...((init.headers ?? {}) as Record<string, string>) },
    });

    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
      const grant = (body as Record<string, string>).grant_type;
      return json(200, {
        access_token: "ya29.fake-access",
        expires_in: 3599,
        token_type: "Bearer",
        scope: opts.scope ?? GOOGLE_ADS_SCOPE,
        ...(grant === "authorization_code" && opts.refreshToken !== null
          ? { refresh_token: opts.refreshToken ?? "1//fake-ads-refresh" }
          : {}),
      });
    }
    if (url.origin !== "https://googleads.googleapis.com")
      return json(404, { error: "unknown host" });

    if (method === "GET" && url.pathname === "/v26/customers:listAccessibleCustomers") {
      return json(200, { resourceNames: customers.map((c) => `customers/${c.id}`) });
    }
    const search = /^\/v26\/customers\/(\d{10})\/googleAds:search$/.exec(url.pathname);
    if (method === "POST" && search) {
      if (opts.searchStatus) return json(opts.searchStatus, opts.failBody ?? { error: {} });
      const customer = customers.find((c) => c.id === search[1]);
      if (!customer) return json(403, { error: { code: 7, message: "denied" } });
      const { query, pageToken } = body as { query: string; pageToken?: string };
      let results: Record<string, unknown>[];
      if (/FROM customer$/.test(query)) {
        results = [
          {
            customer: {
              resourceName: `customers/${customer.id}`,
              id: customer.id,
              descriptiveName: customer.name,
              currencyCode: customer.currency,
              timeZone: "Europe/Budapest",
              manager: customer.manager === true,
            },
          },
        ];
      } else if (/WHERE campaign\.id = (\d+)$/.test(query)) {
        const id = /WHERE campaign\.id = (\d+)$/.exec(query)?.[1] ?? "";
        const c = campaigns.get(id);
        results = c
          ? [
              {
                campaign: {
                  resourceName: `customers/${customer.id}/campaigns/${c.id}`,
                  id: c.id,
                  name: c.name,
                  status: c.status,
                  campaignBudget: `customers/${customer.id}/campaignBudgets/${c.budget_id}`,
                },
                campaignBudget: {
                  resourceName: `customers/${customer.id}/campaignBudgets/${c.budget_id}`,
                  amountMicros: String(c.amount_micros),
                  explicitlyShared: c.shared === true,
                  period: c.period ?? "DAILY",
                },
                customer: {
                  resourceName: `customers/${customer.id}`,
                  currencyCode: customer.currency,
                },
              },
            ]
          : [];
      } else {
        const m = /BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'$/.exec(query);
        const [from, to] = [m?.[1] ?? "", m?.[2] ?? ""];
        results = (opts.days ?? [])
          .filter((d) => d.date >= from && d.date <= to)
          .map((d) => ({
            campaign: {
              resourceName: `customers/${customer.id}/campaigns/${d.campaign_id}`,
              id: d.campaign_id,
              name: campaigns.get(d.campaign_id)?.name ?? `Campaign ${d.campaign_id}`,
            },
            metrics: {
              costMicros: String(d.cost_micros),
              clicks: String(d.clicks),
              conversions: d.conversions,
              conversionsValue: d.conversions_value,
            },
            segments: { date: d.date },
          }));
      }
      const size = opts.pageSize ?? 10_000;
      const start = pageToken ? Number(pageToken) : 0;
      const page = results.slice(start, start + size);
      const next = start + size < results.length ? String(start + size) : undefined;
      return json(200, {
        results: page,
        ...(next ? { nextPageToken: next } : {}),
        fieldMask: "fake",
      });
    }
    const mutate = /^\/v26\/customers\/(\d{10})\/(campaigns|campaignBudgets):mutate$/.exec(
      url.pathname,
    );
    if (method === "POST" && mutate) {
      if (opts.mutateStatus && opts.mutateStatus !== 200) {
        return json(opts.mutateStatus, opts.failBody ?? { error: { code: 3 } });
      }
      const b = body as {
        operations: { updateMask: string; update: Record<string, string> }[];
        validateOnly?: boolean;
      };
      const results = b.operations.map((op) => ({ resourceName: op.update.resourceName }));
      if (!b.validateOnly) {
        for (const op of b.operations) {
          const name = op.update.resourceName ?? "";
          if (mutate[2] === "campaigns") {
            const c = campaigns.get(name.split("/").pop() ?? "");
            if (c && op.update.status) c.status = op.update.status as FakeCampaign["status"];
          } else {
            const budgetId = name.split("/").pop();
            for (const c of campaigns.values()) {
              if (c.budget_id === budgetId && op.update.amountMicros) {
                c.amount_micros = Number(op.update.amountMicros);
              }
            }
          }
        }
      }
      return json(200, { results });
    }
    return json(404, { error: { code: 5, message: "not found" } });
  };

  return { fetch: fetchImpl, calls, campaigns };
}
