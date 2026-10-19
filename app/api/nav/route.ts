// The menu's counts (ux-spec §3, the owner's menu design 2026-10-17):
// the business name, the watch day, and one number per screen where a
// number exists. Read-only, one small query each, behind the same door
// as every other owner screen. A count that cannot be known is absent,
// never a guess — the menu prints nothing beside that item.

import { and, count, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { connections, fieldRecords, goals, proposals, supportTickets } from "../../../db/schema";
import { resolveAccess } from "../../../lib/auth/access";
import { logSafeError } from "../../../lib/core/log-safe";
import { countPausedExecutionConnections } from "../../../lib/execution/connections";
import { latestDecision } from "../../../lib/mode/service";
import { watchDays } from "../../../lib/watch/watch-view";

export interface NavCounts {
  business: string | null;
  watch: { day: number; of: number } | null;
  pending: number;
  /** Pending proposals per module, for Content / Website / Support. */
  by_module: Record<string, number>;
  goals: number;
  facts: number;
  connections: number;
  /**
   * P3-24b, the needs-you flag beside Connections: write connections that
   * paused themselves because Meta refused their sign-in. The menu prints
   * "N paused" there instead of the connected count, until reconnected.
   */
  needs_reconnect: number;
  /** P4-11: support tickets waiting for a person — chat and email alike. */
  support_open: number;
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const profileId = access.profile_id;
  try {
    const [pendingRows, goalRows, factRows, connRows, pausedCount, nameRow, decision, openRows] =
      await Promise.all([
        db
          .select({ module: proposals.module, n: count() })
          .from(proposals)
          .where(and(eq(proposals.profile_id, profileId), eq(proposals.status, "pending")))
          .groupBy(proposals.module),
        db.select({ n: count() }).from(goals).where(eq(goals.profile_id, profileId)),
        db
          .select({ n: count() })
          .from(fieldRecords)
          .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at))),
        db
          .select({ n: count() })
          .from(connections)
          .where(
            and(eq(connections.account_id, access.account_id), eq(connections.status, "connected")),
          ),
        countPausedExecutionConnections(access.account_id),
        db
          .select({ value: fieldRecords.value })
          .from(fieldRecords)
          .where(
            and(
              eq(fieldRecords.profile_id, profileId),
              eq(fieldRecords.field_key, "identity.legal_name"),
              isNull(fieldRecords.superseded_at),
            ),
          ),
        latestDecision(profileId),
        db
          .select({ n: count() })
          .from(supportTickets)
          .where(and(eq(supportTickets.profile_id, profileId), eq(supportTickets.status, "open"))),
      ]);

    const by_module: Record<string, number> = {};
    for (const r of pendingRows) by_module[r.module] = Number(r.n);
    const pending = Object.values(by_module).reduce((s, n) => s + n, 0);

    // The same calendar-day count the Watching screen prints (lib/watch).
    const days = watchDays(decision, new Date());
    const watch: NavCounts["watch"] = days ? { day: days.day, of: days.of } : null;

    const name = nameRow[0]?.value;
    const body: NavCounts = {
      business: typeof name === "string" && name.trim() ? name.trim() : null,
      watch,
      pending,
      by_module,
      goals: Number(goalRows[0]?.n ?? 0),
      facts: Number(factRows[0]?.n ?? 0),
      connections: Number(connRows[0]?.n ?? 0),
      needs_reconnect: pausedCount,
      support_open: Number(openRows[0]?.n ?? 0),
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "nav_counts_error",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
