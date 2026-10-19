// Ad proposals from measured facts only — P3-22a, with P3-22c's guardrails
// at generation (Session D, layer D3).
//
// Two deterministic sources over the per-campaign series the Meta read
// connector measures (ad_spend.campaign.daily, ad_purchase_value.campaign
// .daily). No model anywhere near it (CLAUDE.md cost rule):
//
//   pause   return on ad spend below 1.0 over the last 14 measured days —
//           the campaign spends more than Meta says it brings back
//   raise   return on ad spend at or above 3.0 over the last 28 days, with
//           at least 14 of them measured — a 20% daily-budget increase
//
// Every proposal carries its arithmetic (spend, attributed value, ROAS,
// days) in minor units with the currency (rule 1), runs the hard limits
// (no_paid_ads blocks any increase), suppression (P3-28) and the watch
// (rule 15: nothing is proposed while a business is being watched), and
// is deduped per campaign, per change, per month.
//
// Guardrails at generation (P3-22c): a change is bounded to ±50% of the
// current budget; the plan's +20% sits inside it, and anything outside is
// refused by name. The owner's stated monthly ad ceiling (question 8.1i,
// marketing.monthly_ad_ceiling) applies to the whole account: a raise that
// would take total monthly ad spend past it is refused, naming both
// figures; a ceiling in another currency than the campaign's can't be
// compared without converting, so the raise is refused rather than guessed
// (rule 1). The arithmetic is lib/ads/guard's spendGuard, which the
// executor runs again before anything is sent, with Meta's minimum daily
// budget and the currency-offset table beside it (P3-22b/c).
//
// Execution (P3-22b): no action.detail.execution is bound. The proposal
// says `execute_on_approval`, so approving schedules it for the next due
// run, and the runner builds the plan from this row (lib/ads/executing,
// adsPlan) — the op follows the change, never a caller.
// Attribution is Meta's own: the proposal says so, and calls it ROAS as
// Meta attributes it, not as the business measured it.

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  connections,
  metricObservations,
  modeDecisions,
  proposals,
} from "../../db/schema";
import { careState } from "../care/day-zero";
import { logSafeError } from "../core/log-safe";
import { format, money } from "../core/money";
import type { LimitLlm } from "../proposals/hard-limits";
import {
  checkHardLimits,
  ensureHardLimits,
  limitCaption,
  liveLimitLlm,
} from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal } from "../proposals/service";
import { readCurrentField } from "../profile/field-store";
import { shiftDay } from "../trust/series";
import { MAX_CHANGE_SHARE, spendGuard } from "./guard";
import { suppressedKinds } from "../trust/suppression";

export const ADS_MODULE = "ads";
/** Question 8.1i: the most the owner wants to spend on ads in a month (money). */
export const CEILING_KEY = "marketing.monthly_ad_ceiling";

/** The pinned thresholds. Boundary-tested both ways. */
export const ADS = {
  /** No ad proposal without at least this many measured days of the campaign. */
  min_measured_days: 14,
  pause_window_days: 14,
  /** ROAS strictly below this over the pause window: propose a pause. */
  pause_roas_below: 1.0,
  raise_window_days: 28,
  /** ROAS at or above this over the raise window: propose a raise. */
  raise_roas_at_least: 3.0,
  /** The raise itself, as a share of the current daily budget. */
  raise_share: 0.2,
  /** P3-22c: no single change beyond this share of the current budget (lib/ads/guard). */
  max_change_share: MAX_CHANGE_SHARE,
  expiry_days: 14,
} as const;

export interface CampaignDay {
  date: string;
  spend_minor: number;
  value_minor: number;
}

export interface CampaignSeries {
  campaign_ref: string;
  campaign_name: string;
  currency: string;
  /** Measured days, any order. */
  days: CampaignDay[];
}

export interface CampaignWindow {
  measured_days: number;
  spend_minor: number;
  value_minor: number;
  /** Attributed value ÷ spend; null when nothing was spent. */
  roas: number | null;
}

/** Pure: the campaign's measured days within [from, to], summed. */
export function windowOf(series: CampaignSeries, from: string, to: string): CampaignWindow {
  const days = series.days.filter((d) => d.date >= from && d.date <= to);
  const spend = days.reduce((s, d) => s + d.spend_minor, 0);
  const value = days.reduce((s, d) => s + d.value_minor, 0);
  return {
    measured_days: days.length,
    spend_minor: spend,
    value_minor: value,
    roas: spend > 0 ? value / spend : null,
  };
}

export type AdChange =
  | { change: "pause"; window: CampaignWindow; window_days: number }
  | { change: "raise_budget"; share: number; window: CampaignWindow; window_days: number };

/**
 * Pure: what the measured days say to do with one campaign, if anything.
 * `today` is the run date; windows end yesterday (today is never whole).
 */
export function adChangeFor(series: CampaignSeries, today: string): AdChange | null {
  const end = shiftDay(today, -1);
  const pause = windowOf(series, shiftDay(end, -(ADS.pause_window_days - 1)), end);
  if (
    pause.measured_days >= ADS.min_measured_days &&
    pause.roas !== null &&
    pause.roas < ADS.pause_roas_below
  ) {
    return { change: "pause", window: pause, window_days: ADS.pause_window_days };
  }
  const raise = windowOf(series, shiftDay(end, -(ADS.raise_window_days - 1)), end);
  if (
    raise.measured_days >= ADS.min_measured_days &&
    raise.roas !== null &&
    raise.roas >= ADS.raise_roas_at_least
  ) {
    return {
      change: "raise_budget",
      share: ADS.raise_share,
      window: raise,
      window_days: ADS.raise_window_days,
    };
  }
  return null;
}

/**
 * P3-22c at generation: a budget change outside ±max_change_share, or that
 * would take monthly spend over a stated ceiling, is refused — the reason
 * names the number it hit. Null means it is within bounds. The arithmetic
 * is lib/ads/guard's spendGuard, the same one the executor runs again
 * before anything is sent; here the current figure is the measured average
 * day, since the read side doesn't see the campaign's budget.
 */
export function budgetGuard(args: {
  share: number;
  /** The campaign's average measured daily spend in the window (minor units). */
  daily_spend_minor: number;
  /** The whole account's average daily spend across its campaigns; defaults to this campaign's. */
  account_daily_spend_minor?: number;
  currency: string;
  /** The owner's stated monthly ad ceiling, when one exists (minor units, same currency). */
  monthly_ceiling_minor?: number | null;
}): string | null {
  const ceiling = args.monthly_ceiling_minor ?? null;
  return spendGuard({
    current_daily_minor: args.daily_spend_minor,
    proposed_daily_minor: Math.round(args.daily_spend_minor * (1 + args.share)),
    currency: args.currency,
    ...(args.account_daily_spend_minor !== undefined
      ? { account_daily_minor: args.account_daily_spend_minor }
      : {}),
    monthly_ceiling: ceiling === null ? null : { amount_minor: ceiling, currency: args.currency },
  });
}

/**
 * Pure: the account's average day — every campaign in `currency`, each its
 * measured spend over the raise window ÷ its measured days, summed. The
 * ceiling's left-hand side, here and in the executor (rule 1: one currency).
 */
export function accountDailySpend(
  campaigns: readonly CampaignSeries[],
  today: string,
  currency: string,
): number {
  return Math.round(
    campaigns
      .filter((c) => c.currency.toUpperCase() === currency.toUpperCase())
      .reduce((sum, c) => {
        const w = windowOf(c, shiftDay(today, -ADS.raise_window_days), shiftDay(today, -1));
        return sum + (w.measured_days > 0 ? w.spend_minor / w.measured_days : 0);
      }, 0),
  );
}

/** The owner's stated monthly ad ceiling (8.1i), when answered. */
export async function monthlyAdCeiling(
  profileId: string,
): Promise<{ amount_minor: number; currency: string } | null> {
  const field = await readCurrentField<{ amount_minor: number; currency: string }>(
    profileId,
    CEILING_KEY,
  );
  return field?.status === "answered" && field.value ? field.value : null;
}

/** The per-campaign series an account measures, from its Meta measure connection(s). */
export async function loadCampaignSeries(
  accountId: string,
  from: string,
  to: string,
): Promise<CampaignSeries[]> {
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.provider, "meta_ads"),
        eq(connections.purpose, "measure"),
      ),
    );
  if (conns.length === 0) return [];
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
          "ad_spend.campaign.daily",
          "ad_purchase_value.campaign.daily",
        ]),
        gte(metricObservations.period_date, from),
        lte(metricObservations.period_date, to),
      ),
    );
  const byCampaign = new Map<string, CampaignSeries & { byDate: Map<string, CampaignDay> }>();
  for (const r of rows) {
    const ref = r.dimensions?.campaign_ref;
    if (!ref || r.value_minor === null || !r.currency) continue;
    const series = byCampaign.get(ref) ?? {
      campaign_ref: ref,
      campaign_name: r.dimensions?.campaign_name ?? ref,
      currency: r.currency,
      days: [],
      byDate: new Map<string, CampaignDay>(),
    };
    if (series.currency !== r.currency) continue; // one currency per series (rule 1)
    if (r.dimensions?.campaign_name) series.campaign_name = r.dimensions.campaign_name;
    const day = series.byDate.get(r.period_date) ?? {
      date: r.period_date,
      spend_minor: 0,
      value_minor: 0,
    };
    if (r.metric_key === "ad_spend.campaign.daily") day.spend_minor = r.value_minor;
    else day.value_minor = r.value_minor;
    series.byDate.set(r.period_date, day);
    byCampaign.set(ref, series);
  }
  return [...byCampaign.values()].map(({ byDate, ...s }) => ({
    ...s,
    // A measured day is one with spend: value without spend is a lagging attribution.
    days: [...byDate.values()].filter((d) => d.spend_minor > 0),
  }));
}

const roasWord = (r: number | null) => (r === null ? "—" : r.toFixed(2));

export interface AdRun {
  created: ProposalRow[];
  skipped: { ref: string; reason: string }[];
}

/** Propose pauses and raises for one profile from its measured campaigns. */
export async function proposeAdChanges(
  profileId: string,
  opts: { now?: Date; limitLlm?: LimitLlm } = {},
): Promise<AdRun> {
  const now = opts.now ?? new Date();
  const out: AdRun = { created: [], skipped: [] };
  const care = await careState(profileId);
  if (!care) {
    out.skipped.push({ ref: "profile", reason: "not in care yet — no mode decision" });
    return out;
  }
  if (care.watch_ends_at && now.toISOString() < care.watch_ends_at) {
    out.skipped.push({
      ref: "profile",
      reason: `still watching until ${care.watch_ends_at.slice(0, 10)} — nothing is proposed before then (rule 15)`,
    });
    return out;
  }
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) return out;

  const today = now.toISOString().slice(0, 10);
  const from = shiftDay(today, -(Math.max(ADS.pause_window_days, ADS.raise_window_days) + 1));
  const campaigns = await loadCampaignSeries(profile.account_id, from, shiftDay(today, -1));
  if (campaigns.length === 0) {
    out.skipped.push({ ref: "profile", reason: "no campaign is measured yet" });
    return out;
  }

  const month = today.slice(0, 7);
  const ceiling = await monthlyAdCeiling(profileId);
  const existing = new Set(
    (
      await db
        .select({ ref: proposals.originating_finding })
        .from(proposals)
        .where(and(eq(proposals.profile_id, profileId), eq(proposals.module, ADS_MODULE)))
    ).map((r) => r.ref),
  );
  const suppressed = await suppressedKinds(profileId);
  let limits: Awaited<ReturnType<typeof ensureHardLimits>>["limits"] | null = null;

  for (const c of campaigns) {
    const change = adChangeFor(c, today);
    if (!change) {
      out.skipped.push({ ref: c.campaign_ref, reason: "nothing the measured days call for" });
      continue;
    }
    const kind =
      change.change === "pause" ? "paid_ads_decrease_or_pause" : "paid_ads_start_or_increase";
    const ref = `ads:${c.campaign_ref}:${change.change}:${month}`;
    if (existing.has(ref)) {
      out.skipped.push({ ref, reason: "already proposed this month" });
      continue;
    }
    const silenced = suppressed.get(kind);
    if (silenced) {
      out.skipped.push({
        ref,
        reason: `you've declined this kind of ad change ${silenced.rejections} times — I've stopped proposing it`,
      });
      continue;
    }
    const w = change.window;
    const fmt = (m: number) => format(money(m, c.currency));
    const dailySpend = Math.round(w.spend_minor / Math.max(1, w.measured_days));
    if (change.change === "raise_budget") {
      if (ceiling && ceiling.currency.toUpperCase() !== c.currency.toUpperCase()) {
        out.skipped.push({
          ref,
          reason: `your ad ceiling is in ${ceiling.currency} and this campaign spends in ${c.currency} — I won't convert to compare them`,
        });
        continue;
      }
      const refused = budgetGuard({
        share: change.share,
        daily_spend_minor: dailySpend,
        account_daily_spend_minor: accountDailySpend(campaigns, today, c.currency),
        currency: c.currency,
        monthly_ceiling_minor: ceiling?.amount_minor ?? null,
      });
      if (refused) {
        out.skipped.push({ ref, reason: refused });
        continue;
      }
    }
    limits ??= (await ensureHardLimits(profileId, opts.limitLlm ?? liveLimitLlm)).limits;
    const verdict = checkHardLimits(limits, kind);

    const arithmetic = `${fmt(w.spend_minor)} spent, ${fmt(w.value_minor)} in purchases Meta attributes, over ${w.measured_days} measured days: return on ad spend ${roasWord(w.roas)}`;
    const monthlyLoss = Math.round(((w.spend_minor - w.value_minor) / w.measured_days) * 30);
    const extraDaily = Math.round(dailySpend * ADS.raise_share);
    const row = await createProposal({
      profile_id: profileId,
      module: ADS_MODULE,
      originating_finding: ref,
      action: {
        kind,
        summary:
          change.change === "pause"
            ? `Pause "${c.campaign_name}" — it spent more than Meta says it brought back over ${w.measured_days} days`
            : `Raise "${c.campaign_name}"'s daily budget by ${Math.round(change.share * 100)}% — return on ad spend ${roasWord(w.roas)} over ${w.measured_days} days`,
        detail: {
          campaign_ref: c.campaign_ref,
          campaign_name: c.campaign_name,
          change: change.change,
          ...(change.change === "raise_budget" ? { share: change.share } : {}),
          window_days: change.window_days,
          measured_days: w.measured_days,
          spend_minor: w.spend_minor,
          value_minor: w.value_minor,
          currency: c.currency,
          roas: w.roas,
          arithmetic,
          attribution:
            "Purchases are the ones Meta attributes to the campaign, by Meta's own rules.",
          // P3-22b: approving queues it for the next due run (no set time needed).
          execute_on_approval: true,
          sending:
            "Approved, it goes to Meta on the next scheduled run: a dry run first, then the change, re-checked against your limits. Meta ad changes stay switched off until the two-week unattended test completes; until then it waits, approved.",
          manual_limits: verdict.manual.map((l) => l.quote),
        },
      },
      scenario: {
        assumptions: [
          {
            statement: arithmetic,
            value: null,
            source_field: null,
            sensitivity: "medium",
          },
          {
            statement:
              "Meta's attribution is its own — some of these purchases might have happened anyway",
            value: null,
            source_field: null,
            sensitivity: "high",
          },
        ],
        base_case: {
          case: "base",
          statement:
            change.change === "pause"
              ? `About ${fmt(Math.max(0, monthlyLoss))} a month stops going out beyond what Meta says comes back.`
              : `About ${fmt(extraDaily * 30)} more a month in spend, with about ${fmt(Math.round(extraDaily * 30 * (w.roas ?? 0)))} in attributed purchases at the same return.`,
          profit_delta_monthly: null,
          formula:
            change.change === "pause"
              ? `(${fmt(w.spend_minor)} − ${fmt(w.value_minor)}) ÷ ${w.measured_days} days × 30`
              : `${fmt(dailySpend)} a day × ${Math.round(ADS.raise_share * 100)}% × 30 × ROAS ${roasWord(w.roas)}`,
        },
        downside_case: {
          case: "downside",
          statement:
            change.change === "pause"
              ? "Some sales the campaign did drive stop — resuming it restores it."
              : "The extra spend returns less than the campaign's average — restoring the budget undoes it.",
          profit_delta_monthly: null,
          formula: null,
        },
        upside_case: {
          case: "upside",
          statement:
            change.change === "pause"
              ? "The budget goes to a campaign that pays for itself."
              : "The return holds at the higher budget.",
          profit_delta_monthly: null,
          formula: null,
        },
        breakeven_condition:
          change.change === "pause"
            ? "a return on ad spend of 1.0 — the campaign paying for itself"
            : "the extra spend returning at least what it costs",
      } as never,
      reversibility: {
        level: "easy",
        if_you_change_your_mind:
          change.change === "pause"
            ? "Resume the campaign — it picks up where it stopped."
            : "Restore the previous daily budget.",
      },
      expires_at: new Date(now.getTime() + ADS.expiry_days * 86_400_000).toISOString(),
      blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
    });
    out.created.push(row);
  }
  return out;
}

/** The weekly sweep: every business in care, one failure never stopping the rest. */
export async function runAdProposals(
  now: Date = new Date(),
  opts: { limitLlm?: LimitLlm } = {},
): Promise<{ created: number; failed: number }> {
  const inCare = await db
    .selectDistinct({ profile_id: modeDecisions.profile_id })
    .from(modeDecisions);
  let created = 0;
  let failed = 0;
  for (const { profile_id } of inCare) {
    try {
      created += (await proposeAdChanges(profile_id, { now, ...opts })).created.length;
    } catch (error) {
      failed++;
      console.error(
        JSON.stringify({ event: "ad_proposals_failed", profile_id, ...logSafeError(error) }),
      );
    }
  }
  return { created, failed };
}
