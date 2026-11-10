// The margin guard — the multi-market spec §B.4, the v1 spec §11.4.
//
// Per business per month: LLM tokens, video renders and connector calls,
// read from what is already recorded (llm_calls, media_generations and
// footage_renders, connector_syncs' pages). Each tier's quotas are data
// (usage_quotas): past the soft cap the owner sees a notice; at the hard
// cap the metered work stops. A business with no subscription has no tier
// and no quota — payments aren't armed yet (D19).
//
// Cost per business per month, by tier and by capability, is summed in the
// database as exact numerics and handed back as decimal strings, never as
// floats (hard rule 1). It is SYB's own cost, in the currency it is
// recorded in: the LLM meter's EUR estimate, media in its own currency.

import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  connectorSyncs,
  footageRenders,
  llmCalls,
  mediaGenerations,
  subscriptions,
  usageQuotas,
} from "../../db/schema";

export type QuotaMetric = "llm_tokens" | "video_renders" | "connector_calls";
export const QUOTA_METRICS: readonly QuotaMetric[] = [
  "llm_tokens",
  "video_renders",
  "connector_calls",
];

export type Usage = Record<QuotaMetric, number>;

export type QuotaState = "within" | "soft" | "hard";

export interface Quota {
  metric: QuotaMetric;
  monthly_soft: number;
  monthly_hard: number;
}

/** The calendar month containing `now`, in UTC: [start, end). */
export function monthOf(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Pure: where one metric's use stands against its quota. */
export function quotaState(used: number, q: Quota): QuotaState {
  if (used >= q.monthly_hard) return "hard";
  if (used >= q.monthly_soft) return "soft";
  return "within";
}

/** The business's usage this month. */
export async function usageThisMonth(
  accountId: string,
  profileId: string,
  now = new Date(),
): Promise<Usage> {
  const { start, end } = monthOf(now);
  const [tokens] = await db
    .select({
      n: sql<string>`coalesce(sum(${llmCalls.input_tokens} + ${llmCalls.output_tokens} + coalesce(${llmCalls.cache_creation_input_tokens}, 0)), 0)`,
    })
    .from(llmCalls)
    .where(and(eq(llmCalls.account_id, accountId), gte(llmCalls.at, start), lt(llmCalls.at, end)));
  const [media] = await db
    .select({ n: sql<string>`count(*)` })
    .from(mediaGenerations)
    .where(
      and(
        eq(mediaGenerations.profile_id, profileId),
        eq(mediaGenerations.media, "video"),
        gte(mediaGenerations.created_at, start),
        lt(mediaGenerations.created_at, end),
      ),
    );
  const [footage] = await db
    .select({ n: sql<string>`count(*)` })
    .from(footageRenders)
    .where(
      and(
        eq(footageRenders.profile_id, profileId),
        gte(footageRenders.created_at, start),
        lt(footageRenders.created_at, end),
      ),
    );
  const [calls] = await db
    .select({ n: sql<string>`coalesce(sum(${connectorSyncs.pages}), 0)` })
    .from(connectorSyncs)
    .where(
      and(
        eq(connectorSyncs.account_id, accountId),
        gte(connectorSyncs.started_at, start),
        lt(connectorSyncs.started_at, end),
      ),
    );
  return {
    llm_tokens: Number(tokens?.n ?? 0),
    video_renders: Number(media?.n ?? 0) + Number(footage?.n ?? 0),
    connector_calls: Number(calls?.n ?? 0),
  };
}

/** The business's tier: its live subscription's, or null with none (no quota applies). */
export async function tierOf(profileId: string): Promise<string | null> {
  const [s] = await db
    .select({ tier: subscriptions.tier })
    .from(subscriptions)
    .where(and(eq(subscriptions.profile_id, profileId), eq(subscriptions.status, "active")))
    .limit(1);
  return s?.tier ?? null;
}

export interface QuotaReport {
  tier: string | null;
  usage: Usage;
  /** Per metric: within, soft (notice the owner), hard (stop). Empty without a tier. */
  states: Partial<Record<QuotaMetric, QuotaState>>;
}

export async function quotaReport(
  accountId: string,
  profileId: string,
  now = new Date(),
): Promise<QuotaReport> {
  const [tier, usage] = await Promise.all([
    tierOf(profileId),
    usageThisMonth(accountId, profileId, now),
  ]);
  if (tier === null) return { tier, usage, states: {} };
  const quotas = await db
    .select()
    .from(usageQuotas)
    .where(eq(usageQuotas.tier, tier as (typeof usageQuotas.$inferSelect)["tier"]));
  const states: QuotaReport["states"] = {};
  for (const q of quotas) states[q.metric] = quotaState(usage[q.metric], q);
  return { tier, usage, states };
}

/** The hard cap, for the metered paths: may this business spend more of `metric` this month? */
export async function withinHardCap(
  accountId: string,
  profileId: string,
  metric: QuotaMetric,
  now = new Date(),
): Promise<boolean> {
  const r = await quotaReport(accountId, profileId, now);
  return r.states[metric] !== "hard";
}

export interface CostRow {
  account_id: string;
  tier: string | null;
  /** The LLM workload or the media provider. */
  capability: string;
  /** Exact decimal string, never a float. */
  cost: string;
  currency: string;
}

/** §11.4/§11.5: cost per business per month, by tier and by capability — exact sums. */
export async function costByBusiness(now = new Date()): Promise<CostRow[]> {
  const { start, end } = monthOf(now);
  const llm = await db
    .select({
      account_id: llmCalls.account_id,
      capability: llmCalls.workload,
      cost: sql<string>`sum(${llmCalls.cost_eur})::text`,
    })
    .from(llmCalls)
    .where(and(gte(llmCalls.at, start), lt(llmCalls.at, end)))
    .groupBy(llmCalls.account_id, llmCalls.workload);
  const media = await db
    .select({
      account_id: mediaGenerations.account_id,
      capability: mediaGenerations.provider,
      currency: mediaGenerations.currency,
      cost: sql<string>`(sum(coalesce(${mediaGenerations.cost_minor}, 0)))::text`,
    })
    .from(mediaGenerations)
    .where(and(gte(mediaGenerations.created_at, start), lt(mediaGenerations.created_at, end)))
    .groupBy(mediaGenerations.account_id, mediaGenerations.provider, mediaGenerations.currency);

  const accountIds = [
    ...new Set([...llm, ...media].map((r) => r.account_id).filter((a): a is string => a !== null)),
  ];
  const tiers = new Map<string, string>();
  if (accountIds.length > 0) {
    const rows = await db
      .select({ account_id: businessProfiles.account_id, tier: subscriptions.tier })
      .from(subscriptions)
      .innerJoin(businessProfiles, eq(businessProfiles.id, subscriptions.profile_id))
      .where(
        and(inArray(businessProfiles.account_id, accountIds), eq(subscriptions.status, "active")),
      );
    for (const r of rows) tiers.set(r.account_id, r.tier);
  }
  const out: CostRow[] = [];
  for (const r of llm) {
    if (r.account_id === null) continue;
    out.push({
      account_id: r.account_id,
      tier: tiers.get(r.account_id) ?? null,
      capability: r.capability,
      cost: r.cost,
      currency: "EUR",
    });
  }
  for (const r of media) {
    if (r.account_id === null) continue;
    out.push({
      account_id: r.account_id,
      tier: tiers.get(r.account_id) ?? null,
      capability: r.capability,
      cost: r.cost,
      currency: r.currency,
    });
  }
  return out;
}
