// The peer average order value — architecture-v2 D13, superseded by the v1
// spec §5.3 (P7-62).
//
// D13 pooled each peer's STATED monthly revenue ÷ stated orders. §5.3
// forbids that: "Owner-stated numbers may be compared against a cohort but
// never contribute to one." This keeps D13's call and its shape, and now
// answers from the measured cohort (./benchmark): the cohort's median order
// value, in the reader's currency, or nothing — Eurostat stays the
// labelled reference (§5.4).

import type { Money } from "../core/money";
import { money } from "../core/money";
import { peerBenchmarks } from "./benchmark";

export type PeerServed =
  { shown: true; value: Money; businesses: number } | { shown: false; fallback: "eurostat" };

const NOT_SHOWN: PeerServed = { shown: false, fallback: "eurostat" };

/** The cohort's median average order value for this business, or nothing at all. */
export async function peerAverageOrderValue(
  profileId: string,
  now = new Date(),
): Promise<PeerServed> {
  const served = (await peerBenchmarks(profileId, now)).find(
    (b) => b.metric === "average_order_value",
  );
  if (served?.status !== "served" || served.currency === null) return NOT_SHOWN;
  return {
    shown: true,
    value: money(served.p50, served.currency),
    businesses: served.cohort.businesses,
  };
}
