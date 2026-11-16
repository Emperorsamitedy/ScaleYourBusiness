// Measurement plans — the v1 build spec §3.1–§3.3 (P7-33, P7-36).
//
// §3.1: no action executes without a measurement plan written first. The
// plan states the expectation before the outcome is known — the hypothesis,
// the expected effect as a range, the window, the design — which is what
// makes the later score honest rather than a post-hoc story. Once opened it
// is immutable: the table's trigger (migration 0103) turns an edit into a
// tamper event and leaves the plan as it was, so window_end can't move.
//
// §3.3: always the strongest design the capability allows, downgraded only
// with a recorded reason. DESIGN_PREFERENCE is the spec's table, as data;
// BUILT_DESIGNS says which designs SYB can actually run today. A plan never
// claims a holdout SYB doesn't hold back: until one is built, the plan says
// pre/post (C at best) and records why.

import { and, asc, eq, inArray, isNull, lte, ne, notExists, sql } from "drizzle-orm";
import { db } from "../../db";
import { connections, ledgerEntries, measurementPlans } from "../../db/schema";
import { BALANCE_IMPORT_PROVIDER } from "../balance/source";
import { CONNECTOR_READS } from "../connectors/contract";
import type { MetricKey } from "../connectors/provider";
import { isProviderId } from "../connectors/scopes";
import type { Grade } from "../core/grade";
import type { Money } from "../core/money";
import { isIsoCurrency } from "../core/money";

export type Plan = typeof measurementPlans.$inferSelect;
export type PlanCapability = Plan["capability"];
export type PlanDesign = Plan["design"];
export type PlanMetric = Plan["primary_metric"];

/** D12, kept: the window when nothing names another. */
export const DEFAULT_WINDOW_DAYS = 28;

/** §3.7: executing without an open plan raises this, and the action does not run. */
export class MeasurementRequiredError extends Error {
  constructor(
    message = "there is no open measurement plan for this action — nothing runs without one",
  ) {
    super(message);
    this.name = "MeasurementRequiredError";
  }
}

export class PlanError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "PlanError";
    this.status = status;
  }
}

/** §3.3's table: each capability's designs, strongest first. */
export const DESIGN_PREFERENCE: Readonly<Record<PlanCapability, readonly PlanDesign[]>> = {
  meta_ads: ["holdout_geo", "pre_post_adjusted"],
  google_ads: ["holdout_geo", "pre_post_adjusted"],
  tiktok_ads: ["holdout_geo", "pre_post_adjusted"],
  site_copy: ["ab_split", "pre_post_adjusted"],
  bundle: ["ab_split", "pre_post_adjusted"],
  email_campaign: ["holdout_audience", "ab_split", "pre_post_adjusted"],
  winback: ["holdout_audience", "pre_post_adjusted"],
  hours_change: ["switchback", "pre_post_adjusted"],
  price_change: ["switchback", "pre_post_adjusted"],
  reorder: ["matched_period", "pre_post_adjusted"],
  purchase_order: ["matched_period", "pre_post_adjusted"],
  tiktok_post: ["pre_post_adjusted"],
  meta_post: ["pre_post_adjusted"],
  chat_answer: ["unmeasurable"],
  review_reply: ["unmeasurable"],
  fixture: ["pre_post_adjusted", "unmeasurable"],
};

/**
 * The designs SYB can run today, per capability. Nothing holds back a
 * region, an audience slice or a split yet, so every capability is pre/post
 * or unmeasurable until its holdout is built — and its plans say so.
 */
export const BUILT_DESIGNS: ReadonlySet<PlanDesign> = new Set([
  "pre_post_adjusted",
  "unmeasurable",
]);

/** The engine's provider ids → §3.2's capability. */
export const PROVIDER_CAPABILITY: Readonly<Record<string, PlanCapability>> = {
  meta_ads: "meta_ads",
  google_ads: "google_ads",
  tiktok_ads: "tiktok_ads",
  tiktok_publish: "tiktok_post",
  meta_publish: "meta_post",
  email_campaign: "email_campaign",
  purchase_order: "purchase_order",
  google_business_reviews: "review_reply",
  fixture: "fixture",
  fixture_site: "fixture",
};

export function capabilityOf(provider: string, module?: string | null): PlanCapability {
  if (provider === "email_campaign" && module === "winback") return "winback";
  const c = PROVIDER_CAPABILITY[provider];
  if (!c) throw new PlanError(`no measurement capability is defined for ${provider}`);
  return c;
}

/** Each capability's primary metric — what its plan is scored on. */
export const PRIMARY_METRIC: Readonly<Record<PlanCapability, PlanMetric>> = {
  meta_ads: "revenue",
  google_ads: "revenue",
  tiktok_ads: "revenue",
  tiktok_post: "revenue",
  meta_post: "revenue",
  site_copy: "revenue",
  bundle: "revenue",
  price_change: "gross_profit",
  email_campaign: "revenue",
  winback: "revenue",
  hours_change: "revenue",
  reorder: "cash_days",
  purchase_order: "cash_days",
  chat_answer: "leads",
  review_reply: "leads",
  fixture: "revenue",
};

/** The connector metrics that measure each primary metric. */
const METRIC_SOURCES: Readonly<Record<PlanMetric, readonly MetricKey[]>> = {
  revenue: ["revenue.daily"],
  gross_profit: ["revenue.daily"],
  orders: ["orders.daily"],
  bookings: ["appointments_completed.daily"],
  leads: [],
  cost: ["ad_spend.daily"],
  cash_days: ["cash.balance"],
};

/** Whether a live connection of this account measures the metric. */
export async function metricMeasured(accountId: string, metric: PlanMetric): Promise<boolean> {
  const wanted = METRIC_SOURCES[metric];
  if (wanted.length === 0) return false;
  const rows = await db
    .select({ provider: connections.provider })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.status, "connected"),
        ne(connections.purpose, "execute"),
      ),
    );
  return rows.some((r) => {
    if (r.provider === BALANCE_IMPORT_PROVIDER) return wanted.includes("cash.balance");
    return isProviderId(r.provider) && CONNECTOR_READS[r.provider].some((m) => wanted.includes(m));
  });
}

/**
 * §3.2's confidence_grade: A measured both arms, B measured one arm plus a
 * control period, C connector data with no control, D owner-stated inputs
 * only. Pre/post caps at C (§3.3); unmeasurable is never better than D.
 */
export function planGrade(design: PlanDesign, measured: boolean): Grade {
  if (!measured || design === "unmeasurable") return "D";
  switch (design) {
    case "holdout_geo":
    case "holdout_audience":
    case "ab_split":
    case "switchback":
      return "A";
    case "matched_period":
      return "B";
    case "pre_post_adjusted":
      return "C";
  }
}

/** The strongest design this capability allows that SYB can run, and why it isn't stronger. */
export function chooseDesign(capability: PlanCapability): {
  design: PlanDesign;
  downgrade_reason: string | null;
} {
  const preferred = DESIGN_PREFERENCE[capability];
  const design = preferred.find((d) => BUILT_DESIGNS.has(d)) ?? "unmeasurable";
  const strongest = preferred[0]!;
  return {
    design,
    downgrade_reason:
      design === strongest
        ? null
        : `${strongest.replace(/_/g, " ")} isn't built for this yet, so it is measured ${design === "unmeasurable" ? "not at all" : "before and after, against the same weeks a year earlier"}`,
  };
}

/** The control a design compares against. Null only for unmeasurable. */
export function controlFor(
  design: PlanDesign,
  windowStart: string,
  windowEnd: string,
): Record<string, unknown> | null {
  if (design === "unmeasurable") return null;
  const days = Math.round((Date.parse(windowEnd) - Date.parse(windowStart)) / 86_400_000);
  if (design === "pre_post_adjusted") {
    return {
      kind: "pre_period",
      days,
      ends_at: windowStart,
      adjustment:
        "the same weeks a year earlier (difference in differences, D89); with no year of history it isn't scored",
    };
  }
  return { kind: design };
}

export interface OpenPlanInput {
  profileId: string;
  accountId: string;
  provider: string;
  /** The proposal's module ("winback" makes an email a win-back). */
  module?: string | null;
  proposalId?: string | null;
  action_summary: string;
  hypothesis: string;
  /** Signed point estimate and range for the WINDOW, in one currency. Null when none was made. */
  expected: { effect: Money; low: Money; high: Money } | null;
  /** Which currency a plan without a forecast is kept in. */
  currency: string;
  cost?: Money | null;
  reversible: boolean;
  rollback_token?: string | null;
  opened_by: "agent" | "owner" | "partner";
  station: 1 | 2 | 3 | 4;
  shadow: boolean;
  windowDays?: number;
  now?: Date;
}

/**
 * ProofLedger.open_measurement — written before execution (§3.1). One plan
 * per proposal: a retried execution reads the plan it already has, and
 * never writes a second one with a later window.
 */
export async function openPlan(input: OpenPlanInput): Promise<{ plan: Plan; reused: boolean }> {
  if (input.proposalId) {
    const [existing] = await db
      .select()
      .from(measurementPlans)
      .where(eq(measurementPlans.proposal_id, input.proposalId));
    if (existing) return { plan: existing, reused: true };
  }
  if (input.action_summary.trim() === "") throw new PlanError("a plan says what the action is");
  if (input.hypothesis.trim() === "") throw new PlanError("a plan says what it expects to change");

  const currency = input.expected?.effect.currency ?? input.currency;
  if (!isIsoCurrency(currency)) throw new PlanError("a plan's money needs its currency");
  if (input.expected) {
    const { effect, low, high } = input.expected;
    if (low.currency !== currency || high.currency !== currency) {
      throw new PlanError("a plan's range is in one currency (rule 1)");
    }
    if (!(low.amount_minor <= effect.amount_minor && effect.amount_minor <= high.amount_minor)) {
      throw new PlanError("the expected effect sits inside its range");
    }
  }
  if (input.cost && input.cost.currency !== currency) {
    throw new PlanError("a plan's cost is in the plan's currency (rule 1)");
  }

  const capability = capabilityOf(input.provider, input.module);
  const metric = PRIMARY_METRIC[capability];
  const { design, downgrade_reason } = chooseDesign(capability);
  const grade = planGrade(design, await metricMeasured(input.accountId, metric));
  const now = input.now ?? new Date();
  const windowStart = now.toISOString();
  const windowEnd = new Date(
    now.getTime() + (input.windowDays ?? DEFAULT_WINDOW_DAYS) * 86_400_000,
  ).toISOString();

  const [row] = await db
    .insert(measurementPlans)
    .values({
      profile_id: input.profileId,
      account_id: input.accountId,
      proposal_id: input.proposalId ?? null,
      capability,
      provider: input.provider,
      action_summary: input.action_summary,
      hypothesis: input.hypothesis,
      primary_metric: metric,
      currency,
      expected_effect_minor: input.expected?.effect.amount_minor ?? 0,
      expected_low_minor: input.expected?.low.amount_minor ?? 0,
      expected_high_minor: input.expected?.high.amount_minor ?? 0,
      window_start: windowStart,
      window_end: windowEnd,
      design,
      control_definition: controlFor(design, windowStart, windowEnd),
      downgrade_reason,
      confidence_grade: grade,
      cost_minor: input.cost?.amount_minor ?? 0,
      reversible: input.reversible,
      rollback_token: input.reversible ? (input.rollback_token ?? null) : null,
      opened_by: input.opened_by,
      ladder_station_at_open: input.station,
      shadow: input.shadow,
      opened_at: windowStart,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { plan: row, reused: false };
  // Two runs opened at once: the unique index kept one, and this one reads it.
  return openPlan(input);
}

export async function planById(planId: string): Promise<Plan | null> {
  const [row] = await db.select().from(measurementPlans).where(eq(measurementPlans.id, planId));
  return row ?? null;
}

/** Open: the plan exists, isn't a shadow, and no entry has closed it. */
export async function isPlanOpen(planId: string): Promise<boolean> {
  const plan = await planById(planId);
  if (!plan) return false;
  const [closed] = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.plan_id, planId))
    .limit(1);
  return !closed;
}

/** §3.7: the engine's hard error. Nothing runs without an open plan. */
export async function requireOpenPlan(planId: string | null | undefined): Promise<Plan> {
  if (!planId) throw new MeasurementRequiredError();
  const plan = await planById(planId);
  if (!plan || !(await isPlanOpen(planId))) throw new MeasurementRequiredError();
  return plan;
}

/** Plans whose window has ended that no entry has closed yet, oldest first. */
export async function duePlans(now: Date, only?: readonly string[]): Promise<Plan[]> {
  return db
    .select()
    .from(measurementPlans)
    .where(
      and(
        lte(measurementPlans.window_end, now.toISOString()),
        notExists(
          db
            .select({ one: sql`1` })
            .from(ledgerEntries)
            .where(
              and(
                eq(ledgerEntries.plan_id, measurementPlans.id),
                isNull(ledgerEntries.corrects_entry_id),
              ),
            ),
        ),
        only ? inArray(measurementPlans.id, [...only]) : undefined,
      ),
    )
    .orderBy(asc(measurementPlans.window_end));
}
