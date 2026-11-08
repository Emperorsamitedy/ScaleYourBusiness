// A recorded-shape fake of the TikTok Marketing API, for tests only.
//
// Answers the six requests SYB makes (lib/tiktok/api.ts) with the response
// envelopes TikTok's docs show — {code, message, request_id, data} — over
// an in-memory set of ad accounts, campaigns and report rows. Every call is
// logged so a test asserts what was (and wasn't) sent. Nothing here touches
// the network.

import type { TikTokFetch, TikTokRequestInit, TikTokResponse } from "./api";
import { TIKTOK_API_ORIGIN } from "./api";

export interface FakeCampaign {
  advertiser_id: string;
  campaign_name: string;
  operation_status: string;
  secondary_status?: string;
  budget_mode: string;
  budget: number;
}

export interface FakeReportRow {
  advertiser_id: string;
  campaign_id: string;
  campaign_name: string;
  day: string;
  spend: string;
  purchases: string;
  value: string;
  currency?: string;
}

export interface FakeCall {
  method: string;
  url: URL;
  init: TikTokRequestInit;
  body: Record<string, unknown> | null;
}

export interface FakeTikTokOptions {
  token?: string;
  /** advertiser_id → currency. */
  advertisers?: Record<string, string>;
  /** The exchange's answer. */
  exchange?: { auth_code: string; advertiser_ids: string[]; scope: number[] };
  /** Report page size the fake pages by (default: whatever page_size asks). */
  pageSize?: number;
  /** Force an answer for a call (return null to fall through). */
  respond?: (call: FakeCall) => TikTokResponse | null;
}

export function tiktokJson(body: unknown, status = 200): TikTokResponse {
  return { status, json: async () => body };
}

export function tiktokOk(data: unknown): TikTokResponse {
  return tiktokJson({ code: 0, message: "OK", request_id: "fake", data });
}

export function tiktokError(code: number, message: string, status = 200): TikTokResponse {
  return tiktokJson({ code, message, request_id: "fake", data: {} }, status);
}

function parseArray(v: string | null): string[] {
  if (v === null) return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function fakeTikTok(opts: FakeTikTokOptions = {}) {
  const token = opts.token ?? "tt-fake-long-term-token";
  const advertisers = opts.advertisers ?? { "7000000000001": "EUR" };
  const campaigns = new Map<string, FakeCampaign>();
  const rows: FakeReportRow[] = [];
  const calls: FakeCall[] = [];

  const fetch: TikTokFetch = async (raw, init) => {
    const url = new URL(raw);
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const call: FakeCall = { method: init.method, url, init, body };
    calls.push(call);
    const forced = opts.respond?.(call) ?? null;
    if (forced !== null) return forced;
    if (url.origin !== TIKTOK_API_ORIGIN) throw new Error(`not TikTok: ${url.origin}`);
    const path = url.pathname;

    if (path === "/open_api/v1.3/oauth2/access_token/" && init.method === "POST") {
      const ex = opts.exchange;
      if (!ex || body?.["auth_code"] !== ex.auth_code)
        return tiktokError(40101, "invalid auth code");
      return tiktokOk({ access_token: token, advertiser_ids: ex.advertiser_ids, scope: ex.scope });
    }
    if (init.headers["Access-Token"] !== token) return tiktokError(40105, "Invalid access token");

    if (path === "/open_api/v1.3/advertiser/info/" && init.method === "GET") {
      const ids = parseArray(url.searchParams.get("advertiser_ids"));
      return tiktokOk({
        list: ids
          .filter((id) => advertisers[id] !== undefined)
          .map((id) => ({
            advertiser_id: id,
            name: `Ad account ${id}`,
            currency: advertisers[id],
            timezone: "Etc/GMT",
          })),
      });
    }
    if (path === "/open_api/v1.3/report/integrated/get/" && init.method === "GET") {
      const adv = url.searchParams.get("advertiser_id") ?? "";
      const from = url.searchParams.get("start_date") ?? "";
      const to = url.searchParams.get("end_date") ?? "";
      const page = Number(url.searchParams.get("page") ?? "1");
      const size = opts.pageSize ?? Number(url.searchParams.get("page_size") ?? "10");
      const hits = rows.filter((r) => r.advertiser_id === adv && r.day >= from && r.day <= to);
      const total_page = Math.max(1, Math.ceil(hits.length / size));
      return tiktokOk({
        page_info: { page, page_size: size, total_number: hits.length, total_page },
        list: hits.slice((page - 1) * size, page * size).map((r) => ({
          dimensions: { campaign_id: r.campaign_id, stat_time_day: `${r.day} 00:00:00` },
          metrics: {
            campaign_name: r.campaign_name,
            currency: r.currency ?? advertisers[adv],
            spend: r.spend,
            complete_payment: r.purchases,
            total_complete_payment_rate: r.value,
          },
        })),
      });
    }
    if (path === "/open_api/v1.3/campaign/get/" && init.method === "GET") {
      const adv = url.searchParams.get("advertiser_id") ?? "";
      let wanted: string[];
      try {
        const f = JSON.parse(url.searchParams.get("filtering") ?? "{}") as {
          campaign_ids?: unknown;
        };
        wanted = Array.isArray(f.campaign_ids) ? f.campaign_ids.map(String) : [];
      } catch {
        wanted = [];
      }
      const list = wanted.flatMap((id) => {
        const c = campaigns.get(id);
        return c && c.advertiser_id === adv ? [{ campaign_id: id, ...c }] : [];
      });
      return tiktokOk({ list, page_info: { page: 1, total_page: 1 } });
    }
    if (path === "/open_api/v1.3/campaign/status/update/" && init.method === "POST") {
      const ids = Array.isArray(body?.["campaign_ids"])
        ? (body["campaign_ids"] as unknown[]).map(String)
        : [];
      for (const id of ids) {
        const c = campaigns.get(id);
        if (!c || c.advertiser_id !== body?.["advertiser_id"])
          return tiktokError(40007, "campaign not found");
        c.operation_status = String(body?.["operation_status"]);
      }
      return tiktokOk({ campaign_ids: ids });
    }
    if (path === "/open_api/v1.3/campaign/update/" && init.method === "POST") {
      const id = String(body?.["campaign_id"] ?? "");
      const c = campaigns.get(id);
      if (!c || c.advertiser_id !== body?.["advertiser_id"])
        return tiktokError(40007, "campaign not found");
      c.budget = Number(body?.["budget"]);
      return tiktokOk({ campaign_id: id, budget: c.budget });
    }
    return tiktokError(40008, "the interface has not been implemented");
  };

  const writes = () =>
    calls.filter((c) => c.method === "POST" && !c.url.pathname.includes("oauth2"));
  return { fetch, calls, campaigns, rows, writes, token, advertisers };
}
