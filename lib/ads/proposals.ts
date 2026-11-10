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
//
// P3-22, Google half (owner, 2026-11-08: "build google ads too"): Google Ads
// campaigns, measured through the google_ads execute connection's read
// (lib/google-ads/read.ts), go through the same thresholds, the same
// guardrails and the same gates. Their value is Google's conversion value,
// attributed by Google's own rules, and the proposal says so. A Google
// campaign's proposal carries `platform: "google"`, which routes it to the
// Google Ads executor (lib/ads/executing, adsPlan); its dedupe ref is
// ads:google:<id>:… so it can never fold into a Meta campaign's.
//
// TikTok (2026-11-08, the owner: all remaining features "should be done by
// today"): TikTok campaigns are read through the tiktok_ads consent
// (lib/tiktok/read.ts) into the same series and get the same two proposals
// under the same thresholds and guardrails, tagged `platform: "tiktok"`
// (dedupe ref ads:tiktok:<id>:…), routed to the tiktok_ads executor. The
// ceiling's account-wide day counts every platform's campaigns together.

import { and, eq, gte, inArray, lte, or } from "drizzle-orm";
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
import { format, money, perUnit, scaleMinor, scaleMinorBy } from "../core/money";
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
import type { ScenarioBlock } from "../diagnosis/recommendations";
import type { SimulationAttachment } from "../simulate/scenario";
import { attachSimulation } from "../simulate/scenario";
import { watchingUntil } from "../care/watch-words";

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

/** Which ad platform a campaign runs on — and whose attribution its value is. */
export type AdPlatform = "meta" | "google" | "tiktok";

/** P3-22, Google half: the platform's name, and what its attributed value is called. */
export const PLATFORM_WORDS: Readonly<
  Record<AdPlatform, { name: string; value: string; attribution: string }>
> = {
  meta: {
    name: "Meta",
    value: "purchases Meta attributes",
    attribution: "Purchases are the ones Meta attributes to the campaign, by Meta's own rules.",
  },
  google: {
    name: "Google",
    value: "conversion value Google attributes",
    attribution:
      "Conversion value is what Google attributes to the campaign, by Google's own conversion rules.",
  },
  tiktok: {
    name: "TikTok",
    value: "purchases TikTok attributes",
    attribution: "Purchases are the ones TikTok attributes to the campaign, by TikTok's own rules.",
  },
};

/** A series' platform: Meta when absent (series built before Google and TikTok). */
export function platformOfSeries(series: Pick<CampaignSeries, "platform">): AdPlatform {
  return series.platform ?? "meta";
}

export interface CampaignSeries {
  /** Absent on series built before Google Ads: Meta. */
  platform?: AdPlatform;
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
  | {
      change: "raise_budget" | "lower_budget";
      /** Positive: the size of the move, whichever way it goes. */
      share: number;
      window: CampaignWindow;
      window_days: number;
    };

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
    proposed_daily_minor: args.daily_spend_minor + scaleMinor(args.daily_spend_minor, args.share),
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
  // Each campaign's mean is taken exactly in integers, then summed (hard rule 1).
  return campaigns
    .filter((c) => c.currency.toUpperCase() === currency.toUpperCase())
    .reduce((sum, c) => {
      const w = windowOf(c, shiftDay(today, -ADS.raise_window_days), shiftDay(today, -1));
      return sum + (w.measured_days > 0 ? perUnit(w.spend_minor, w.measured_days) : 0);
    }, 0);
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

/**
 * The per-campaign series an account measures: from its Meta measure
 * connection(s) and, since P3-22's Google half, its Google Ads execute
 * connection(s), whose read writes the same per-campaign metrics.
 */
export async function loadCampaignSeries(
  accountId: string,
  from: string,
  to: string,
): Promise<CampaignSeries[]> {
  const conns = await db
    .select({ id: connections.id, provider: connections.provider })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        or(
          and(eq(connections.provider, "meta_ads"), eq(connections.purpose, "measure")),
          and(eq(connections.provider, "google_ads"), eq(connections.purpose, "execute")),
          // TikTok can't separate reading from acting: its read rides on the execute consent.
          and(eq(connections.provider, "tiktok_ads"), eq(connections.purpose, "execute")),
        ),
      ),
    );
  if (conns.length === 0) return [];
  const platformOf = new Map<string, AdPlatform>(
    conns.map((c) => [
      c.id,
      c.provider === "google_ads" ? "google" : c.provider === "tiktok_ads" ? "tiktok" : "meta",
    ]),
  );
  const rows = await db
    .select({
      connection_id: metricObservations.connection_id,
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
    const platform = platformOf.get(r.connection_id) ?? "meta";
    const key = `${platform}:${ref}`;
    const series = byCampaign.get(key) ?? {
      platform,
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
    byCampaign.set(key, series);
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

/** What every ad proposal for one profile is checked against, read once per run. */
interface AdContext {
  profileId: string;
  now: Date;
  today: string;
  month: string;
  campaigns: CampaignSeries[];
  ceiling: Awaited<ReturnType<typeof monthlyAdCeiling>>;
  existing: Set<string | null>;
  suppressed: Awaited<ReturnType<typeof suppressedKinds>>;
  limits: () => Promise<Awaited<ReturnType<typeof ensureHardLimits>>["limits"]>;
}

/** The care check (rule 15) and everything a run reads; `skip` says why nothing is proposed. */
async function adContext(
  profileId: string,
  now: Date,
  limitLlm: LimitLlm | undefined,
): Promise<AdContext | { skip: string }> {
  const care = await careState(profileId);
  if (!care) return { skip: "not in care yet — no mode decision" };
  if (care.watch_ends_at && now.toISOString() < care.watch_ends_at) {
    return {
      skip: watchingUntil(care.watch_ends_at),
    };
  }
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) return { skip: "no such business" };

  const today = now.toISOString().slice(0, 10);
  const from = shiftDay(today, -(Math.max(ADS.pause_window_days, ADS.raise_window_days) + 1));
  const campaigns = await loadCampaignSeries(profile.account_id, from, shiftDay(today, -1));
  if (campaigns.length === 0) return { skip: "no campaign is measured yet" };

  const existing = new Set(
    (
      await db
        .select({ ref: proposals.originating_finding })
        .from(proposals)
        .where(and(eq(proposals.profile_id, profileId), eq(proposals.module, ADS_MODULE)))
    ).map((r) => r.ref),
  );
  let limits: Awaited<ReturnType<typeof ensureHardLimits>>["limits"] | null = null;
  return {
    profileId,
    now,
    today,
    month: today.slice(0, 7),
    campaigns,
    ceiling: await monthlyAdCeiling(profileId),
    existing,
    suppressed: await suppressedKinds(profileId),
    limits: async () =>
      (limits ??= (await ensureHardLimits(profileId, limitLlm ?? liveLimitLlm)).limits),
  };
}

/**
 * One ad change through every gate — dedupe, suppression (P3-28), the
 * spend guard (P3-22c), the hard limits (rule 14) — recorded as a pending
 * (or born-blocked) proposal. Nothing is executed: approving it is the
 * owner's, and the runner builds the op from the row (P3-22b).
 */
async function recordAdChange(
  ctx: AdContext,
  c: CampaignSeries,
  change: AdChange,
  simulation?: SimulationAttachment,
): Promise<{ created: ProposalRow } | { skipped: { ref: string; reason: string } }> {
  const kind =
    change.change === "raise_budget" ? "paid_ads_start_or_increase" : "paid_ads_decrease_or_pause";
  const platform: AdPlatform = c.platform ?? "meta";
  const pw = PLATFORM_WORDS[platform];
  const ref = `ads:${platform === "meta" ? "" : `${platform}:`}${c.campaign_ref}:${change.change}:${ctx.month}`;
  if (ctx.existing.has(ref)) return { skipped: { ref, reason: "already proposed this month" } };
  const silenced = ctx.suppressed.get(kind);
  if (silenced) {
    return {
      skipped: {
        ref,
        reason: `you've declined this kind of ad change ${silenced.rejections} times — I've stopped proposing it`,
      },
    };
  }
  const w = change.window;
  const fmt = (m: number) => format(money(m, c.currency));
  const dailySpend = perUnit(w.spend_minor, Math.max(1, w.measured_days));
  const ceiling = ctx.ceiling;
  if (change.change !== "pause") {
    if (
      change.change === "raise_budget" &&
      ceiling &&
      ceiling.currency.toUpperCase() !== c.currency.toUpperCase()
    ) {
      return {
        skipped: {
          ref,
          reason: `your ad ceiling is in ${ceiling.currency} and this campaign spends in ${c.currency} — I won't convert to compare them`,
        },
      };
    }
    const refused = budgetGuard({
      share: change.change === "raise_budget" ? change.share : -change.share,
      daily_spend_minor: dailySpend,
      account_daily_spend_minor: accountDailySpend(ctx.campaigns, ctx.today, c.currency),
      currency: c.currency,
      monthly_ceiling_minor: ceiling?.amount_minor ?? null,
    });
    if (refused) return { skipped: { ref, reason: refused } };
  }
  const verdict = checkHardLimits(await ctx.limits(), kind);

  const arithmetic = `${fmt(w.spend_minor)} spent, ${fmt(w.value_minor)} in ${pw.value}, over ${w.measured_days} measured days: return on ad spend ${roasWord(w.roas)}`;
  const monthlyLoss =
    w.measured_days > 0 ? scaleMinorBy(w.spend_minor - w.value_minor, 30, w.measured_days) : 0;
  const sharePct = change.change === "pause" ? 0 : Math.round(change.share * 100);
  const deltaDaily = change.change === "pause" ? 0 : scaleMinor(dailySpend, change.share);
  // × ROAS is × value ÷ spend, taken exactly as that ratio of integers.
  const attributed = fmt(
    w.spend_minor > 0 ? scaleMinorBy(deltaDaily * 30, w.value_minor, w.spend_minor) : 0,
  );
  const scenario: ScenarioBlock = {
    assumptions: [
      {
        statement: arithmetic,
        value: null,
        source_field: null,
        sensitivity: "medium",
      },
      {
        statement:
          platform === "google"
            ? "Google's attribution is its own — some of these conversions might have happened anyway"
            : `${pw.name}'s attribution is its own — some of these purchases might have happened anyway`,
        value: null,
        source_field: null,
        sensitivity: "high",
      },
    ],
    base_case: {
      case: "base",
      statement:
        change.change === "pause"
          ? `About ${fmt(Math.max(0, monthlyLoss))} a month stops going out beyond what ${pw.name} says comes back.`
          : change.change === "raise_budget"
            ? `About ${fmt(deltaDaily * 30)} more a month in spend, with about ${attributed} in attributed purchases at the same return.`
            : `About ${fmt(deltaDaily * 30)} less a month in spend, and about ${attributed} less in attributed purchases at the same return.`,
      profit_delta_monthly: null,
      formula:
        change.change === "pause"
          ? `(${fmt(w.spend_minor)} − ${fmt(w.value_minor)}) ÷ ${w.measured_days} days × 30`
          : `${fmt(dailySpend)} a day × ${sharePct}% × 30 × ROAS ${roasWord(w.roas)}`,
    },
    downside_case: {
      case: "downside",
      statement:
        change.change === "pause"
          ? "Some sales the campaign did drive stop — resuming it restores it."
          : change.change === "raise_budget"
            ? "The extra spend returns less than the campaign's average — restoring the budget undoes it."
            : "The spend you cut was earning more than the average — restoring the budget undoes it.",
      profit_delta_monthly: null,
      formula: null,
    },
    upside_case: {
      case: "upside",
      statement:
        change.change === "pause"
          ? "The budget goes to a campaign that pays for itself."
          : change.change === "raise_budget"
            ? "The return holds at the higher budget."
            : "The return holds on what's left.",
      profit_delta_monthly: null,
      formula: null,
    },
    breakeven_condition:
      change.change === "pause"
        ? "a return on ad spend of 1.0 — the campaign paying for itself"
        : change.change === "raise_budget"
          ? "the extra spend returning at least what it costs"
          : "the spend you cut returning less than it cost",
  };
  const row = await createProposal({
    profile_id: ctx.profileId,
    module: ADS_MODULE,
    originating_finding: ref,
    action: {
      kind,
      summary:
        change.change === "pause"
          ? w.roas !== null && w.roas < ADS.pause_roas_below
            ? `Pause "${c.campaign_name}" — it spent more than ${pw.name} says it brought back over ${w.measured_days} days`
            : `Pause "${c.campaign_name}" — return on ad spend ${roasWord(w.roas)} over ${w.measured_days} days`
          : change.change === "raise_budget"
            ? `Raise "${c.campaign_name}"'s daily budget by ${sharePct}% — return on ad spend ${roasWord(w.roas)} over ${w.measured_days} days`
            : `Cut "${c.campaign_name}"'s daily budget by ${sharePct}% — return on ad spend ${roasWord(w.roas)} over ${w.measured_days} days`,
      detail: {
        campaign_ref: c.campaign_ref,
        campaign_name: c.campaign_name,
        change: change.change,
        // P3-22b: a cut carries a negative share; adsPlan refuses one in the wrong direction.
        ...(change.change === "raise_budget"
          ? { share: change.share }
          : change.change === "lower_budget"
            ? { share: -change.share }
            : {}),
        window_days: change.window_days,
        measured_days: w.measured_days,
        spend_minor: w.spend_minor,
        value_minor: w.value_minor,
        currency: c.currency,
        roas: w.roas,
        arithmetic,
        ...(platform === "meta" ? {} : { platform }),
        attribution: pw.attribution,
        // P3-22b: approving queues it for the next due run (no set time needed).
        execute_on_approval: true,
        sending:
          platform === "tiktok"
            ? "Approved, it goes to TikTok on the next scheduled run: the campaign is read again first, then the change is made, re-checked against your limits. TikTok ad changes stay switched off until the two-week unattended test completes; until then it waits, approved."
            : platform === "google"
              ? "Approved, it goes to Google Ads on the next scheduled run: a dry run first, then the change, re-checked against your limits. Google Ads changes stay switched off until the two-week unattended test completes; until then it waits, approved."
              : "Approved, it goes to Meta on the next scheduled run: a dry run first, then the change, re-checked against your limits. Meta ad changes stay switched off until the two-week unattended test completes; until then it waits, approved.",
        manual_limits: verdict.manual.map((l) => l.quote),
        ...(simulation ? { requested_from: "simulator" } : {}),
      },
    },
    scenario: attachSimulation(scenario, simulation) as never,
    reversibility: {
      level: "easy",
      if_you_change_your_mind:
        change.change === "pause"
          ? "Resume the campaign — it picks up where it stopped."
          : "Restore the previous daily budget.",
    },
    expires_at: new Date(ctx.now.getTime() + ADS.expiry_days * 86_400_000).toISOString(),
    blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
  });
  ctx.existing.add(ref);
  return { created: row };
}

/** Propose pauses and raises for one profile from its measured campaigns. */
export async function proposeAdChanges(
  profileId: string,
  opts: { now?: Date; limitLlm?: LimitLlm } = {},
): Promise<AdRun> {
  const now = opts.now ?? new Date();
  const out: AdRun = { created: [], skipped: [] };
  const ctx = await adContext(profileId, now, opts.limitLlm);
  if ("skip" in ctx) {
    out.skipped.push({ ref: "profile", reason: ctx.skip });
    return out;
  }
  for (const c of ctx.campaigns) {
    const change = adChangeFor(c, ctx.today);
    if (!change) {
      out.skipped.push({ ref: c.campaign_ref, reason: "nothing the measured days call for" });
      continue;
    }
    const result = await recordAdChange(ctx, c, change);
    if ("created" in result) out.created.push(result.created);
    else out.skipped.push(result.skipped);
  }
  return out;
}

/**
 * Feature 36: the change the owner asked for from the campaign simulator,
 * through the same gates as the generator's own — the watch, dedupe,
 * suppression, the spend guard and the hard limits — with the simulated
 * scenario attached. The generator's thresholds (pause below 1.0, raise at
 * 3.0) say what I'd suggest unprompted; an owner's own ask still needs the
 * 14 measured days every ad proposal needs. Nothing executes (rule 12).
 */
export async function proposeRequestedAdChange(
  profileId: string,
  args: {
    campaign_ref: string;
    /** Which platform's campaign; Meta when absent (the simulator's own). */
    platform?: AdPlatform;
    change: "pause" | "raise_budget" | "lower_budget";
    /** Positive, for a raise or a cut. */
    share?: number;
    now?: Date;
    limitLlm?: LimitLlm;
    simulation?: SimulationAttachment;
  },
): Promise<AdRun> {
  const now = args.now ?? new Date();
  const out: AdRun = { created: [], skipped: [] };
  const ctx = await adContext(profileId, now, args.limitLlm);
  if ("skip" in ctx) {
    out.skipped.push({ ref: "profile", reason: ctx.skip });
    return out;
  }
  const c = ctx.campaigns.find(
    (s) =>
      s.campaign_ref === args.campaign_ref && (s.platform ?? "meta") === (args.platform ?? "meta"),
  );
  if (!c) {
    out.skipped.push({ ref: args.campaign_ref, reason: "that campaign isn't measured" });
    return out;
  }
  const end = shiftDay(ctx.today, -1);
  const windowDays = args.change === "pause" ? ADS.pause_window_days : ADS.raise_window_days;
  const w = windowOf(c, shiftDay(end, -(windowDays - 1)), end);
  if (w.measured_days < ADS.min_measured_days) {
    out.skipped.push({
      ref: args.campaign_ref,
      reason: `${w.measured_days} measured days — an ad proposal needs ${ADS.min_measured_days}`,
    });
    return out;
  }
  let change: AdChange;
  if (args.change === "pause") {
    change = { change: "pause", window: w, window_days: windowDays };
  } else {
    const share = args.share ?? NaN;
    if (!(share > 0 && share <= ADS.max_change_share + 1e-9)) {
      out.skipped.push({
        ref: args.campaign_ref,
        reason: `a change of ${Number.isFinite(share) ? Math.round(share * 100) : "?"}% is outside the ${ADS.max_change_share * 100}% allowed in one approval`,
      });
      return out;
    }
    change = { change: args.change, share, window: w, window_days: windowDays };
  }
  const result = await recordAdChange(ctx, c, change, args.simulation);
  if ("created" in result) out.created.push(result.created);
  else out.skipped.push(result.skipped);
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
