// A failed connector demotes what depended on it — the v1 spec §11.2:
// "Any capability depending on a failed connector auto-demotes to station 1
// and notifies." Never silently, and never blanking the product: figures
// fall back to what else is known (their grades drop), and only the
// capabilities that can no longer be measured stop acting.
//
// A capability depends on a connector when its primary metric (the
// measurement plan's, lib/ledger/plans) is no longer measured by any live
// connection of the account once the failed one is gone.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, ownerNotices } from "../../db/schema";
import { PRIMARY_METRIC, capabilityOf, metricMeasured } from "../ledger/plans";
import { CAPABILITIES, setStationUnchecked, stationOf } from "./ladder";

export async function demoteOnConnectorFailure(args: {
  accountId: string;
  provider: string;
}): Promise<string[]> {
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, args.accountId));
  if (!profile) return [];
  const demoted: string[] = [];
  for (const capability of CAPABILITIES) {
    let metric;
    try {
      metric = PRIMARY_METRIC[capabilityOf(capability)];
    } catch {
      continue; // a capability with no measurement plan has no connector to depend on
    }
    if (metric === "leads") continue;
    if (await metricMeasured(args.accountId, metric)) continue;
    const from = await stationOf(profile.id, capability);
    if (from <= 1) continue;
    await setStationUnchecked({
      profileId: profile.id,
      capability,
      station: 1,
      by: null,
      reason: `${args.provider} failed, and nothing else measures its ${metric.replace(/_/g, " ")}`,
      kind: "connector_demotion",
    });
    demoted.push(capability);
  }
  if (demoted.length > 0) {
    await db.insert(ownerNotices).values({
      profile_id: profile.id,
      kind: "connector_demotion",
      payload: { provider: args.provider, capabilities: demoted },
    });
  }
  return demoted;
}
