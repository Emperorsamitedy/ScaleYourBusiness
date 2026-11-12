// Peer benchmark contribution — the v1 build spec §5.5 (P7-63), superseding
// architecture-v2 D7's opt-in.
//
// Contribution is ON by default for aggregated metrics, with a one-tap
// opt-out that changes nothing else: a business that opts out still reads
// its benchmarks; it only stops contributing. Nothing is reciprocal.
//
// The choice is a recorded fact. peer_benchmark_consents keeps every row:
// a live row (withdrawn_at null) is "in", a withdrawn row is "out", and the
// business's LATEST row decides. A business with no row at all is in — the
// default. Opting out of a business that never chose writes a row that is
// out from the moment it is written, so who chose, and when, stays
// answerable. The pool reads this on every query: an opt-out leaves every
// aggregate from the next read, well inside §5.7's 24 hours.

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { businessErasureRequests, peerBenchmarkConsents } from "../../db/schema";

type Row = { profile_id: string; consented_at: string; withdrawn_at: string | null };

/** Pure: is a business in, from its rows (any order)? No rows: in. */
export function contributesFrom(rows: readonly Row[]): boolean {
  if (rows.length === 0) return true;
  const latest = [...rows].sort((a, b) => b.consented_at.localeCompare(a.consented_at))[0]!;
  return latest.withdrawn_at === null;
}

/** Whether this business's measured figures join the pool (§5.5: yes unless it opted out). */
export async function hasPeerConsent(profileId: string): Promise<boolean> {
  const rows = await db
    .select({
      profile_id: peerBenchmarkConsents.profile_id,
      consented_at: peerBenchmarkConsents.consented_at,
      withdrawn_at: peerBenchmarkConsents.withdrawn_at,
    })
    .from(peerBenchmarkConsents)
    .where(eq(peerBenchmarkConsents.profile_id, profileId))
    .orderBy(desc(peerBenchmarkConsents.consented_at));
  return contributesFrom(rows);
}

/** Every business that has opted out, as of now. */
export async function optedOutProfiles(): Promise<Set<string>> {
  const rows = await db
    .select({
      profile_id: peerBenchmarkConsents.profile_id,
      consented_at: peerBenchmarkConsents.consented_at,
      withdrawn_at: peerBenchmarkConsents.withdrawn_at,
    })
    .from(peerBenchmarkConsents);
  const by = new Map<string, Row[]>();
  for (const r of rows) by.set(r.profile_id, [...(by.get(r.profile_id) ?? []), r]);
  const out = new Set<string>();
  for (const [profile, list] of by) if (!contributesFrom(list)) out.add(profile);
  // The v1 spec §9.4: a business that asked to be erased leaves every aggregate from the next read.
  const erasing = await db
    .select({ id: businessErasureRequests.profile_id })
    .from(businessErasureRequests);
  for (const e of erasing) out.add(e.id);
  return out;
}

/** Opt back in. Already in by an explicit row is a no-op (one live row per business). */
export async function optIntoPeers(args: { profileId: string; by: string | null }): Promise<void> {
  await db
    .insert(peerBenchmarkConsents)
    .values({ profile_id: args.profileId, consented_by: args.by })
    .onConflictDoNothing();
}

/**
 * Opt out. A live row is withdrawn; a business that never chose gets a row
 * that is out from now. Either way the latest row says out.
 */
export async function optOutOfPeers(args: { profileId: string; by: string | null }): Promise<void> {
  const now = new Date().toISOString();
  const withdrawn = await db
    .update(peerBenchmarkConsents)
    .set({ withdrawn_at: now, withdrawn_by: args.by })
    .where(
      and(
        eq(peerBenchmarkConsents.profile_id, args.profileId),
        isNull(peerBenchmarkConsents.withdrawn_at),
      ),
    )
    .returning({ id: peerBenchmarkConsents.id });
  if (withdrawn.length > 0) return;
  await db.insert(peerBenchmarkConsents).values({
    profile_id: args.profileId,
    consented_at: now,
    consented_by: null,
    withdrawn_at: now,
    withdrawn_by: args.by,
  });
}
