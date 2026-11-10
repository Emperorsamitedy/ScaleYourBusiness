// Peer benchmark consent — architecture-v2 D7. Opt-in only; withdrawing
// keeps the row with its withdrawal stamped, so who agreed, who withdrew
// and when stays answerable.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { peerBenchmarkConsents } from "../../db/schema";

export async function hasPeerConsent(profileId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: peerBenchmarkConsents.id })
    .from(peerBenchmarkConsents)
    .where(
      and(
        eq(peerBenchmarkConsents.profile_id, profileId),
        isNull(peerBenchmarkConsents.withdrawn_at),
      ),
    );
  return row !== undefined;
}

/** Opt in. Already in is a no-op: one live consent per business (the partial unique index). */
export async function optIntoPeers(args: { profileId: string; by: string | null }): Promise<void> {
  await db
    .insert(peerBenchmarkConsents)
    .values({ profile_id: args.profileId, consented_by: args.by })
    .onConflictDoNothing();
}

/** Withdraw. The business's figures leave every aggregate from the next read. */
export async function optOutOfPeers(args: { profileId: string; by: string | null }): Promise<void> {
  await db
    .update(peerBenchmarkConsents)
    .set({ withdrawn_at: new Date().toISOString(), withdrawn_by: args.by })
    .where(
      and(
        eq(peerBenchmarkConsents.profile_id, args.profileId),
        isNull(peerBenchmarkConsents.withdrawn_at),
      ),
    );
}
