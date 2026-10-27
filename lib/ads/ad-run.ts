// "Run this ad" — the pure half (P3-54, Session K): which items can be an ad,
// the pinned numbers, the card's fixed sentences, and the scenario's
// arithmetic from the owner's own measured numbers (lib/simulate's
// conventions). No database, no network: /content and the queue import the
// sentences from here, and lib/ads/adcreate.ts builds the proposal with them.

import { format, money } from "../core/money";
export { AD_RUN_UNDO, CREATES_PAUSED_NOTE, GO_LIVE_UNDO } from "./ad-words";
import type { ScenarioBlock } from "../diagnosis/recommendations";
import { AD_RUN_DAYS, mediaKindOf } from "../execution/providers/meta";
import type { CampaignRaw, MarginRaw, Range } from "../simulate/model";
import {
  SIM,
  campaignWindow,
  marginInput,
  mul,
  roundRange,
  spread,
  valueText,
  weeklyRoas,
} from "../simulate/model";

/** The pinned numbers. */
export const ADCREATE = {
  /** How long an ad runs once it goes live, unless the owner picks another. */
  default_run_days: 7,
  min_run_days: 3,
  max_run_days: AD_RUN_DAYS.max,
  /** The default daily budget: this many times Meta's floor, never past the ceiling's headroom. */
  default_floor_multiple: 5,
  /** An undecided proposal lives this long (= ADS.expiry_days). */
  expiry_days: 14,
  /** A build that has run this long without finishing is reclaimed and resumes on the next run. */
  stale_run_ms: 15 * 60_000,
} as const;

/* ── the item ── */

export interface AdItemLike {
  kind: string;
  status: string;
  media_path: string | null;
}

export type AdReadiness =
  { ok: true; media: { kind: "image" | "video"; url: string } } | { ok: false; reason: string };

/** Pure: can this item be run as an ad, and if not, why not — in the words /content shows. */
export function adReadiness(item: AdItemLike): AdReadiness {
  if (item.kind !== "post" && item.kind !== "video") {
    return { ok: false, reason: `a ${item.kind.replace("_", " ")} isn't something to advertise` };
  }
  if (item.status !== "drafted" && item.status !== "queued") {
    return {
      ok: false,
      reason:
        item.status === "published"
          ? "it's posted, and its media left storage when it went out"
          : `it is ${item.status}`,
    };
  }
  if (item.media_path === null) {
    return { ok: false, reason: "it has no image or video yet — an ad needs one" };
  }
  const kind = mediaKindOf(item.media_path);
  if (kind === null) return { ok: false, reason: "I can't tell what kind of media it carries" };
  if (!/^https:\/\//.test(item.media_path)) {
    return { ok: false, reason: "its media isn't at a public address Meta can fetch" };
  }
  return { ok: true, media: { kind: kind === "video" ? "video" : "image", url: item.media_path } };
}

/* ── the scenario: arithmetic from the owner's own numbers ── */

export interface AdScenarioArgs {
  daily_minor: number;
  run_days: number;
  currency: string;
  campaigns: readonly CampaignRaw[];
  margin: MarginRaw;
  as_of: string;
}

export interface AdScenario {
  scenario: ScenarioBlock;
  spend_minor: number;
  /** Attributed purchases over the run, from the measured weekly return; null when not measured. */
  revenue: Range | null;
  profit: Range | null;
  roas: Range | null;
}

/**
 * Pure: what the ad costs and what it might bring back. Spend is exact at
 * most (budget × days; Meta may spend less). The return is the measured
 * spread (middle half) of the business's own campaigns' rolling-week return
 * on ad spend in this currency, as the simulator's "new campaign" reads it —
 * absent when no campaign has the measured days, never guessed.
 */
export function adScenario(a: AdScenarioArgs): AdScenario {
  const cur = a.currency;
  const m = (v: number) => format(money(v, cur));
  const spend = a.daily_minor * a.run_days;
  const measured = a.campaigns
    .filter((c) => c.currency.toUpperCase() === cur.toUpperCase())
    .filter((c) => campaignWindow(c, a.as_of).measured_days >= SIM.ads_min_measured_days);
  const blocks = measured.flatMap((c) => weeklyRoas(c.days, a.as_of));
  const roas = spread(blocks);
  const margin = marginInput(a.margin);
  const revenue = roas ? roundRange(mul({ low: spend, high: spend }, roas)) : null;
  const profit =
    revenue && margin.range
      ? roundRange({
          low: revenue.low * margin.range.low - spend,
          high: revenue.high * margin.range.high - spend,
        })
      : null;
  const worstRoas = blocks.length > 0 ? Math.min(...blocks) : null;
  const worst =
    worstRoas !== null && margin.range
      ? Math.round(spend * worstRoas * margin.range.low - spend)
      : -spend;
  const ratio = (r: Range) => valueText(r, "ratio", cur);
  const money2 = (r: Range) => valueText(r, "money", cur);

  const assumptions: ScenarioBlock["assumptions"] = [
    {
      statement: `Spend: ${m(a.daily_minor)} a day for ${a.run_days} days, at most ${m(spend)} — Meta may spend less, never more over the run`,
      value: null,
      source_field: null,
      sensitivity: "low",
    },
    {
      statement: roas
        ? `Return on ad spend: ${ratio(roas)} — Meta-attributed purchases ÷ spend, per rolling ${SIM.ads_block_days}-day week across your measured campaigns, middle half (${blocks.length} weeks)`
        : `Return on ad spend: not measured — no campaign of yours has ${SIM.ads_min_measured_days} measured days in ${cur}`,
      value: null,
      source_field: null,
      sensitivity: "high",
    },
    {
      statement: margin.range
        ? `Your margin: ${valueText(margin.range, "rate", cur)} (${margin.source})`
        : `Your margin: not known — ${margin.needs ?? "not known"}`,
      value: null,
      source_field: null,
      sensitivity: "medium",
    },
    {
      statement:
        "Reach isn't forecast: Meta's reach for an ad isn't read yet. Once it runs, Meta reports how many people it reached.",
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
  ];
  const money_ = (amount: number) => ({ amount_minor: amount, currency: cur });
  const scenario: ScenarioBlock = {
    assumptions,
    base_case: {
      case: "base",
      statement: revenue
        ? `Up to ${m(spend)} spent over ${a.run_days} days, with about ${money2(revenue)} in purchases Meta attributes${profit ? ` — profit ${money2(profit)} after the spend` : ""}, if it returns what your campaigns' recent weeks did.`
        : `Up to ${m(spend)} spent over ${a.run_days} days. What it brings back can't be sized yet: no campaign of yours has ${SIM.ads_min_measured_days} measured days.`,
      profit_delta_monthly: null,
      formula: roas
        ? `${m(a.daily_minor)} × ${a.run_days} days × return ${ratio(roas)}${margin.range ? ` × margin ${valueText(margin.range, "rate", cur)} − ${m(spend)}` : ""}`
        : `${m(a.daily_minor)} × ${a.run_days} days`,
    },
    downside_case: {
      case: "downside",
      statement:
        worstRoas !== null && margin.range
          ? `Every week returns what your weakest measured week did (${worstRoas.toFixed(2)}): ${m(worst)} over the run.`
          : `All ${m(spend)} goes out and nothing comes back.`,
      profit_delta_monthly: money_(profit ? Math.min(profit.low, worst) : worst),
      formula:
        worstRoas !== null && margin.range
          ? `${m(spend)} × ${worstRoas.toFixed(2)} × ${valueText({ low: margin.range.low, high: margin.range.low }, "rate", cur, true)} − ${m(spend)}`
          : `0 − ${m(spend)}`,
    },
    upside_case: {
      case: "upside",
      statement: profit
        ? `The high end: ${m(profit.high)} over the run.`
        : "It brings in more than it costs — not sizeable until your campaigns are measured.",
      profit_delta_monthly: profit ? money_(profit.high) : null,
      formula:
        profit && roas ? `${m(spend)} × ${roas.high.toFixed(2)} × margin − ${m(spend)}` : null,
    },
    breakeven_condition: margin.range
      ? `a return on ad spend of about ${(1 / Math.max(0.01, (margin.range.low + margin.range.high) / 2)).toFixed(2)} — 1 ÷ your margin`
      : "the purchases it brings in covering what it costs to deliver them, plus the spend",
  };
  return { scenario, spend_minor: spend, revenue, profit, roas };
}
