// Per-campaign readback — P3-23b (Session D, layer D4).
//
// An ad change is judged on THAT campaign's return on ad spend — the
// purchase value Meta attributes divided by spend — before the change
// against after it, not on the business's revenue. The series is the one
// P3-22a's read already measures through the measure connection's ads_read
// scope (ad_spend.campaign.daily, ad_purchase_value.campaign.daily, keyed
// by campaign_ref); nothing is read twice and no write scope reads anything.
//
//   before   the 28 days before the change, on the days the campaign spent
//   after    up to 28 days after, on the days the account's sync covered
//            (an account-level ad_spend.daily row exists) — a covered day
//            with no campaign row is a day the campaign spent nothing
//
// A campaign that spent nothing after the change — a pause that held — has
// no after-ROAS. Its return then moved from (ROAS − 1) × spend a day to
// zero, so the change is 1 − ROAS before, relative to the spend it stopped:
// pausing a campaign at ROAS 0.60 is +40%, at ROAS 1.20 it is −20%. Every
// other case compares ROAS after with ROAS before, relatively. Thresholds
// pinned in AD_READBACK, boundary-tested both ways; Meta's attribution is
// Meta's own, and the arithmetic says so.
//
// Review 2026-11-08: a Google Ads or TikTok Ads change is judged the same
// way on ITS platform's series — the execute connection whose daily read is
// measurement (lib/connectors/execute-reads.ts) — never looked up in Meta's
// data, where its id is either absent or another platform's campaign.

import { and, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { connections, metricObservations } from "../../db/schema";
import { format, money } from "../core/money";
import { shiftDay } from "./series";

export const AD_READBACK = {
  before_days: 28,
  after_days: 28,
  /** Fewer covered days after the change than this: too_early (Meta's attribution lags). */
  min_after_days: 7,
  /** Relative change at or above this: helped. */
  helped_at: 0.05,
  /** Relative change at or below this: backfired. */
  backfired_at: -0.05,
} as const;

export type CampaignVerdict = "helped" | "did_nothing" | "backfired" | "too_early" | "unmeasured";

/** Whose campaign it is; Meta when a proposal names none. */
export type AdPlatform = "meta" | "google" | "tiktok";

const PLATFORM: Readonly<
  Record<AdPlatform, { provider: string; purpose: "measure" | "execute"; label: string }>
> = {
  meta: { provider: "meta_ads", purpose: "measure", label: "Meta" },
  google: { provider: "google_ads", purpose: "execute", label: "Google" },
  tiktok: { provider: "tiktok_ads", purpose: "execute", label: "TikTok" },
};

/** Pure: a proposal detail's platform, Meta when absent or unknown. */
export function adPlatformOf(v: unknown): AdPlatform {
  return v === "google" || v === "tiktok" ? v : "meta";
}

export interface CampaignWindow {
  from: string;
  to: string;
  /** Days the campaign spent (before) or the account was covered (after). */
  days: number;
  spend_minor: number;
  value_minor: number;
  roas: number | null;
}

export interface CampaignOutcome {
  verdict: CampaignVerdict;
  currency: string | null;
  before: CampaignWindow | null;
  after: CampaignWindow | null;
  delta_pct: number | null;
  arithmetic: string;
}

interface Day {
  spend_minor: number;
  value_minor: number;
}

/** Pure: the verdict from the two windows. */
export function judgeCampaign(args: {
  name: string;
  currency: string;
  changed_on: string;
  before: CampaignWindow;
  after: CampaignWindow;
  /** Whose attribution the value is (default Meta). */
  platform?: AdPlatform;
}): CampaignOutcome {
  const who = PLATFORM[args.platform ?? "meta"].label;
  const fmt = (minor: number) => format(money(minor, args.currency));
  const roasWord = (r: number | null) => (r === null ? "—" : r.toFixed(2));
  const base = { currency: args.currency, before: args.before, after: args.after };
  const { before, after } = args;
  if (before.spend_minor === 0 || before.roas === null) {
    return {
      ...base,
      verdict: "unmeasured",
      delta_pct: null,
      arithmetic: `"${args.name}" spent nothing in the ${AD_READBACK.before_days} days before ${args.changed_on} — no return to compare against`,
    };
  }
  if (after.days < AD_READBACK.min_after_days) {
    return {
      ...base,
      verdict: "too_early",
      delta_pct: null,
      arithmetic: `${after.days} measured day(s) since ${args.changed_on} — the verdict needs ${AD_READBACK.min_after_days}`,
    };
  }
  const beforeLine =
    `"${args.name}" returned ${roasWord(before.roas)} on ad spend over the ${before.days} day(s) it spent ` +
    `before ${args.changed_on} (${fmt(before.spend_minor)} spent, ${fmt(before.value_minor)} ${who} attributes)`;
  let delta: number;
  let afterLine: string;
  // Integer cross-products, one division: a boundary like +5% lands exactly.
  if (after.spend_minor === 0) {
    delta = (before.spend_minor - before.value_minor) / before.spend_minor;
    afterLine =
      `after, it spent nothing on ${after.days} measured day(s), so a return of ` +
      `${roasWord(before.roas)} against the 1.00 break-even stopped`;
  } else {
    const cross = after.value_minor * before.spend_minor;
    const prior = before.value_minor * after.spend_minor;
    delta = prior === 0 ? (cross > 0 ? Infinity : 0) : (cross - prior) / prior;
    afterLine =
      `after, ${roasWord(after.roas)} over ${after.days} measured day(s) ` +
      `(${fmt(after.spend_minor)} spent, ${fmt(after.value_minor)} ${who} attributes)`;
  }
  const verdict: CampaignVerdict =
    delta >= AD_READBACK.helped_at
      ? "helped"
      : delta <= AD_READBACK.backfired_at
        ? "backfired"
        : "did_nothing";
  const delta_pct = Number.isFinite(delta) ? Math.round(delta * 1000) / 10 : null;
  return {
    ...base,
    verdict,
    delta_pct,
    arithmetic:
      `${beforeLine}; ${afterLine} — ${delta_pct === null ? "up from none" : `${delta_pct >= 0 ? "+" : ""}${delta_pct}%`}` +
      ` (thresholds: helped at +${AD_READBACK.helped_at * 100}%, backfired at ${AD_READBACK.backfired_at * 100}%; attribution is ${who}'s own)`,
  };
}

/** Judge an ad change on its campaign's own ROAS, from its platform's read connection(s). */
export async function campaignOutcome(args: {
  accountId: string;
  campaignRef: string;
  campaignName: string;
  changedOn: string;
  now: Date;
  /** Whose campaign it is (the proposal's detail.platform); Meta when absent. */
  platform?: AdPlatform;
}): Promise<CampaignOutcome> {
  const empty = { currency: null, before: null, after: null, delta_pct: null };
  const platform = args.platform ?? "meta";
  const source = PLATFORM[platform];
  const where: SQL[] = [
    eq(connections.account_id, args.accountId),
    eq(connections.provider, source.provider),
    eq(connections.purpose, source.purpose),
  ];
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(...where));
  if (conns.length === 0) {
    return {
      ...empty,
      verdict: "unmeasured",
      arithmetic: `no ${source.label} ads read connection — connect it and the verdict becomes possible`,
    };
  }
  const from = shiftDay(args.changedOn, -AD_READBACK.before_days);
  const today = args.now.toISOString().slice(0, 10);
  const capped = shiftDay(args.changedOn, AD_READBACK.after_days);
  // Today is partial: the after-window ends yesterday at the latest.
  const afterTo = capped < today ? capped : shiftDay(today, -1);
  const rows = await db
    .select({
      metric_key: metricObservations.metric_key,
      dimensions: metricObservations.dimensions,
      period_date: metricObservations.period_date,
      value_minor: metricObservations.value_minor,
      currency: metricObservations.currency,
    })
    .from(metricObservations)
    .where(
      and(
        inArray(
          metricObservations.connection_id,
          conns.map((c) => c.id),
        ),
        inArray(metricObservations.metric_key, [
          "ad_spend.daily",
          "ad_spend.campaign.daily",
          "ad_purchase_value.campaign.daily",
        ]),
        gte(metricObservations.period_date, from),
        lte(metricObservations.period_date, afterTo),
      ),
    );

  const covered = new Set<string>();
  const days = new Map<string, Day>();
  let currency: string | null = null;
  for (const r of rows) {
    if (r.metric_key === "ad_spend.daily") {
      // Business-wide rows only say the day was synced.
      if (Object.keys(r.dimensions ?? {}).every((k) => k === "currency"))
        covered.add(r.period_date);
      continue;
    }
    if (r.dimensions?.campaign_ref !== args.campaignRef || r.value_minor === null || !r.currency) {
      continue;
    }
    currency ??= r.currency;
    if (r.currency !== currency) continue; // one currency per series (rule 1)
    const d = days.get(r.period_date) ?? { spend_minor: 0, value_minor: 0 };
    if (r.metric_key === "ad_spend.campaign.daily") d.spend_minor = r.value_minor;
    else d.value_minor = r.value_minor;
    days.set(r.period_date, d);
  }
  if (currency === null) {
    return {
      ...empty,
      verdict: "unmeasured",
      arithmetic: `no measured days for "${args.campaignName}" — nothing to compare`,
    };
  }

  const window = (lo: string, hi: string, onCovered: boolean): CampaignWindow => {
    let n = 0;
    let spend = 0;
    let value = 0;
    for (let day = lo; day <= hi; day = shiftDay(day, 1)) {
      const d = days.get(day);
      const counts = onCovered ? covered.has(day) || d !== undefined : (d?.spend_minor ?? 0) > 0;
      if (!counts) continue;
      n += 1;
      spend += d?.spend_minor ?? 0;
      value += d?.value_minor ?? 0;
    }
    return {
      from: lo,
      to: hi,
      days: n,
      spend_minor: spend,
      value_minor: value,
      roas: spend > 0 ? value / spend : null,
    };
  };
  return judgeCampaign({
    name: args.campaignName,
    currency,
    changed_on: args.changedOn,
    before: window(from, shiftDay(args.changedOn, -1), false),
    after: window(shiftDay(args.changedOn, 1), afterTo, true),
    platform,
  });
}
