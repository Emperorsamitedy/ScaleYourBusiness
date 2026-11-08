// The TikTok Ads daily read — TikTok Ads (specs/tiktok-ads-api-v1.md).
//
// READ-ONLY, FENCED. TikTok's reporting permission can't be separated from
// the campaign-write permission SYB's one app must hold, so the connection
// is an execute-purpose consent (the I-45a precedent, TASKS-FEEDBACK.md)
// and this module is the read side of it. It calls TikTok only through
// tiktokRead — the GET requests advertiser_info and report, nothing else —
// and read.test.ts scans this source and fails the build if that changes.
//
// WHAT IS READ, per ad account the token reaches: its currency (advertiser
// info), then a BASIC report at campaign level, one row per campaign per
// day, with spend, website purchases (`complete_payment`) and their value
// (`total_complete_payment_rate` — TikTok's name for the purchase VALUE).
// Into the Phase 2 observation table, exactly the Meta Ads shapes, so the
// anomaly check, the watch, the charts, the derived monthly facts and the
// ad proposals read TikTok the way they read Meta:
//
//   ad_spend.daily                     per day, per currency, zero days included
//   ad_purchases.daily                 per day, summed over the campaigns
//   ad_spend.campaign.daily            per campaign (campaign_ref), per day it ran
//   ad_purchase_value.campaign.daily   the same, the purchase value
//
// Money is integer minor units of the ad account's currency (rule 1); a row
// in another currency than its ad account's is an error, never a blend.
// Attribution keeps landing for days after a click, so every sync re-reads
// the last 8 days. TikTok allows at most 30 days per daily report.

import { addDays, advanceCursor, dayString, planWindow } from "../connectors/days";
import { DecimalError, decimalToMinor } from "../connectors/decimal";
import type { Observation, PullPage } from "../connectors/provider";
import { minorUnitExponent } from "../core/money";
import type { TikTokContext, TikTokCredential } from "./api";
import { TikTokFenceError, parseTikTokCredential, tiktokRead } from "./api";

export const TIKTOK_HISTORY_DAYS = 365;
export const TIKTOK_REREAD_DAYS = 8;
/** TikTok: "the maximum time range … is 30 days" when dimensions include stat_time_day. */
export const TIKTOK_WINDOW_DAYS = 30;
export const TIKTOK_PAGE_SIZE = 1000;
export const TIKTOK_MAX_PAGES = 50;
/** One connection reads at most this many ad accounts. */
export const TIKTOK_MAX_ADVERTISERS = 20;

export const TIKTOK_REPORT_METRICS = [
  "campaign_name",
  "currency",
  "spend",
  "complete_payment",
  "total_complete_payment_rate",
] as const;

export class TikTokReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TikTokReadError";
  }
}

/** A decimal string from TikTok → minor units. Sub-minor digits (TikTok's own) are rounded, never refused. */
export function tiktokMinor(amount: string, currency: string): number {
  const text = amount.trim();
  if (text === "" || text === "-") return 0;
  try {
    return decimalToMinor(text, currency);
  } catch (error) {
    if (!(error instanceof DecimalError) || !/^-?\d+(\.\d+)?$/.test(text)) {
      throw new TikTokReadError(`tiktok: "${amount}" is not an amount`);
    }
    return Math.round(Number(text) * 10 ** minorUnitExponent(currency.toUpperCase()));
  }
}

function count(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export interface TikTokCampaignRow {
  advertiser_id: string;
  campaign_id: string;
  campaign_name: string;
  /** "YYYY-MM-DD" — the ad account's own calendar day. */
  date: string;
  currency: string;
  spend: string;
  purchases: string;
  purchase_value: string;
}

/** One report row → a campaign day. Malformed rows refuse the read rather than skew it. */
export function parseReportRow(
  value: unknown,
  advertiserId: string,
  accountCurrency: string,
): TikTokCampaignRow {
  const r = value as { dimensions?: unknown; metrics?: unknown } | null;
  const dims = (r?.dimensions ?? {}) as Record<string, unknown>;
  const m = (r?.metrics ?? {}) as Record<string, unknown>;
  const id = dims["campaign_id"];
  const day = typeof dims["stat_time_day"] === "string" ? dims["stat_time_day"].slice(0, 10) : "";
  if (typeof id !== "string" || !/^\d{5,25}$/.test(id)) {
    throw new TikTokReadError("tiktok: a report row is missing its campaign id");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new TikTokReadError("tiktok: a report row is missing its day");
  }
  const str = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : "0");
  const name =
    typeof m["campaign_name"] === "string" && m["campaign_name"] !== "-" ? m["campaign_name"] : id;
  return {
    advertiser_id: advertiserId,
    campaign_id: id,
    campaign_name: name.slice(0, 200),
    date: day,
    currency:
      typeof m["currency"] === "string" && /^[A-Za-z]{3}$/.test(m["currency"])
        ? m["currency"].toUpperCase()
        : accountCurrency,
    spend: str("spend"),
    purchases: str("complete_payment"),
    purchase_value: str("total_complete_payment_rate"),
  };
}

/**
 * Pure: the observations for [start, end] from campaign rows. Business-wide
 * spend for every day in every ad-account currency (zero days included),
 * purchases summed over campaigns, and the per-campaign pair for each day a
 * campaign reported. A row in another currency than its ad account's is an
 * error (rule 1).
 */
export function aggregateTikTok(
  rows: readonly TikTokCampaignRow[],
  currencyByAdvertiser: ReadonlyMap<string, string>,
  start: Date,
  end: Date,
  observedAt: string,
): Observation[] {
  const from = dayString(start);
  const to = dayString(end);
  const spend = new Map<string, Map<string, number>>(); // currency → day → minor
  const purchases = new Map<string, number>();
  const out: Observation[] = [];
  for (const currency of new Set(currencyByAdvertiser.values())) spend.set(currency, new Map());

  for (const row of rows) {
    if (row.date < from || row.date > to) continue;
    const accountCurrency = currencyByAdvertiser.get(row.advertiser_id);
    if (accountCurrency === undefined) {
      throw new TikTokReadError(`tiktok: ad account ${row.advertiser_id} wasn't read first`);
    }
    if (row.currency !== accountCurrency) {
      throw new TikTokReadError(
        `tiktok: campaign ${row.campaign_id} on ${row.date} is in ${row.currency}, not its ad account's ${accountCurrency}`,
      );
    }
    const spent = tiktokMinor(row.spend, accountCurrency);
    const value = tiktokMinor(row.purchase_value, accountCurrency);
    const byDay = spend.get(accountCurrency) as Map<string, number>;
    byDay.set(row.date, (byDay.get(row.date) ?? 0) + spent);
    purchases.set(row.date, (purchases.get(row.date) ?? 0) + count(row.purchases));
    const dimensions = {
      currency: accountCurrency,
      campaign_ref: row.campaign_id,
      campaign_name: row.campaign_name,
    };
    out.push(
      {
        metric_key: "ad_spend.campaign.daily",
        period_date: row.date,
        dimensions,
        value_minor: spent,
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

  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    const day = dayString(d);
    for (const [currency, byDay] of spend) {
      out.push({
        metric_key: "ad_spend.daily",
        period_date: day,
        dimensions: { currency },
        value_minor: byDay.get(day) ?? 0,
        observed_at: observedAt,
      });
    }
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

/** Each ad account's currency, from TikTok's advertiser info. */
export async function readAdvertiserCurrencies(
  ctx: TikTokContext,
  cred: TikTokCredential,
  accountId: string | null = null,
): Promise<Map<string, string>> {
  const ids = cred.advertiser_ids.slice(0, TIKTOK_MAX_ADVERTISERS);
  const data = await tiktokRead(ctx, "advertiser_info", {
    token: cred.access_token,
    query: { advertiser_ids: ids, fields: ["advertiser_id", "name", "currency", "timezone"] },
    account_id: accountId,
  });
  const list = Array.isArray(data["list"]) ? data["list"] : [];
  const out = new Map<string, string>();
  for (const item of list) {
    const a = (item ?? {}) as Record<string, unknown>;
    const id = String(a["advertiser_id"] ?? "");
    const currency = typeof a["currency"] === "string" ? a["currency"].toUpperCase() : "";
    if (ids.includes(id) && /^[A-Z]{3}$/.test(currency)) out.set(id, currency);
  }
  for (const id of ids) {
    if (!out.has(id)) {
      throw new TikTokReadError(`tiktok: ad account ${id} didn't report its currency`);
    }
  }
  return out;
}

/** Every campaign-day row for one ad account over [from, to], every page. */
export async function readCampaignDays(
  ctx: TikTokContext,
  cred: TikTokCredential,
  advertiserId: string,
  currency: string,
  from: string,
  to: string,
  accountId: string | null = null,
): Promise<TikTokCampaignRow[]> {
  const rows: TikTokCampaignRow[] = [];
  for (let page = 1; ; page += 1) {
    if (page > TIKTOK_MAX_PAGES) {
      throw new TikTokReadError("tiktok: more report pages than one sync reads");
    }
    const data = await tiktokRead(ctx, "report", {
      token: cred.access_token,
      query: {
        advertiser_id: advertiserId,
        report_type: "BASIC",
        service_type: "AUCTION",
        data_level: "AUCTION_CAMPAIGN",
        dimensions: ["campaign_id", "stat_time_day"],
        metrics: [...TIKTOK_REPORT_METRICS],
        start_date: from,
        end_date: to,
        page: String(page),
        page_size: String(TIKTOK_PAGE_SIZE),
      },
      account_id: accountId,
    });
    const list = Array.isArray(data["list"]) ? data["list"] : [];
    rows.push(...list.map((row) => parseReportRow(row, advertiserId, currency)));
    const info = (data["page_info"] ?? {}) as { total_page?: unknown };
    const total = typeof info.total_page === "number" ? info.total_page : 1;
    if (page >= total || list.length === 0) break;
  }
  return rows;
}

/**
 * One page of the read, the Provider.pull shape: the next window after the
 * cursor (a year of backfill, then the last 8 days again), every ad account
 * the token reaches.
 */
export async function pullTikTok(
  ctx: TikTokContext,
  secret: string,
  cursor: string | null,
  now: Date,
  accountId: string | null = null,
): Promise<PullPage> {
  let cred: TikTokCredential;
  try {
    cred = parseTikTokCredential(secret);
  } catch (error) {
    if (error instanceof TikTokFenceError) throw new TikTokReadError(error.message);
    throw error;
  }
  const plan = planWindow({
    cursor,
    now,
    historyDays: TIKTOK_HISTORY_DAYS,
    rereadDays: TIKTOK_REREAD_DAYS,
    windowDays: TIKTOK_WINDOW_DAYS,
    provider: "tiktok",
  });
  if (plan === null) return { observations: [], cursor, done: true };

  const currencies = await readAdvertiserCurrencies(ctx, cred, accountId);
  const rows: TikTokCampaignRow[] = [];
  for (const [advertiserId, currency] of currencies) {
    rows.push(
      ...(await readCampaignDays(
        ctx,
        cred,
        advertiserId,
        currency,
        dayString(plan.start),
        dayString(plan.end),
        accountId,
      )),
    );
  }
  return {
    observations: aggregateTikTok(rows, currencies, plan.start, plan.end, now.toISOString()),
    cursor: advanceCursor(cursor, plan.end),
    done: plan.end.getTime() === plan.yesterday.getTime(),
  };
}
