// Steps 5 and 6 of architecture v2's call order, on a clock: every plan
// whose window has ended is closed (ProofLedger.close_measurement) and its
// outcome handed to the ladder (TrustLadder.record_outcome).
//
// MEASURERS is where a capability learns to score its own actions in money
// (TASKS-PHASE7 P7-16). Until a capability has one, its plans close as
// unscored with the reason, and add nothing to the verified counter (D11).

import { recordOutcome } from "../ladder/ladder";
import type { LedgerEntry, Measurer } from "./ledger";
import { closeDueMeasurements } from "./ledger";

export const MEASURERS: Readonly<Record<string, Measurer>> = {};

export async function closeAndRecord(
  args: {
    now?: Date;
    measurers?: Readonly<Record<string, Measurer>>;
    only?: readonly string[];
  } = {},
): Promise<{ closed: number; left_open: number }> {
  return closeDueMeasurements({
    ...(args.now ? { now: args.now } : {}),
    ...(args.only ? { only: args.only } : {}),
    measurers: args.measurers ?? MEASURERS,
    onClosed: async (entry: LedgerEntry) => {
      await recordOutcome({
        profileId: entry.profile_id,
        capability: entry.capability,
        measurementId: entry.measurement_id,
        outcome: {
          verified: entry.verified,
          euro_minor: entry.euro_minor,
          currency: entry.currency,
          grade: entry.grade,
        },
      });
    },
  });
}
