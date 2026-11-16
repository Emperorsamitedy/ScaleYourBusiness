// Promotion rules — the v1 build spec §4.3 (P7-41).
//
// Promotion is per capability and one station at a time, on evidence from
// the Proof Ledger. There is no global switch, and none may exist: every
// path to a higher station goes through eligibility() here, checked on the
// server, so a bypassed UI can't promote anything.
//
//   1 → 2  the capability's connector is healthy
//   2 → 3  ≥ 5 closed shadow plans; ≥ 60 % verified_gain; net positive;
//          no loss greater than 2 × that plan's expected_effect_low
//   3 → 4  ≥ 10 approved actions executed; ≥ 70 % verified_gain of their
//          closed plans; the owner has set explicit caps (§4.4); and the
//          owner re-confirms in a separate step (requestPromotion, then
//          confirmPromotion)
//
// Purchase orders never pass station 3 (§4.4). Demotion needs no evidence:
// the owner may lower a station at any time, and the stop sends all to 1.

import { and, count, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  capabilityCaps,
  connections,
  executions,
  ledgerEntries,
  measurementPlans,
  promotionRequests,
} from "../../db/schema";
import { capabilityOf, metricMeasured, PRIMARY_METRIC } from "../ledger/plans";
import type { Station } from "./ladder";
import { LadderError, setStationUnchecked, stationOf } from "./ladder";

/** §4.4: purchase orders to suppliers are capped at station 3 permanently. */
export const MAX_STATION: Readonly<Record<string, Station>> = {
  purchase_order: 3,
  // P5-16b: a follow-up goes out only on the owner's yes to the exact email (rule 29 amended).
  followup_email: 3,
  // I-45a lifted (2026-11-16): a public reply or a listing change, only on the owner's yes.
  google_business_reviews: 3,
  // D6 (2026-11-16): prices and products in the owner's shop, only on the owner's yes.
  shopify_write: 3,
};

export const RULES = {
  shadow_to_approval: { min_closed: 5, min_gain_share: 0.6, loss_cap_multiple: 2 },
  approval_to_limits: { min_executed: 10, min_gain_share: 0.7 },
  /** How long a 3 → 4 request waits for its separate confirmation. */
  confirm_within_ms: 24 * 3_600_000,
} as const;

export interface Eligibility {
  eligible: boolean;
  from: Station;
  to: Station;
  /**
   * Each rule, met or not. `detail` is English plain words (logs, errors);
   * the screen words it from `rule` and `params` in the reader's language.
   */
  checks: { rule: string; met: boolean; detail: string; params?: Record<string, number> }[];
}

interface ClosedPlan {
  verdict: string;
  net_minor: number | null;
  expected_low_minor: number;
}

/** The standing entry of each closed plan for this provider, shadow or not. */
async function closedPlans(
  profileId: string,
  provider: string,
  shadow: boolean,
): Promise<ClosedPlan[]> {
  const rows = await db
    .select({
      plan_id: measurementPlans.id,
      seq: ledgerEntries.seq,
      verdict: ledgerEntries.verdict,
      net_minor: ledgerEntries.net_minor,
      expected_low_minor: measurementPlans.expected_low_minor,
    })
    .from(ledgerEntries)
    .innerJoin(measurementPlans, eq(measurementPlans.id, ledgerEntries.plan_id))
    .where(
      and(
        eq(measurementPlans.profile_id, profileId),
        eq(measurementPlans.provider, provider),
        eq(measurementPlans.shadow, shadow),
      ),
    );
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const held = latest.get(r.plan_id);
    if (!held || r.seq > held.seq) latest.set(r.plan_id, r);
  }
  return [...latest.values()];
}

const pct = (x: number) => `${Math.round(x * 100)}%`; // not money: a share shown as words
/** A whole percentage of `part` in `whole`, for the screen's words. */
const sharePct = (part: number, whole: number) =>
  whole === 0 ? 0 : Math.round((part * 100) / whole);

async function connectorHealthy(
  accountId: string,
  provider: string,
): Promise<{ met: boolean; detail: string }> {
  let metric;
  try {
    metric = PRIMARY_METRIC[capabilityOf(provider)];
  } catch {
    return { met: false, detail: "this capability has nothing to measure it with yet" };
  }
  if (metric === "leads") {
    return { met: true, detail: "it is measured by what it logs, not by a connector" };
  }
  const healthy = await metricMeasured(accountId, metric);
  const [failing] = await db
    .select({ n: count() })
    .from(connections)
    .where(and(eq(connections.account_id, accountId), eq(connections.status, "failed")));
  return healthy
    ? { met: true, detail: `a connected source measures its ${metric.replace(/_/g, " ")}` }
    : {
        met: false,
        detail: `connect a source that measures ${metric.replace(/_/g, " ")} first${(failing?.n ?? 0) > 0 ? " — one of yours needs reconnecting" : ""}`,
      };
}

/** Whether this capability may move from its station to `to` — every rule, met or not. */
export async function eligibility(args: {
  profileId: string;
  accountId: string;
  capability: string;
  to: Station;
}): Promise<Eligibility> {
  const from = await stationOf(args.profileId, args.capability);
  const checks: Eligibility["checks"] = [];
  const done = (): Eligibility => ({
    eligible: checks.every((c) => c.met),
    from,
    to: args.to,
    checks,
  });

  if (args.to <= from) {
    checks.push({ rule: "lower", met: true, detail: "lowering a station needs no evidence" });
    return done();
  }
  if (args.to !== from + 1) {
    checks.push({
      rule: "one_step",
      met: false,
      detail: "a capability moves up one station at a time",
    });
    return done();
  }
  const ceiling = MAX_STATION[args.capability] ?? 4;
  if (args.to > ceiling) {
    checks.push({
      rule: "ceiling",
      met: false,
      detail: `${args.capability.replace(/_/g, " ")} never goes past station ${ceiling}`,
      params: { station: ceiling },
    });
    return done();
  }

  if (args.to === 2) {
    const h = await connectorHealthy(args.accountId, args.capability);
    checks.push({ rule: "connector_healthy", ...h });
    return done();
  }

  if (args.to === 3) {
    const r = RULES.shadow_to_approval;
    const plans = await closedPlans(args.profileId, args.capability, true);
    const gains = plans.filter((p) => p.verdict === "verified_gain").length;
    const net = plans.reduce((s, p) => s + (p.net_minor ?? 0), 0);
    const bigLoss = plans.find(
      (p) =>
        p.verdict === "loss" &&
        p.net_minor !== null &&
        Math.abs(p.net_minor) > r.loss_cap_multiple * Math.abs(p.expected_low_minor),
    );
    checks.push(
      {
        rule: "closed_shadow_plans",
        met: plans.length >= r.min_closed,
        detail: `${plans.length} of ${r.min_closed} shadow plans closed`,
        params: { done: plans.length, need: r.min_closed },
      },
      {
        rule: "gain_share",
        met: plans.length > 0 && gains / plans.length >= r.min_gain_share,
        detail: `${plans.length === 0 ? "0%" : pct(gains / plans.length)} verified gains, of ${pct(r.min_gain_share)} needed`,
        params: { share: sharePct(gains, plans.length), need: Math.round(r.min_gain_share * 100) },
      },
      { rule: "net_positive", met: net > 0, detail: net > 0 ? "net positive" : "not net positive" },
      {
        rule: "no_big_loss",
        met: bigLoss === undefined,
        detail: bigLoss
          ? "one shadow loss was more than twice the low end of its own forecast"
          : "no loss beyond twice its forecast's low end",
      },
    );
    return done();
  }

  // 3 → 4
  const r = RULES.approval_to_limits;
  const [executed] = await db
    .select({ n: count() })
    .from(executions)
    .where(
      and(
        eq(executions.profile_id, args.profileId),
        eq(executions.provider, args.capability),
        eq(executions.status, "succeeded"),
      ),
    );
  const plans = await closedPlans(args.profileId, args.capability, false);
  const gains = plans.filter((p) => p.verdict === "verified_gain").length;
  const [caps] = await db
    .select({ capability: capabilityCaps.capability })
    .from(capabilityCaps)
    .where(
      and(
        eq(capabilityCaps.profile_id, args.profileId),
        eq(capabilityCaps.capability, args.capability),
      ),
    );
  const n = executed?.n ?? 0;
  checks.push(
    {
      rule: "executed_actions",
      met: n >= r.min_executed,
      detail: `${n} of ${r.min_executed} approved actions carried out`,
      params: { done: n, need: r.min_executed },
    },
    {
      rule: "gain_share",
      met: plans.length > 0 && gains / plans.length >= r.min_gain_share,
      detail: `${plans.length === 0 ? "0%" : pct(gains / plans.length)} verified gains, of ${pct(r.min_gain_share)} needed`,
      params: { share: sharePct(gains, plans.length), need: Math.round(r.min_gain_share * 100) },
    },
    {
      rule: "caps_set",
      met: caps !== undefined,
      detail: caps ? "your limits are set" : "set this capability's limits first",
    },
  );
  return done();
}

/**
 * Raise or lower one capability's station — the only way up. Up to 4 goes
 * through requestPromotion and confirmPromotion instead.
 */
export async function changeStation(args: {
  profileId: string;
  accountId: string;
  capability: string;
  to: Station;
  by: string | null;
  reason?: string;
}): Promise<Eligibility> {
  if (args.to === 4) {
    throw new LadderError(
      "station 4 needs its limits and a separate confirmation — ask for it, then confirm it",
      409,
    );
  }
  const e = await eligibility(args);
  if (!e.eligible) {
    throw new LadderError(
      `not yet: ${e.checks
        .filter((c) => !c.met)
        .map((c) => c.detail)
        .join("; ")}`,
      409,
    );
  }
  await setStationUnchecked({
    profileId: args.profileId,
    capability: args.capability,
    station: args.to,
    by: args.by,
    reason:
      args.reason ??
      (args.to > e.from ? "promoted on the ledger's evidence" : "lowered by the owner"),
  });
  return e;
}

/** Step one of 3 → 4: checks the evidence and records the request the owner must confirm. */
export async function requestPromotion(args: {
  profileId: string;
  accountId: string;
  capability: string;
  by: string | null;
  now?: Date;
}): Promise<{ request_id: string; expires_at: string; eligibility: Eligibility }> {
  const e = await eligibility({ ...args, to: 4 });
  if (!e.eligible) {
    throw new LadderError(
      `not yet: ${e.checks
        .filter((c) => !c.met)
        .map((c) => c.detail)
        .join("; ")}`,
      409,
    );
  }
  const now = args.now ?? new Date();
  const expires = new Date(now.getTime() + RULES.confirm_within_ms).toISOString();
  return db.transaction(async (tx) => {
    await tx
      .update(promotionRequests)
      .set({ withdrawn_at: now.toISOString() })
      .where(
        and(
          eq(promotionRequests.profile_id, args.profileId),
          eq(promotionRequests.capability, args.capability),
          isNull(promotionRequests.confirmed_at),
          isNull(promotionRequests.withdrawn_at),
        ),
      );
    const [row] = await tx
      .insert(promotionRequests)
      .values({
        profile_id: args.profileId,
        capability: args.capability,
        to_station: 4,
        eligibility: e,
        requested_by: args.by,
        requested_at: now.toISOString(),
        expires_at: expires,
      })
      .returning();
    return { request_id: row!.id, expires_at: expires, eligibility: e };
  });
}

/** Step two: the separate confirmation. Re-checks the evidence; the request must be live. */
export async function confirmPromotion(args: {
  profileId: string;
  accountId: string;
  requestId: string;
  by: string | null;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  const [req] = await db
    .select()
    .from(promotionRequests)
    .where(
      and(
        eq(promotionRequests.id, args.requestId),
        eq(promotionRequests.profile_id, args.profileId),
      ),
    );
  if (!req || req.withdrawn_at !== null || req.confirmed_at !== null) {
    throw new LadderError("there's no open request to confirm — ask again", 404);
  }
  if (Date.parse(req.expires_at) < now.getTime()) {
    throw new LadderError("that request has run out — ask again, then confirm", 409);
  }
  const e = await eligibility({
    profileId: args.profileId,
    accountId: args.accountId,
    capability: req.capability,
    to: 4,
  });
  if (!e.eligible) {
    throw new LadderError("the evidence changed since you asked — it isn't eligible now", 409);
  }
  await db
    .update(promotionRequests)
    .set({ confirmed_at: now.toISOString(), confirmed_by: args.by })
    .where(eq(promotionRequests.id, req.id));
  await setStationUnchecked({
    profileId: args.profileId,
    capability: req.capability,
    station: 4,
    by: args.by,
    reason: "promoted to act within limits, confirmed in a separate step",
  });
}
