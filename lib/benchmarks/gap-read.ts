// A large benchmark gap, read for one business — I-44a. The only door from
// the diagnosis report and the proposals into lib/benchmarks
// (fence.test.ts): readers import this file or ./gap, nothing else here.
//
// Read-only: it writes no row and no Field, calls no model and nothing
// outside the database. The threshold and the like-for-like rules are in
// ./gap, pure.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { costItems, offers } from "../../db/schema";
import type { Facts } from "../cash/inputs";
import type { DiagnosisFinding } from "../diagnosis/findings";
import { compareWithSimilar } from "./compare";
import { gapFinding, largeGap } from "./gap";
import type { LargeGap } from "./gap";
import { benchInputsOf, loadBenchInputs } from "./load";

/** The large margin gap from the profile's current facts, or null. */
export async function currentGap(
  profileId: string,
  now: Date = new Date(),
): Promise<LargeGap | null> {
  const inputs = await loadBenchInputs(profileId, now);
  return largeGap(compareWithSimilar(inputs), inputs);
}

/**
 * The report's benchmark finding for a frozen snapshot's facts (P1-34),
 * or null when there is no large, like-for-like gap. The cost and offer
 * rows give only ids and buckets; every value is the snapshot's.
 */
export async function reportGapFinding(
  profileId: string,
  facts: Facts,
  now: Date = new Date(),
): Promise<DiagnosisFinding | null> {
  const [items, offerRows] = await Promise.all([
    db
      .select({ id: costItems.id, bucket: costItems.bucket })
      .from(costItems)
      .where(eq(costItems.profile_id, profileId)),
    db.select({ id: offers.id }).from(offers).where(eq(offers.profile_id, profileId)),
  ]);
  const inputs = benchInputsOf(
    facts,
    items,
    offerRows.map((o) => o.id),
    now.toISOString().slice(0, 10),
  );
  const gap = largeGap(compareWithSimilar(inputs), inputs);
  return gap ? gapFinding(gap, new Set(facts.keys())) : null;
}
