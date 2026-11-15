// The quarterly guarantee, run — the v1 build spec §8.4 (P7-74).
//
// "If the Proof Ledger does not show at least 3× your fee in verified euro
// over a quarter, the next quarter is free." The arithmetic is
// lib/billing/guarantee.ts (pure). This is the job around it:
//
//   · it runs on the weekly beat and evaluates every Autonomous
//     subscription's last complete quarter, once (unique per quarter)
//   · it reads ledger entries only — the standing entry per plan, for plans
//     whose entries were written in the window — and keeps exactly what it
//     read (ids, plan ids, chain hashes) on an append-only evaluation row
//   · a quarter with fewer than 8 closed plans rolls forward: the next
//     evaluation covers both quarters and both quarters' fees (D63)
//   · a shortfall writes a credit and applies it without the owner asking —
//     a negative customer balance on Stripe that pays the next quarter —
//     and tells the owner. With payments unarmed it stays pending, said so.
//   · `exportForAudit` gives an auditor everything to recompute it with no
//     application access (scripts/verify-guarantee.mjs)

import { createHash } from "node:crypto";
import { and, asc, eq, gte, lt, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  guaranteeCredits,
  guaranteeEvaluations,
  ledgerEntries,
  measurementPlans,
  ownerNotices,
  subscriptions,
} from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import { money, scaleMinorBy } from "../core/money";
import type { GuaranteeEntry, GuaranteeResult } from "./guarantee";
import { GUARANTEE, evaluateGuarantee } from "./guarantee";
import { periodAmount } from "./plans";
import type { StripeCall } from "./subscribe";
import { liveStripe } from "./subscribe";
import { paymentsConfigured } from "./stripe";

/** "2026-Q4" for a date. */
export function quarterOf(d: Date): string {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** A quarter's first instant and the next quarter's. */
export function quarterBounds(q: string): { start: string; end: string } {
  const m = /^(\d{4})-Q([1-4])$/.exec(q);
  if (!m) throw new Error("a quarter is YYYY-Qn");
  const y = Number(m[1]);
  const i = Number(m[2]) - 1;
  return {
    start: new Date(Date.UTC(y, i * 3, 1)).toISOString(),
    end: new Date(Date.UTC(y, i * 3 + 3, 1)).toISOString(),
  };
}

/** The quarter before the one `now` is in. */
export function previousQuarter(now: Date): string {
  return quarterOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)));
}

type Sub = typeof subscriptions.$inferSelect;

/** Pure: one quarter's fee in the billing currency — three months, or a quarter of the year's price. */
export function quarterFee(
  sub: Pick<Sub, "price_amount_minor" | "currency" | "billing_interval">,
): number {
  return sub.billing_interval === "year"
    ? scaleMinorBy(periodAmount(sub.price_amount_minor, sub.currency, "year"), 1, 4)
    : sub.price_amount_minor * 3;
}

export interface AuditEntry extends GuaranteeEntry {
  id: string;
  seq: number;
  entry_hash: string;
  created_at: string;
}

/** The standing entry per plan for entries written in [start, end), with the plan's grade. */
async function entriesIn(profileId: string, start: string, end: string): Promise<AuditEntry[]> {
  const rows = await db
    .select({
      e: ledgerEntries,
      grade: measurementPlans.confidence_grade,
      shadow: measurementPlans.shadow,
    })
    .from(ledgerEntries)
    .innerJoin(measurementPlans, eq(measurementPlans.id, ledgerEntries.plan_id))
    .where(
      and(
        eq(ledgerEntries.profile_id, profileId),
        gte(ledgerEntries.created_at, start),
        lt(ledgerEntries.created_at, end),
      ),
    )
    .orderBy(asc(ledgerEntries.seq));
  const byPlan = new Map<string, AuditEntry>();
  for (const r of rows) {
    byPlan.set(r.e.plan_id, {
      id: r.e.id,
      seq: r.e.seq,
      plan_id: r.e.plan_id,
      verdict: r.e.verdict,
      net_minor: r.e.net_minor,
      currency: r.e.currency,
      grade: r.grade,
      shadow: r.shadow,
      entry_hash: r.e.entry_hash,
      created_at: r.e.created_at,
    });
  }
  return [...byPlan.values()].sort((a, b) => a.seq - b.seq);
}

/** The canonical inputs an auditor recomputes from, and their hash. */
export function canonicalInputs(
  tier: string,
  fee: { amount_minor: number; currency: string },
  entries: readonly AuditEntry[],
) {
  const inputs = {
    tier,
    fee: { amount_minor: fee.amount_minor, currency: fee.currency },
    entries: entries.map((e) => ({
      id: e.id,
      plan_id: e.plan_id,
      seq: e.seq,
      verdict: e.verdict,
      net_minor: e.net_minor,
      currency: e.currency,
      grade: e.grade,
      shadow: e.shadow,
      entry_hash: e.entry_hash,
    })),
  };
  const text = JSON.stringify(inputs);
  return { inputs, hash: createHash("sha256").update(text).digest("hex") };
}

/**
 * The window this evaluation covers: this quarter, plus every quarter just
 * before it that rolled forward (D63).
 */
async function windowFor(sub: Sub, quarter: string): Promise<{ start: string; quarters: number }> {
  const past = await db
    .select({ quarter: guaranteeEvaluations.quarter, result: guaranteeEvaluations.result })
    .from(guaranteeEvaluations)
    .where(eq(guaranteeEvaluations.subscription_id, sub.id));
  let start = quarterBounds(quarter).start;
  let quarters = 1;
  let cursor = quarter;
  for (;;) {
    const before = previousQuarter(new Date(quarterBounds(cursor).start));
    const hit = past.find((p) => p.quarter === before);
    if (!hit || (hit.result as GuaranteeResult & { outcome?: string }).outcome !== "rolled_forward")
      break;
    start = quarterBounds(before).start;
    quarters += 1;
    cursor = before;
  }
  return { start, quarters };
}

async function applyCredit(
  sub: Sub,
  creditId: string,
  amount: number,
  stripe: StripeCall | null,
): Promise<"applied" | "pending"> {
  if (!stripe || !sub.stripe_customer_id) return "pending";
  const tx = await stripe(
    `customers/${sub.stripe_customer_id}/balance_transactions`,
    new URLSearchParams({
      amount: String(-amount),
      currency: sub.currency.toLowerCase(),
      description: "ScaleX guarantee: the next quarter is free",
    }),
  );
  await db
    .update(guaranteeCredits)
    .set({
      status: "applied",
      stripe_ref: String(tx.id ?? ""),
      applied_at: new Date().toISOString(),
    })
    .where(eq(guaranteeCredits.id, creditId));
  return "applied";
}

/** Evaluate one subscription's quarter; a second call for the same quarter does nothing. */
export async function evaluateQuarter(
  sub: Sub,
  quarter: string,
  stripe: StripeCall | null,
): Promise<{ outcome: string; credit_minor: number } | null> {
  const [done] = await db
    .select({ id: guaranteeEvaluations.id })
    .from(guaranteeEvaluations)
    .where(
      and(
        eq(guaranteeEvaluations.subscription_id, sub.id),
        eq(guaranteeEvaluations.quarter, quarter),
      ),
    );
  if (done) return null;
  const { start, quarters } = await windowFor(sub, quarter);
  const end = quarterBounds(quarter).end;
  const entries = await entriesIn(sub.profile_id, start, end);
  const fee = money(quarterFee(sub) * quarters, sub.currency);
  const result = evaluateGuarantee({ tier: sub.tier, fee, entries });
  const { hash } = canonicalInputs(sub.tier, fee, entries);
  const [evaluation] = await db
    .insert(guaranteeEvaluations)
    .values({
      subscription_id: sub.id,
      profile_id: sub.profile_id,
      quarter,
      tier: sub.tier,
      fee_minor: fee.amount_minor,
      currency: fee.currency,
      entries,
      result,
      inputs_hash: hash,
    })
    .onConflictDoNothing()
    .returning();
  if (!evaluation) return null;
  if (!result.applies) return { outcome: "not_autonomous", credit_minor: 0 };
  if (result.outcome === "credit" && result.credit) {
    // "The next quarter is free": the credit is one quarter's fee.
    const amount = quarterFee(sub);
    const [credit] = await db
      .insert(guaranteeCredits)
      .values({
        evaluation_id: evaluation.id,
        subscription_id: sub.id,
        amount_minor: amount,
        currency: sub.currency,
      })
      .returning();
    const status = await applyCredit(sub, credit!.id, amount, stripe);
    await db.insert(ownerNotices).values({
      profile_id: sub.profile_id,
      kind: "guarantee_credit",
      payload: {
        quarter,
        verified_minor: result.verified.amount_minor,
        fee_minor: result.fee.amount_minor,
        currency: sub.currency,
        credit_minor: amount,
        status,
      },
    });
    return { outcome: "credit", credit_minor: amount };
  }
  return { outcome: result.outcome, credit_minor: 0 };
}

/** The weekly beat's call: every Autonomous subscription's last quarter, once. */
export async function runGuaranteeQuarter(
  now = new Date(),
  stripe: StripeCall | null = paymentsConfigured() ? liveStripe() : null,
): Promise<{ evaluated: number; credits: number; rolled_forward: number }> {
  const quarter = previousQuarter(now);
  const { end } = quarterBounds(quarter);
  const subs = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.tier, GUARANTEE.tier),
        inArray(subscriptions.status, ["active", "past_due", "paused"]),
      ),
    );
  const out = { evaluated: 0, credits: 0, rolled_forward: 0 };
  for (const sub of subs) {
    if (sub.locked_at >= end) continue; // not yet subscribed in that quarter
    try {
      const r = await evaluateQuarter(sub, quarter, stripe);
      if (!r) continue;
      out.evaluated++;
      if (r.outcome === "credit") out.credits++;
      if (r.outcome === "rolled_forward") out.rolled_forward++;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "guarantee_failed",
          subscription_id: sub.id,
          ...logSafeError(error),
        }),
      );
    }
  }
  return out;
}

/**
 * §8.4: progress, live — "€1,340 verified this quarter against a €897 fee —
 * 1.5×, threshold 3×". Null when the business isn't on Autonomous.
 */
export async function guaranteeProgress(profileId: string, now = new Date()) {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.profile_id, profileId),
        eq(subscriptions.tier, GUARANTEE.tier),
        eq(subscriptions.status, "active"),
      ),
    );
  if (!sub) return null;
  const quarter = quarterOf(now);
  const { start, quarters } = await windowFor(sub, quarter);
  const entries = await entriesIn(profileId, start, quarterBounds(quarter).end);
  const result = evaluateGuarantee({
    tier: sub.tier,
    fee: money(quarterFee(sub) * quarters, sub.currency),
    entries,
  });
  return result.applies ? { quarter, ...result } : null;
}

/** Everything an auditor needs to recompute an evaluation without the application. */
export async function exportForAudit(evaluationId: string) {
  const [e] = await db
    .select()
    .from(guaranteeEvaluations)
    .where(eq(guaranteeEvaluations.id, evaluationId));
  if (!e) return null;
  return {
    quarter: e.quarter,
    inputs_hash: e.inputs_hash,
    inputs: {
      tier: e.tier,
      fee: { amount_minor: e.fee_minor, currency: e.currency },
      entries: (e.entries as AuditEntry[]).map((x) => ({
        id: x.id,
        plan_id: x.plan_id,
        seq: x.seq,
        verdict: x.verdict,
        net_minor: x.net_minor,
        currency: x.currency,
        grade: x.grade,
        shadow: x.shadow,
        entry_hash: x.entry_hash,
      })),
    },
    result: e.result,
  };
}
