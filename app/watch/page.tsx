// /watch — Insights · Watching (P1-47, the owner's Watching design).
//
// The signals table is read here, on the server, behind the same door
// every profile route uses (lib/auth/access): the series a connection
// holds are many rows, and only their verdicts need to reach the browser.

import type { Metadata } from "next";
import { WatchScreen } from "../../components/watch/WatchScreen";
import { resolveAccess } from "../../lib/auth/access";
import { logSafeError } from "../../lib/core/log-safe";
import { latestDecision } from "../../lib/mode/service";
import type { WatchReading } from "../../lib/watch/signals";
import { loadWatchReading } from "../../lib/watch/signals";
import { watchDays } from "../../lib/watch/watch-view";

export const metadata: Metadata = { title: "Watching — Ledgerline" };
export const dynamic = "force-dynamic";

async function reading(): Promise<WatchReading | null> {
  const access = await resolveAccess();
  if (!access) return null;
  const w = watchDays(await latestDecision(access.profile_id), new Date());
  if (!w) return null;
  return loadWatchReading(access.profile_id, w.start);
}

export default async function WatchPage() {
  let data: WatchReading | null = null;
  try {
    data = await reading();
  } catch (error) {
    // The table is a read; the screen still shows the watch without it.
    console.error(JSON.stringify({ event: "watch_reading_failed", ...logSafeError(error) }));
  }
  return <WatchScreen reading={data} />;
}
