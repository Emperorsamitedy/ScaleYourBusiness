// The Meta Ads connector — Phase 2 Session D (P2-19).
//
// HOW AN OWNER CONNECTS. Meta issues access tokens, not keys. The owner
// creates a system user in their own Meta Business portfolio, assigns it
// their ad account, and generates a token with the ads_read permission for
// an app in that same portfolio. A business reading its own ad accounts
// needs no app review. We store the ad account ID and the token, encrypted
// (rule 10).
//
// READ-ONLY, PROVEN. The Graph API reports a token's granted permissions,
// so the connect check is real (scopeVerification: "reported"):
// ads_management, business_management, or anything else beyond ads_read
// refuses the connection. public_profile, which every token carries and
// which reads nothing about ads, is the one permission ignored. This module
// can only issue GET requests, to three paths on graph.facebook.com, and
// sends the token in a header rather than the URL. meta-ads.test.ts scans
// the source and fails the build if any of that changes.
//
// PROVISIONAL. Meta's developer documentation could not be reached from
// the build environment on 2026-09-14. Field and error details (spend as a
// decimal string, actions[].action_type, error codes 190, 10, 200, 17 and
// 613) follow Meta's widely documented API behaviour, and must be confirmed
// against a real ad account before Session D's done-when counts.
//
// WHAT IS READ. Daily spend in the ad account's currency, and the purchases
// Meta attributes to the ads. Since P3-22a also, per campaign: spend and
// the purchase VALUE Meta attributes (action_values), keyed by campaign id
// with its current name as a label, so a campaign's return on ad spend can
// be computed from measured days. Same read scope (ads_read), same path. Meta reports purchases under overlapping
// action types, so they are never summed: omni_purchase is used when
// present, then purchase, then the pixel's purchase event. Meta keeps
// attributing conversions for days after a click, so every sync re-reads
// the last 8 days. A day Meta omits because nothing ran is zero spend.

import { addDays, advanceCursor, dayString, planWindow } from "../days";
import { DecimalError, decimalToMinor } from "../decimal";
import type { Observation, Provider, PullPage } from "../provider";
import { ProviderError } from "../provider";

export const META_API_VERSION = "v25.0";
export const META_GRAPH_ORIGIN = "https://graph.facebook.com";
export const META_REQUIRED_PERMISSION = "ads_read";
export const META_IGNORED_PERMISSIONS: ReadonlySet<string> = new Set(["public_profile"]);
/** In priority order. These overlap in Meta's reporting, so only the first present is used. */
export const META_PURCHASE_ACTIONS = [
  "omni_purchase",
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
] as const;

export const META_HISTORY_DAYS = 365;
export const META_REREAD_DAYS = 8;
export const META_WINDOW_DAYS = 30;
export const META_PAGE_SIZE = 100;
export const META_MAX_PAGES = 50;
export const META_MAX_ATTEMPTS = 3;

// Shared with the write connector (lib/execution/providers/meta.ts, P3-20g).
export const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613]);
export const AUTH_CODES: ReadonlySet<number> = new Set([102, 190]);
export const PERMISSION_CODES: ReadonlySet<number> = new Set([10, 200, 294]);

export interface MetaRequestInit {
  /** The only verb the type admits. */
  method: "GET";
  headers: Record<string, string>;
}

export interface MetaResponse {
  status: number;
  json(): Promise<unknown>;
}

export type MetaFetch = (url: string, init: MetaRequestInit) => Promise<MetaResponse>;

export interface MetaProviderOptions {
  fetch?: MetaFetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface MetaCredential {
  /** Digits only; the act_ prefix is added where the API wants it. */
  account_id: string;
  access_token: string;
}

export function parseMetaCredential(secret: string): MetaCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(secret);
  } catch {
    throw new ProviderError("meta: the ad account ID and the access token are both needed");
  }
  const c = (raw ?? {}) as Record<string, unknown>;
  const account =
    typeof c["ad_account_id"] === "string" ? c["ad_account_id"].trim().replace(/^act_/, "") : "";
  if (!/^\d{5,}$/.test(account)) {
    throw new ProviderError(
      "meta: the ad account ID is the number in Ads Manager, with or without act_",
    );
  }
  const token = typeof c["access_token"] === "string" ? c["access_token"].trim() : "";
  if (token === "" || /\s/.test(token)) {
    throw new ProviderError("meta: paste the system user's access token, all on one line");
  }
  return { account_id: account, access_token: token };
}

type MetaPath = "permissions" | "account" | "insights";

function pathFor(cred: MetaCredential, which: MetaPath): string {
  switch (which) {
    case "permissions":
      return `/${META_API_VERSION}/me/permissions`;
    case "account":
      return `/${META_API_VERSION}/act_${cred.account_id}`;
    case "insights":
      return `/${META_API_VERSION}/act_${cred.account_id}/insights`;
  }
}

interface Context {
  fetch: MetaFetch;
  sleep: (ms: number) => Promise<void>;
}

function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

async function metaGet(
  ctx: Context,
  cred: MetaCredential,
  which: MetaPath,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams(params).toString();
  const url = `${META_GRAPH_ORIGIN}${pathFor(cred, which)}${query ? `?${query}` : ""}`;

  for (let attempt = 1; ; attempt += 1) {
    let response: MetaResponse;
    try {
      response = await ctx.fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${cred.access_token}`, accept: "application/json" },
      });
    } catch {
      if (attempt >= META_MAX_ATTEMPTS) {
        throw new ProviderError(`meta: network failure after ${attempt} attempts`);
      }
      await ctx.sleep(backoffMs(attempt));
      continue;
    }

    const body = (await response.json().catch(() => null)) as {
      error?: { code?: unknown; error_subcode?: unknown; message?: unknown };
    } | null;
    const error = body?.error;
    if (response.status === 200 && error === undefined && body !== null) {
      return body as Record<string, unknown>;
    }

    const code = typeof error?.code === "number" ? error.code : null;
    const subcode = typeof error?.error_subcode === "number" ? error.error_subcode : null;
    const message = typeof error?.message === "string" ? error.message : null;

    if (code !== null && AUTH_CODES.has(code)) {
      throw new ProviderError(
        "meta: that token was not accepted. It may have expired or been revoked",
      );
    }
    if ((code !== null && PERMISSION_CODES.has(code)) || (code === 100 && subcode === 33)) {
      throw new ProviderError(
        `meta: the token can't read ad account act_${cred.account_id}. Assign the ad account to the system user and give the token ads_read`,
      );
    }
    const retryable =
      (code !== null && RATE_LIMIT_CODES.has(code)) ||
      response.status === 429 ||
      response.status >= 500;
    if (retryable && attempt < META_MAX_ATTEMPTS) {
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    if (retryable) {
      throw new ProviderError(`meta: still rate limited or unavailable after ${attempt} attempts`);
    }
    throw new ProviderError(
      `meta: request failed${message ? `. ${message}` : ` with status ${response.status}`}`,
    );
  }
}

/* ── arithmetic ── */

export interface MetaAction {
  action_type: string;
  value: string;
}

export interface MetaInsightRow {
  date: string;
  spend: string;
  currency: string;
  actions: MetaAction[];
}

/** Purchases from one day's actions: the first purchase type present, never a sum. */
export function purchasesFrom(actions: readonly MetaAction[]): number {
  for (const type of META_PURCHASE_ACTIONS) {
    const action = actions.find((a) => a.action_type === type);
    if (action) {
      const value = Number(action.value);
      return Number.isFinite(value) ? Math.round(value) : 0;
    }
  }
  return 0;
}

/**
 * Spend and attributed purchases for every day in [start, end], zero days
 * included, in the ad account's currency. A row in another currency is an
 * error, not a conversion (rule 1).
 */
export function aggregateInsights(
  rows: readonly MetaInsightRow[],
  accountCurrency: string,
  start: Date,
  end: Date,
  observedAt: string,
): Observation[] {
  const currency = accountCurrency.toUpperCase();
  const spend = new Map<string, number>();
  const purchases = new Map<string, number>();
  const from = dayString(start);
  const to = dayString(end);

  for (const row of rows) {
    if (row.date < from || row.date > to) continue;
    if (row.currency.toUpperCase() !== currency) {
      throw new ProviderError(
        `meta: ${row.date} is reported in ${row.currency}, not the account's ${currency}`,
      );
    }
    let minor: number;
    try {
      minor = decimalToMinor(row.spend, currency);
    } catch (error) {
      if (error instanceof DecimalError)
        throw new ProviderError(`meta: ${row.date}: ${error.message}`);
      throw error;
    }
    spend.set(row.date, (spend.get(row.date) ?? 0) + minor);
    purchases.set(row.date, (purchases.get(row.date) ?? 0) + purchasesFrom(row.actions));
  }

  const out: Observation[] = [];
  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    const day = dayString(d);
    out.push({
      metric_key: "ad_spend.daily",
      period_date: day,
      dimensions: { currency },
      value_minor: spend.get(day) ?? 0,
      observed_at: observedAt,
    });
    out.push({
      metric_key: "ad_purchases.daily",
      period_date: day,
      dimensions: {},
      value_num: purchases.get(day) ?? 0,
      observed_at: observedAt,
    });
  }
  return out;
}

export interface MetaCampaignRow {
  date: string;
  campaign_id: string;
  campaign_name: string;
  spend: string;
  currency: string;
  action_values: MetaAction[];
}

/** Purchase value from one day's action_values: the first purchase type present, never a sum. */
export function purchaseValueFrom(values: readonly MetaAction[]): string | null {
  for (const type of META_PURCHASE_ACTIONS) {
    const v = values.find((a) => a.action_type === type);
    if (v) return v.value;
  }
  return null;
}

/**
 * Per-campaign spend and attributed purchase value, one pair per campaign
 * per day Meta reported (a campaign that didn't run reports nothing — that
 * day is not "measured" for it). Money in minor units of the account
 * currency; a row in another currency is an error, never a blend (rule 1).
 */
export function aggregateCampaignInsights(
  rows: readonly MetaCampaignRow[],
  accountCurrency: string,
  start: Date,
  end: Date,
  observedAt: string,
): Observation[] {
  const currency = accountCurrency.toUpperCase();
  const from = dayString(start);
  const to = dayString(end);
  const out: Observation[] = [];
  for (const row of rows) {
    if (row.date < from || row.date > to) continue;
    if (row.currency.toUpperCase() !== currency) {
      throw new ProviderError(
        `meta: campaign ${row.campaign_id} on ${row.date} is in ${row.currency}, not the account's ${currency}`,
      );
    }
    let spend: number;
    let value: number;
    try {
      spend = decimalToMinor(row.spend, currency);
      value = decimalToMinor(purchaseValueFrom(row.action_values) ?? "0", currency);
    } catch (error) {
      if (error instanceof DecimalError) {
        throw new ProviderError(
          `meta: campaign ${row.campaign_id} on ${row.date}: ${error.message}`,
        );
      }
      throw error;
    }
    const dimensions = {
      currency,
      campaign_ref: row.campaign_id,
      campaign_name: row.campaign_name,
    };
    out.push(
      {
        metric_key: "ad_spend.campaign.daily",
        period_date: row.date,
        dimensions,
        value_minor: spend,
        observed_at: observedAt,
      },
      {
        metric_key: "ad_purchase_value.campaign.daily",
        period_date: row.date,
        dimensions,
        value_minor: value,
        observed_at: observedAt,
      },
    );
  }
  return out;
}

function parseCampaignRow(value: unknown, fallbackCurrency: string): MetaCampaignRow {
  const r = value as {
    date_start?: unknown;
    campaign_id?: unknown;
    campaign_name?: unknown;
    spend?: unknown;
    account_currency?: unknown;
    action_values?: unknown;
  } | null;
  if (!r || typeof r.date_start !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date_start)) {
    throw new ProviderError("meta: a campaign insights row is missing its date");
  }
  if (typeof r.campaign_id !== "string" || !/^\d+$/.test(r.campaign_id)) {
    throw new ProviderError("meta: a campaign insights row is missing its campaign id");
  }
  const values = Array.isArray(r.action_values)
    ? r.action_values.flatMap((a) => {
        const v = a as { action_type?: unknown; value?: unknown } | null;
        return typeof v?.action_type === "string" && typeof v.value === "string"
          ? [{ action_type: v.action_type, value: v.value }]
          : [];
      })
    : [];
  return {
    date: r.date_start,
    campaign_id: r.campaign_id,
    campaign_name:
      typeof r.campaign_name === "string" ? r.campaign_name.slice(0, 200) : r.campaign_id,
    spend: typeof r.spend === "string" ? r.spend : "0",
    currency: typeof r.account_currency === "string" ? r.account_currency : fallbackCurrency,
    action_values: values,
  };
}

function parseInsightRow(value: unknown, fallbackCurrency: string): MetaInsightRow {
  const r = value as {
    date_start?: unknown;
    spend?: unknown;
    account_currency?: unknown;
    actions?: unknown;
  } | null;
  if (!r || typeof r.date_start !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date_start)) {
    throw new ProviderError("meta: an insights row is missing its date");
  }
  const actions = Array.isArray(r.actions)
    ? r.actions.flatMap((a) => {
        const action = a as { action_type?: unknown; value?: unknown } | null;
        return typeof action?.action_type === "string" && typeof action.value === "string"
          ? [{ action_type: action.action_type, value: action.value }]
          : [];
      })
    : [];
  return {
    date: r.date_start,
    spend: typeof r.spend === "string" ? r.spend : "0",
    currency: typeof r.account_currency === "string" ? r.account_currency : fallbackCurrency,
    actions,
  };
}

/* ── the provider ── */

async function accountCurrency(ctx: Context, cred: MetaCredential): Promise<string> {
  const account = await metaGet(ctx, cred, "account", { fields: "currency,name" });
  const currency = account["currency"];
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    throw new ProviderError("meta: the ad account didn't report its currency");
  }
  return currency.toUpperCase();
}

const defaultFetch: MetaFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    cache: "no-store",
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

export function createMetaAdsProvider(options: MetaProviderOptions = {}): Provider {
  const ctx: Context = {
    fetch: options.fetch ?? defaultFetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };

  return {
    id: "meta_ads",
    label: "Meta Ads",
    scopeVerification: "reported",

    async connect(secret) {
      const cred = parseMetaCredential(secret);
      const permissions = await metaGet(ctx, cred, "permissions", {});
      const data = Array.isArray(permissions["data"]) ? permissions["data"] : null;
      if (data === null) throw new ProviderError("meta: could not read the token's permissions");
      const granted = [
        ...new Set(
          data.flatMap((p) => {
            const perm = p as { permission?: unknown; status?: unknown } | null;
            return typeof perm?.permission === "string" &&
              perm.status === "granted" &&
              !META_IGNORED_PERMISSIONS.has(perm.permission)
              ? [perm.permission]
              : [];
          }),
        ),
      ].sort();
      if (!granted.includes(META_REQUIRED_PERMISSION)) {
        throw new ProviderError("meta: the token needs the ads_read permission");
      }
      await accountCurrency(ctx, cred); // proves the token can see this ad account
      return { granted_scopes: granted };
    },

    async pull(secret, cursor, now): Promise<PullPage> {
      const cred = parseMetaCredential(secret);
      const plan = planWindow({
        cursor,
        now,
        historyDays: META_HISTORY_DAYS,
        rereadDays: META_REREAD_DAYS,
        windowDays: META_WINDOW_DAYS,
        provider: "meta",
      });
      if (plan === null) return { observations: [], cursor, done: true };

      const currency = await accountCurrency(ctx, cred);
      const rows: MetaInsightRow[] = [];
      let after: string | null = null;
      let pages = 0;
      for (;;) {
        if (pages >= META_MAX_PAGES) {
          throw new ProviderError("meta: more insights pages than one sync reads");
        }
        const body = await metaGet(ctx, cred, "insights", {
          fields: "spend,actions,account_currency,date_start",
          level: "account",
          time_increment: "1",
          time_range: JSON.stringify({ since: dayString(plan.start), until: dayString(plan.end) }),
          limit: String(META_PAGE_SIZE),
          ...(after !== null ? { after } : {}),
        });
        pages += 1;
        const data = Array.isArray(body["data"]) ? body["data"] : [];
        rows.push(...data.map((row) => parseInsightRow(row, currency)));
        const paging = body["paging"] as
          { next?: unknown; cursors?: { after?: unknown } } | undefined;
        const nextAfter = typeof paging?.cursors?.after === "string" ? paging.cursors.after : null;
        if (typeof paging?.next !== "string" || nextAfter === null) break;
        after = nextAfter;
      }

      // P3-22a: the same window again, per campaign — same path, same scope.
      const campaignRows: MetaCampaignRow[] = [];
      let campaignAfter: string | null = null;
      for (let page = 0; ; page += 1) {
        if (page >= META_MAX_PAGES) {
          throw new ProviderError("meta: more campaign insights pages than one sync reads");
        }
        const body = await metaGet(ctx, cred, "insights", {
          fields: "campaign_id,campaign_name,spend,action_values,account_currency,date_start",
          level: "campaign",
          time_increment: "1",
          time_range: JSON.stringify({ since: dayString(plan.start), until: dayString(plan.end) }),
          limit: String(META_PAGE_SIZE),
          ...(campaignAfter !== null ? { after: campaignAfter } : {}),
        });
        const data = Array.isArray(body["data"]) ? body["data"] : [];
        campaignRows.push(...data.map((row) => parseCampaignRow(row, currency)));
        const paging = body["paging"] as
          { next?: unknown; cursors?: { after?: unknown } } | undefined;
        const next = typeof paging?.cursors?.after === "string" ? paging.cursors.after : null;
        if (typeof paging?.next !== "string" || next === null) break;
        campaignAfter = next;
      }

      return {
        observations: [
          ...aggregateInsights(rows, currency, plan.start, plan.end, now.toISOString()),
          ...aggregateCampaignInsights(
            campaignRows,
            currency,
            plan.start,
            plan.end,
            now.toISOString(),
          ),
        ],
        cursor: advanceCursor(cursor, plan.end),
        done: plan.end.getTime() === plan.yesterday.getTime(),
      };
    },
  };
}

export const metaAdsProvider = createMetaAdsProvider();
