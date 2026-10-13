// Gate 2's approval rate across customers — the query P3-37 reads.
//
// The same arithmetic as each profile's scorecard (approvalRate), summed
// over every customer profile. Internal accounts (P3-40b) are excluded:
// SYB approving its own proposals is not evidence that owners trust the
// system. The rate says whatever it says; "under 30% means stop adding
// modules" is a decision for a person reading this, not code.

import { db } from "../../db";
import { proposals } from "../../db/schema";
import { internalProfileIds } from "../ops/internal";
import type { StatusCounts } from "./scorecard";
import { approvalRate } from "./scorecard";

export interface CrossCustomerRate {
  profiles: number;
  counts: StatusCounts;
  approval_rate: { numerator: number; denominator: number; value: number | null };
  arithmetic: string;
}

export async function crossCustomerApprovalRate(): Promise<CrossCustomerRate> {
  const rows = await db
    .select({ profile_id: proposals.profile_id, status: proposals.status })
    .from(proposals);
  const internal = await internalProfileIds();
  const counts: StatusCounts = {
    blocked: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    expired: 0,
    executed: 0,
  };
  const profiles = new Set<string>();
  for (const row of rows) {
    if (internal.has(row.profile_id)) continue;
    profiles.add(row.profile_id);
    if (row.status in counts) counts[row.status as keyof StatusCounts] += 1;
  }
  const rate = approvalRate(counts);
  return {
    profiles: profiles.size,
    counts,
    approval_rate: rate.approval_rate,
    arithmetic: `across ${profiles.size} customer profile(s): ${rate.arithmetic}`,
  };
}
