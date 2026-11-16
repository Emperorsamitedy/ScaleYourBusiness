// Learning from declines — Phase 3 Session E (P3-28), build-sequence
// step 76. An owner who rejected three proposals of a kind stops
// receiving that kind: their reasons are already in the decision log
// and on the rows; the LEAST the system can do with them is stop
// nagging. Deterministic suppression first — counting is not taste,
// and no model gets to argue an owner out of their own pattern.
//
// Scope, deliberately: suppression applies to SYSTEM-initiated
// generation (generateProposals). The /content buttons are the owner
// asking — an owner who requests a calendar gets one regardless of
// past declines, because answering a direct request is not nagging.

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { proposals } from "../../db/schema";

export const SUPPRESSION_THRESHOLD = 3;

export interface SuppressedKind {
  kind: string;
  rejections: number;
  /** The owner's own reasons, newest last — the why behind the silence. */
  reasons: string[];
}

/** Action kinds this profile has declined SUPPRESSION_THRESHOLD+ times. */
export async function suppressedKinds(profileId: string): Promise<Map<string, SuppressedKind>> {
  const rows = await db
    .select({ action: proposals.action, reason: proposals.rejection_reason })
    .from(proposals)
    .where(and(eq(proposals.profile_id, profileId), eq(proposals.status, "rejected")));

  const byKind = new Map<string, SuppressedKind>();
  for (const row of rows) {
    const action = row.action as { kind?: string; detail?: { revert_of?: unknown } };
    const kind = action.kind;
    if (typeof kind !== "string") continue;
    // Declining to put a trial's hours back is keeping them — not a no to trials.
    if (action.detail?.revert_of !== undefined) continue;
    const entry = byKind.get(kind) ?? { kind, rejections: 0, reasons: [] };
    entry.rejections += 1;
    if (row.reason) entry.reasons.push(row.reason);
    byKind.set(kind, entry);
  }
  const suppressed = new Map<string, SuppressedKind>();
  for (const [kind, entry] of byKind) {
    if (entry.rejections >= SUPPRESSION_THRESHOLD) suppressed.set(kind, entry);
  }
  return suppressed;
}
