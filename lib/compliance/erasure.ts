// A business's erasure request — the v1 build spec §9.4 / §9.5.
//
// "Erasure requests must cascade to the Peer Benchmark Network: a deleted
// business is removed from future aggregates, and historical aggregates are
// recomputed or expired, not left standing." The request takes the business
// out of every aggregate at once (lib/peers/consent reads it on every query;
// no aggregate is stored, so there is none to recompute). An operator
// completes the removal of the data itself and stamps completed_at; the
// request and its fact stay in the decision log.

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { businessErasureRequests, decisionLog } from "../../db/schema";

export async function requestErasure(profileId: string, userId: string | null, now = new Date()) {
  const [made] = await db
    .insert(businessErasureRequests)
    .values({ profile_id: profileId, requested_by: userId, requested_at: now.toISOString() })
    .onConflictDoNothing()
    .returning();
  if (made) {
    await db.insert(decisionLog).values({
      profile_id: profileId,
      actor: "owner",
      kind: "erasure",
      ref_id: `business:${profileId}`,
      payload_hash: createHash("sha256")
        .update(JSON.stringify({ business_erasure: profileId, at: made.requested_at }))
        .digest("hex"),
      user_id: userId,
    });
  }
  return erasureOf(profileId);
}

export async function erasureOf(profileId: string) {
  const [r] = await db
    .select()
    .from(businessErasureRequests)
    .where(eq(businessErasureRequests.profile_id, profileId));
  return r ?? null;
}
