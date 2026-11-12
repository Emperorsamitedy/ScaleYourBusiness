// The ladder screen's data — the v1 spec §4.6: "one screen, always reachable
// in one tap, listing every capability as a row with its current station,
// its ledger record, and its promote or demote control." Read-only here;
// every change goes through ./promotion.ts, ./caps.ts, ./standing-rules.ts.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { ledgerEntries, measurementPlans, ownerNotices, promotionRequests } from "../../db/schema";
import { EXECUTION_SCOPE_REGISTRY } from "../execution/scopes";
import type { Caps } from "./caps";
import { capsOf } from "./caps";
import type { Station } from "./ladder";
import { CAPABILITIES, stationCeiling, stationOf } from "./ladder";
import type { Eligibility } from "./promotion";
import { eligibility } from "./promotion";
import type { StandingRule } from "./standing-rules";
import { dueForRenewal, standingRulesOf } from "./standing-rules";

export interface LadderRow {
  capability: string;
  label: string;
  station: Station;
  ceiling: Station;
  /** What the next station up still needs; null at the ceiling. */
  next: Eligibility | null;
  record: { closed: number; gains: number; losses: number; shadow_closed: number };
  caps: Caps | null;
  open_request: { id: string; expires_at: string } | null;
}

export interface LadderOverview {
  rows: LadderRow[];
  rules: StandingRule[];
  rules_due: string[];
  notices: { id: string; kind: string; payload: unknown; created_at: string }[];
}

export async function ladderOverview(
  profileId: string,
  accountId: string,
  now = new Date(),
): Promise<LadderOverview> {
  const entries = await db
    .select({
      provider: measurementPlans.provider,
      shadow: measurementPlans.shadow,
      plan_id: ledgerEntries.plan_id,
      seq: ledgerEntries.seq,
      verdict: ledgerEntries.verdict,
    })
    .from(ledgerEntries)
    .innerJoin(measurementPlans, eq(measurementPlans.id, ledgerEntries.plan_id))
    .where(eq(measurementPlans.profile_id, profileId));
  const standing = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    const held = standing.get(e.plan_id);
    if (!held || e.seq > held.seq) standing.set(e.plan_id, e);
  }
  const requests = await db
    .select()
    .from(promotionRequests)
    .where(
      and(
        eq(promotionRequests.profile_id, profileId),
        isNull(promotionRequests.confirmed_at),
        isNull(promotionRequests.withdrawn_at),
      ),
    );
  const ceiling = await stationCeiling(profileId);
  const rows: LadderRow[] = [];
  for (const capability of CAPABILITIES) {
    const station = await stationOf(profileId, capability, db, now);
    const mine = [...standing.values()].filter((e) => e.provider === capability);
    const real = mine.filter((e) => !e.shadow);
    const req = requests.find(
      (r) => r.capability === capability && Date.parse(r.expires_at) > now.getTime(),
    );
    rows.push({
      capability,
      label:
        EXECUTION_SCOPE_REGISTRY[capability as keyof typeof EXECUTION_SCOPE_REGISTRY]?.label ??
        capability,
      station,
      ceiling,
      next:
        station < ceiling
          ? await eligibility({ profileId, accountId, capability, to: (station + 1) as Station })
          : null,
      record: {
        closed: real.length,
        gains: real.filter((e) => e.verdict === "verified_gain").length,
        losses: real.filter((e) => e.verdict === "loss").length,
        shadow_closed: mine.length - real.length,
      },
      caps: await capsOf(profileId, capability),
      open_request: req ? { id: req.id, expires_at: req.expires_at } : null,
    });
  }
  const rules = await standingRulesOf(profileId);
  const notices = await db
    .select()
    .from(ownerNotices)
    .where(and(eq(ownerNotices.profile_id, profileId), isNull(ownerNotices.seen_at)));
  return {
    rows,
    rules,
    rules_due: dueForRenewal(rules, now).map((r) => r.id),
    notices: notices.map((n) => ({
      id: n.id,
      kind: n.kind,
      payload: n.payload,
      created_at: n.created_at,
    })),
  };
}

export async function markNoticeSeen(profileId: string, noticeId: string): Promise<void> {
  await db
    .update(ownerNotices)
    .set({ seen_at: new Date().toISOString() })
    .where(and(eq(ownerNotices.id, noticeId), eq(ownerNotices.profile_id, profileId)));
}
