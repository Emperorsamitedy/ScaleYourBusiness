// Steps 5 and 6 of the call order, on a clock: every plan whose window has
// ended is closed (ProofLedger.close_measurement, the v1 spec §3.2's
// ledger_entry) and its outcome handed to the ladder
// (TrustLadder.record_outcome).
//
// MEASURERS is where a capability learns to score its own actions in money,
// keyed by §3.2's capability. Until a capability has one, its plans close
// inconclusive, saying so — counted as "not yet proven", never in the
// headline number (§3.4).

import { recordOutcome } from "../ladder/ladder";
import type { Measurer } from "./close";
import { closeDuePlans } from "./close";

export const MEASURERS: Readonly<Record<string, Measurer>> = {};

export async function closeAndRecord(
  args: {
    now?: Date;
    measurers?: Readonly<Record<string, Measurer>>;
    only?: readonly string[];
  } = {},
): Promise<{ closed: number; left_open: number }> {
  return closeDuePlans({
    ...(args.now ? { now: args.now } : {}),
    ...(args.only ? { only: args.only } : {}),
    measurers: args.measurers ?? MEASURERS,
    onClosed: async (entry, plan) => {
      await recordOutcome({
        profileId: plan.profile_id,
        capability: plan.provider,
        measurementId: plan.id,
        outcome: {
          verdict: entry.verdict,
          verified: entry.verdict === "verified_gain",
          euro_minor: entry.net_minor,
          currency: entry.currency,
          grade: plan.confidence_grade,
          shadow: plan.shadow,
        },
      });
    },
  });
}
