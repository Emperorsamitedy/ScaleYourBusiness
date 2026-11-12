// Acting within limits — the v1 spec §4.1's station 4, D21 and D36.
//
// The engine asks this before a PENDING proposal may run without the
// owner's per-action yes. It answers "within" only when every one holds:
//   · the ladder says AUTHORIZED (station 4) for this capability now
//   · the provider can say what the action is (its capFacts)
//   · the stored caps say within — today's count and moved spend read from
//     limit_actions, never from anything the caller sends
//   · no standing rule forbids it or asks for the owner's approval
// "needs_approval" leaves the proposal pending for the owner, as at station
// 3; "refused" says why it won't run at all. A "within" is recorded in
// limit_actions as it is granted, so the next action counts it.

import { and, eq, gte } from "drizzle-orm";
import { db } from "../../db";
import { limitActions } from "../../db/schema";
import type { ActionFacts, CapsVerdict } from "./caps";
import { capsOf, checkCaps } from "./caps";
import { authorize } from "./ladder";
import { rulesVerdict, standingRulesOf } from "./standing-rules";

export type LimitsVerdict = CapsVerdict;

function dayStart(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

export async function withinLimits(args: {
  profileId: string;
  capability: string;
  facts: ActionFacts | null;
  now: Date;
  proposalId?: string;
}): Promise<LimitsVerdict> {
  const ladder = await authorize(args.profileId, args.capability);
  if (ladder.state !== "AUTHORIZED") {
    return {
      verdict: "needs_approval",
      reasons: ["it isn't at station 4, so it waits for your yes"],
    };
  }
  const rules = rulesVerdict(
    await standingRulesOf(args.profileId),
    {
      capability: args.capability,
      amount: args.facts?.amount ?? null,
      targets: args.facts?.targets ?? [],
    },
    args.now,
  );
  if (rules.action === "forbid") {
    return { verdict: "refused", reasons: rules.rules.map((r) => `your rule: "${r.words}"`) };
  }
  if (rules.action === "require_approval") {
    return {
      verdict: "needs_approval",
      reasons: rules.rules.map((r) => `your rule: "${r.words}"`),
    };
  }

  const today = await db
    .select()
    .from(limitActions)
    .where(
      and(
        eq(limitActions.profile_id, args.profileId),
        eq(limitActions.capability, args.capability),
        gte(limitActions.at, dayStart(args.now)),
      ),
    );
  const caps = await capsOf(args.profileId, args.capability);
  const moved = today.reduce(
    (n, a) => n + (caps && a.currency === caps.currency ? Math.abs(a.spend_delta_minor ?? 0) : 0),
    0,
  );
  return checkCaps(caps, args.facts, { actions: today.length, spend_moved_minor: moved }, args.now);
}

/** Record what station 4 approved itself, so the rest of the day counts it. */
export async function recordLimitAction(args: {
  profileId: string;
  capability: string;
  proposalId: string;
  facts: ActionFacts | null;
}): Promise<void> {
  const m = args.facts?.amount ?? args.facts?.spend_delta ?? null;
  await db
    .insert(limitActions)
    .values({
      profile_id: args.profileId,
      capability: args.capability,
      proposal_id: args.proposalId,
      currency: m?.currency ?? null,
      amount_minor: args.facts?.amount?.amount_minor ?? null,
      spend_delta_minor: args.facts?.spend_delta?.amount_minor ?? null,
    })
    .onConflictDoNothing();
}
