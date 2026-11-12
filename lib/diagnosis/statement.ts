// The monthly ledger statement — the v1 build spec §6.4 (P7-53).
//
// "What SYB did, what it was worth, what it cost, what is queued, and the
// one decision waiting on the owner. The weekly carries the pulse; the
// monthly carries the proof. One artifact, one decision, monthly."
//
// What it was worth is the Proof Ledger's headline counter (§3.4) over the
// entries written in the month — losses in, not-yet-proven counted apart.
// What it cost is SYB's own fee for the month, when there is a subscription
// (nothing is charged while payments aren't armed, and it says so).

import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db } from "../../db";
import {
  executions,
  ledgerEntries,
  measurementPlans,
  proposals,
  subscriptions,
} from "../../db/schema";
import type { Money } from "../core/money";
import { money } from "../core/money";
import type { HeadlineCounter } from "../ledger/counter";
import { counterOf } from "../ledger/counter";

export interface MonthlyStatement {
  month: string;
  did: { actions: number; undone: number };
  worth: HeadlineCounter;
  /** SYB's fee for the month; null while no subscription is charged. */
  fee: Money | null;
  queued: number;
  /** The one decision waiting on the owner: the oldest pending proposal. */
  decision: { proposal_id: string; summary: string } | null;
}

function monthRange(month: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("a month is YYYY-MM");
  const [y, m] = month.split("-").map(Number) as [number, number];
  return {
    start: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    end: new Date(Date.UTC(y, m, 1)).toISOString(),
  };
}

export async function monthlyStatement(
  profileId: string,
  month: string,
): Promise<MonthlyStatement> {
  const { start, end } = monthRange(month);
  const ran = await db
    .select({ status: executions.status })
    .from(executions)
    .where(
      and(
        eq(executions.profile_id, profileId),
        gte(executions.started_at, start),
        lt(executions.started_at, end),
      ),
    );
  const rows = await db
    .select({ entry: ledgerEntries, plan: measurementPlans })
    .from(ledgerEntries)
    .innerJoin(measurementPlans, eq(measurementPlans.id, ledgerEntries.plan_id))
    .where(
      and(
        eq(ledgerEntries.profile_id, profileId),
        gte(ledgerEntries.created_at, start),
        lt(ledgerEntries.created_at, end),
      ),
    );
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.profile_id, profileId), eq(subscriptions.status, "active")))
    .limit(1);
  const fee = sub ? money(sub.price_amount_minor, sub.currency) : null;
  const pending = await db
    .select({ id: proposals.id, action: proposals.action })
    .from(proposals)
    .where(and(eq(proposals.profile_id, profileId), eq(proposals.status, "pending")))
    .orderBy(asc(proposals.created_at));
  const first = pending[0];
  return {
    month,
    did: {
      actions: ran.filter((r) => r.status === "succeeded" || r.status === "undone").length,
      undone: ran.filter((r) => r.status === "undone").length,
    },
    worth: counterOf(rows, fee ? [fee] : []),
    fee,
    queued: pending.length,
    decision: first
      ? {
          proposal_id: first.id,
          summary:
            typeof (first.action as { summary?: unknown })?.summary === "string"
              ? (first.action as { summary: string }).summary
              : "",
        }
      : null,
  };
}
