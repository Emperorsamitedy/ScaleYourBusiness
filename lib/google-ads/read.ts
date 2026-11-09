// The Google Ads daily read — P2-20, "Google Ads read-only, same shape" as
// Meta's P2-19, through an EXECUTE connection.
//
// Google's only Google Ads scope can write, so the credential is held as a
// write consent (lib/google-ads/consent.ts) and never enters the measurement
// registry. What it reads is still measurement: this source rides the daily
// connector-sync beat (lib/connectors/execute-reads.ts → sync.ts), so its
// pages land in metric_observations WITH the cursor, idempotently, and the
// derivation, the anomaly check, the watch log, the charts and the ad
// proposals see Google spend exactly as they see Meta's.
//
// READ ONLY, IN CODE. Every request goes through lib/google-ads/client.ts:
// Google's token endpoint (through the Business Profile client's fence) and
// GAQL search — a SELECT, to googleAds:search. Nothing here can name a
// mutate endpoint; client.test.ts fails the build if anything but the
// execution provider does.
//
// WHAT IS READ, per campaign per day (GAQL FROM campaign, segments.date):
// metrics.cost_micros (spend, micros of the account currency → integer
// minor units, rule 1), metrics.clicks, metrics.conversions (a double: the
// conversion actions Google counts in "Conversions") and
// metrics.conversions_value (their value, a double in the account currency
// → minor units). Business-wide totals are the campaigns' sum per day, zero
// days included (a day nothing ran is zero spend, as with Meta).
//
//   ad_spend.daily                        spend, business-wide
//   ad_clicks.daily, ad_conversions.daily clicks and conversions, business-wide
//   ad_spend.campaign.daily               spend per campaign (campaign_ref)
//   ad_purchase_value.campaign.daily      conversion value per campaign — the
//                                         ROAS numerator, as Meta's purchase
//                                         value is; the words say "conversion
//                                         value Google attributes"
//   ad_clicks.campaign.daily, ad_conversions.campaign.daily
//
// Google's conversions are not necessarily purchases (a lead, a call), so no
// ad_purchases.daily is written: cost per purchase stays Meta's alone.
// Google keeps attributing conversions after the click, so every sync
// re-reads the last 8 days, like Meta. A row in another currency than the
// account's is an error, never a conversion.

import { addDays, advanceCursor, dayString, planWindow } from "../connectors/days";
import type { Observation, PullPage } from "../connectors/provider";
import { ProviderError } from "../connectors/provider";
import type { GoogleAdsEnv } from "../env";
import { googleAdsEnv } from "../env";
import { refreshAccess } from "../google-business/client";
import type { FetchLike } from "./client";
import {
  amountToMinor,
  microsToMinor,
  readCustomer,
  readDouble,
  readId,
  readInt64,
  searchAll,
} from "./client";
import { readGoogleAdsSecret } from "./consent";

export const GADS_HISTORY_DAYS = 365;
export const GADS_REREAD_DAYS = 8;
export const GADS_WINDOW_DAYS = 30;

export interface GadsCampaignDay {
  date: string;
  campaign_id: string;
  campaign_name: string;
  cost_micros: number;
  clicks: number;
  conversions: number;
  conversions_value: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pure: GAQL for one window's campaign days. Dates are validated, never interpolated raw. */
export function campaignDayQuery(from: string, to: string): string {
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw new ProviderError("google ads: bad window");
  return (
    "SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros, metrics.clicks, " +
    "metrics.conversions, metrics.conversions_value FROM campaign " +
    `WHERE segments.date BETWEEN '${from}' AND '${to}'`
  );
}

/** Pure: one GoogleAdsRow (REST JSON, lowerCamelCase) into a campaign day, or null. */
export function readCampaignDay(row: Record<string, unknown>): GadsCampaignDay | null {
  const seg = (row["segments"] ?? {}) as Record<string, unknown>;
  const c = (row["campaign"] ?? {}) as Record<string, unknown>;
  const m = (row["metrics"] ?? {}) as Record<string, unknown>;
  const date = seg["date"];
  const id = readId(c["id"]);
  if (typeof date !== "string" || !DAY_RE.test(date) || id === null) return null;
  return {
    date,
    campaign_id: id,
    campaign_name:
      typeof c["name"] === "string" && c["name"].trim() !== ""
        ? c["name"].trim().slice(0, 200)
        : id,
    // An absent metric is zero on a row Google returned: Google omits default values.
    cost_micros: readInt64(m["costMicros"] ?? 0) ?? 0,
    clicks: readInt64(m["clicks"] ?? 0) ?? 0,
    conversions: readDouble(m["conversions"] ?? 0) ?? 0,
    conversions_value: readDouble(m["conversionsValue"] ?? 0) ?? 0,
  };
}

/** Four decimals, as metric_observations.value_num keeps them. */
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Pure: business-wide figures for every day in [start, end] (zero days
 * included) and per-campaign figures for every campaign day Google
 * reported. Money in minor units of the account currency (rule 1).
 */
export function aggregateGoogleAds(
  rows: readonly GadsCampaignDay[],
  accountCurrency: string,
  start: Date,
  end: Date,
  observedAt: string,
): Observation[] {
  const currency = accountCurrency.toUpperCase();
  const from = dayString(start);
  const to = dayString(end);
  const spend = new Map<string, number>();
  const clicks = new Map<string, number>();
  const conversions = new Map<string, number>();
  const out: Observation[] = [];
  for (const r of rows) {
    if (r.date < from || r.date > to) continue;
    // Summed in micros first: one rounding per day, not one per campaign.
    spend.set(r.date, (spend.get(r.date) ?? 0) + r.cost_micros);
    clicks.set(r.date, (clicks.get(r.date) ?? 0) + r.clicks);
    conversions.set(r.date, (conversions.get(r.date) ?? 0) + r.conversions);
    const dimensions = { currency, campaign_ref: r.campaign_id, campaign_name: r.campaign_name };
    out.push(
      {
        metric_key: "ad_spend.campaign.daily",
        period_date: r.date,
        dimensions,
        value_minor: microsToMinor(r.cost_micros, currency),
        observed_at: observedAt,
      },
      {
        metric_key: "ad_purchase_value.campaign.daily",
        period_date: r.date,
        dimensions,
        value_minor: amountToMinor(r.conversions_value, currency),
        observed_at: observedAt,
      },
      {
        metric_key: "ad_clicks.campaign.daily",
        period_date: r.date,
        dimensions: { campaign_ref: r.campaign_id, campaign_name: r.campaign_name },
        value_num: r.clicks,
        observed_at: observedAt,
      },
      {
        metric_key: "ad_conversions.campaign.daily",
        period_date: r.date,
        dimensions: { campaign_ref: r.campaign_id, campaign_name: r.campaign_name },
        value_num: round4(r.conversions),
        observed_at: observedAt,
      },
    );
  }
  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    const day = dayString(d);
    out.push(
      {
        metric_key: "ad_spend.daily",
        period_date: day,
        dimensions: { currency },
        value_minor: microsToMinor(spend.get(day) ?? 0, currency),
        observed_at: observedAt,
      },
      {
        metric_key: "ad_clicks.daily",
        period_date: day,
        dimensions: {},
        value_num: clicks.get(day) ?? 0,
        observed_at: observedAt,
      },
      {
        metric_key: "ad_conversions.daily",
        period_date: day,
        dimensions: {},
        value_num: round4(conversions.get(day) ?? 0),
        observed_at: observedAt,
      },
    );
  }
  return out;
}

/** What the sync runner pulls from (lib/connectors/execute-reads.ts). */
export interface GoogleAdsReadSource {
  id: "google_ads";
  label: string;
  pull(secret: string, cursor: string | null, now: Date): Promise<PullPage>;
}

export interface GoogleAdsReadOptions {
  fetch?: FetchLike;
  env?: () => GoogleAdsEnv | null;
}

export function createGoogleAdsReadSource(opts: GoogleAdsReadOptions = {}): GoogleAdsReadSource {
  const envOf = opts.env ?? googleAdsEnv;
  return {
    id: "google_ads",
    label: "Google Ads",
    async pull(secret, cursor, now) {
      const env = envOf();
      if (env === null) throw new ProviderError("google ads: not set up on SYB yet");
      const s = readGoogleAdsSecret(secret);
      const plan = planWindow({
        cursor,
        now,
        historyDays: GADS_HISTORY_DAYS,
        rereadDays: GADS_REREAD_DAYS,
        windowDays: GADS_WINDOW_DAYS,
        provider: "google ads",
      });
      if (plan === null) return { observations: [], cursor, done: true };
      const tokens = await refreshAccess(env, s.refresh_token, opts.fetch);
      const headers = {
        developer_token: env.developer_token,
        login_customer_id: env.login_customer_id,
      };
      const customer = await readCustomer(
        { accessToken: tokens.access_token, env: headers, customerId: s.customer_id },
        opts.fetch,
      );
      if (customer.currency !== s.currency) {
        throw new ProviderError(
          `google ads: the account now reports ${customer.currency}, not the ${s.currency} it was connected in`,
        );
      }
      const raw = await searchAll(
        {
          accessToken: tokens.access_token,
          env: headers,
          customerId: s.customer_id,
          query: campaignDayQuery(dayString(plan.start), dayString(plan.end)),
        },
        opts.fetch,
      );
      const rows = raw.map(readCampaignDay).filter((r): r is GadsCampaignDay => r !== null);
      return {
        observations: aggregateGoogleAds(
          rows,
          customer.currency,
          plan.start,
          plan.end,
          now.toISOString(),
        ),
        cursor: advanceCursor(cursor, plan.end),
        done: plan.end.getTime() === plan.yesterday.getTime(),
      };
    },
  };
}

export const googleAdsReadSource = createGoogleAdsReadSource();
