// The day-30 shadow summary — the v1 build spec §4.2 (P7-45).
//
// "In 30 days SYB would have made 14 changes. 9 would have gained €2,140.
//  3 would have done nothing. 2 would have lost €310. Net: €1,830 — and we
//  touched nothing."
//
// Built from the shadow plans the ledger closed for the business's first 30
// days: every closed shadow plan is a change SYB would have made, counted by
// its verdict. Losses are counted and summed in plain sight, and a business
// with no gains gets the same honest sentence with zeros in it. Per
// currency, never converted (rule 1). Plans still open are counted apart.

import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../../db";
import { accounts, businessProfiles, ledgerEntries, measurementPlans } from "../../db/schema";
import type { Money } from "../core/money";
import { money } from "../core/money";

export const SHADOW_DAYS = 30;

export interface ShadowSummary {
  from: string;
  to: string;
  /** Closed shadow plans: the changes SYB would have made and the ledger scored. */
  changes: number;
  gained: { count: number; total: Money[] };
  nothing: number;
  lost: { count: number; total: Money[] };
  /** Inconclusive or unmeasurable — would have happened, can't be said what it did. */
  unproven: number;
  /** Shadow plans whose windows haven't closed yet. */
  still_open: number;
  net: Money[];
}

function sumBy(rows: readonly { currency: string; net: number }[]): Money[] {
  const t = new Map<string, number>();
  for (const r of rows) t.set(r.currency, (t.get(r.currency) ?? 0) + r.net);
  return [...t].sort(([a], [b]) => a.localeCompare(b)).map(([c, m]) => money(m, c));
}

export async function shadowSummary(
  profileId: string,
  from: Date,
  days = SHADOW_DAYS,
): Promise<ShadowSummary> {
  const to = new Date(from.getTime() + days * 86_400_000);
  const plans = await db
    .select()
    .from(measurementPlans)
    .where(
      and(
        eq(measurementPlans.profile_id, profileId),
        eq(measurementPlans.shadow, true),
        gte(measurementPlans.opened_at, from.toISOString()),
        lte(measurementPlans.opened_at, to.toISOString()),
      ),
    );
  const entries = plans.length
    ? await db.select().from(ledgerEntries).where(eq(ledgerEntries.profile_id, profileId))
    : [];
  const standing = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    const held = standing.get(e.plan_id);
    if (!held || e.seq > held.seq) standing.set(e.plan_id, e);
  }

  const gains: { currency: string; net: number }[] = [];
  const losses: { currency: string; net: number }[] = [];
  let nothing = 0;
  let unproven = 0;
  let stillOpen = 0;
  for (const p of plans) {
    const e = standing.get(p.id);
    if (!e) {
      stillOpen += 1;
      continue;
    }
    if (p.design === "unmeasurable" || e.verdict === "inconclusive") unproven += 1;
    else if (e.verdict === "no_effect") nothing += 1;
    else if (e.verdict === "verified_gain")
      gains.push({ currency: e.currency, net: e.net_minor ?? 0 });
    else if (e.verdict === "loss") losses.push({ currency: e.currency, net: e.net_minor ?? 0 });
  }
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    changes: plans.length - stillOpen,
    gained: { count: gains.length, total: sumBy(gains) },
    nothing,
    lost: { count: losses.length, total: sumBy(losses) },
    unproven,
    still_open: stillOpen,
    net: sumBy([...gains, ...losses]),
  };
}

/**
 * The summary for a business's own shadow period: its first 30 days when it
 * has one (§4.2), else the last 30 — plus its currency, for an honest zero.
 */
export async function shadowSummaryFor(
  profileId: string,
  now = new Date(),
): Promise<{ summary: ShadowSummary; currency: string }> {
  const [row] = await db
    .select({ shadow_until: businessProfiles.shadow_until, currency: accounts.reporting_currency })
    .from(businessProfiles)
    .innerJoin(accounts, eq(accounts.id, businessProfiles.account_id))
    .where(eq(businessProfiles.id, profileId));
  const day = 86_400_000;
  const from = row?.shadow_until
    ? new Date(Date.parse(row.shadow_until) - SHADOW_DAYS * day)
    : new Date(now.getTime() - SHADOW_DAYS * day);
  return { summary: await shadowSummary(profileId, from), currency: row?.currency ?? "EUR" };
}
