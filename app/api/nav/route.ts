// The menu's counts (ux-spec §3, the owner's menu design 2026-10-17):
// the business name, the watch day, and one number per screen where a
// number exists. Read-only, one small query each, behind the same door
// as every other owner screen. A count that cannot be known is absent,
// never a guess — the menu prints nothing beside that item.

import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { connections, fieldRecords, goals, proposals, supportTickets } from "../../../db/schema";
import { resolveAccess } from "../../../lib/auth/access";
import { enumCode } from "../../../lib/core/enum-value";
import { logSafeError } from "../../../lib/core/log-safe";
import { countStoppedReads } from "../../../lib/connectors/service";
import { countPausedExecutionConnections } from "../../../lib/execution/connections";
import type { SizeBand } from "../../../lib/core/size-features";
import { latestDecision } from "../../../lib/mode/service";
import { SIZE_BAND_KEY, TEAM_SIZE_KEY, resolveSizeBand } from "../../../lib/profile/size-band";
import { watchDays } from "../../../lib/watch/watch-view";
import { stockApplies } from "../../../lib/stock/load";
import { teamModuleOn } from "../../../lib/team/module";
import { pipelineApplies } from "../../../lib/pipeline/deals";
import { cartsApply } from "../../../lib/carts/load";
import { membershipsFor } from "../../../lib/auth/members";
import type { Role } from "../../../lib/auth/role-actions";
import { roleOf } from "../../../lib/auth/roles";

/**
 * Idea 52: who is signed in here, quietly — the role on this business, and
 * the other businesses the same verified email belongs to (by name only),
 * for the switcher. A business nobody owns yet (the anonymous interview)
 * has its one person as owner and nothing to switch to.
 */
export interface NavAccess {
  role: Role;
  signed_in: boolean;
  businesses: { account_id: string; name: string | null; role: Role; current: boolean }[];
}

export interface NavCounts {
  business: string | null;
  /**
   * The profile's business_type code (identity.business_type), so a screen
   * can say "your salon" through lib/core/business-noun; null unanswered.
   */
  business_type: string | null;
  watch: { day: number; of: number } | null;
  pending: number;
  /** Pending proposals per module, for Content / Website / Support. */
  by_module: Record<string, number>;
  goals: number;
  facts: number;
  connections: number;
  /**
   * P3-24b, the needs-you flag beside Connections: write connections that
   * paused themselves because Meta refused their sign-in, and (since
   * 2026-11-20, the first review's leftover) sources that stopped reading by
   * themselves after repeated failures. The menu prints "N paused" there
   * instead of the connected count, until each is reconnected or resumed.
   * A source the owner paused is their own choice and is not counted.
   */
  needs_reconnect: number;
  /** P4-11: support tickets waiting for a person — chat and email alike. */
  support_open: number;
  /**
   * The business's size band (lib/profile/size-band.ts): the owner's own
   * answer, else inferred from the headcount; null when neither exists,
   * and the menu then shows everything (lib/core/size-features.ts).
   */
  size_band: { band: SizeBand; via: "stated" | "inferred" } | null;
  /**
   * Feature 34: whether the business holds stock (lib/stock/load's
   * STOCK_APPLIES, a condition over the bank's own answers). The Slow
   * stock item shows only when true; a services-only business never sees it.
   */
  stock: boolean;
  /**
   * P5-18 (rule 28): whether the owner switched the team module on. The
   * Team item shows only when true; it is off by default.
   */
  team: boolean;
  /**
   * P5-17: whether the business sells to businesses (lib/pipeline/stages'
   * PIPELINE_APPLIES, a condition over 6.1a). The Pipeline item shows only
   * when true.
   */
  pipeline: boolean;
  /**
   * Idea 47: whether a store connection reads abandoned carts (Shopify
   * today; lib/carts/load's cartsApply, from the provider registry). The
   * Abandoned carts item shows only when true.
   */
  carts: boolean;
  /** Idea 52: the signed-in role and the businesses to switch between. */
  access: NavAccess;
}

const NAME_KEY = "identity.legal_name";
const TYPE_KEY = "identity.business_type";

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const profileId = access.profile_id;
  try {
    const [
      pendingRows,
      goalRows,
      factRows,
      connRows,
      pausedCount,
      stoppedCount,
      idRows,
      decision,
      openRows,
      sizeRows,
      stock,
      team,
      pipeline,
      carts,
    ] = await Promise.all([
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
      countStoppedReads(access.account_id),
      db
        .select({ key: fieldRecords.field_key, value: fieldRecords.value })
        .from(fieldRecords)
        .where(
          and(
            eq(fieldRecords.profile_id, profileId),
            inArray(fieldRecords.field_key, [NAME_KEY, TYPE_KEY]),
            isNull(fieldRecords.superseded_at),
          ),
        ),
      latestDecision(profileId),
      db
        .select({ n: count() })
        .from(supportTickets)
        .where(and(eq(supportTickets.profile_id, profileId), eq(supportTickets.status, "open"))),
      db
        .select({
          field_key: fieldRecords.field_key,
          status: fieldRecords.status,
          value: fieldRecords.value,
          confidence: fieldRecords.confidence,
          observed_at: fieldRecords.observed_at,
        })
        .from(fieldRecords)
        .where(
          and(
            eq(fieldRecords.profile_id, profileId),
            inArray(fieldRecords.field_key, [SIZE_BAND_KEY, TEAM_SIZE_KEY]),
            isNull(fieldRecords.superseded_at),
          ),
        ),
      stockApplies(profileId),
      teamModuleOn(access.account_id),
      pipelineApplies(profileId),
      cartsApply(access.account_id),
    ]);
    const memberships = access.session ? await membershipsFor(access.session.email) : [];

    const by_module: Record<string, number> = {};
    for (const r of pendingRows) by_module[r.module] = Number(r.n);
    const pending = Object.values(by_module).reduce((s, n) => s + n, 0);

    // The same calendar-day count the Watching screen prints (lib/watch).
    const days = watchDays(decision, new Date());
    const watch: NavCounts["watch"] = days ? { day: days.day, of: days.of } : null;

    const sized = resolveSizeBand(
      sizeRows.find((r) => r.field_key === SIZE_BAND_KEY),
      sizeRows.find((r) => r.field_key === TEAM_SIZE_KEY),
    );

    const name = idRows.find((r) => r.key === NAME_KEY)?.value;
    const body: NavCounts = {
      business: typeof name === "string" && name.trim() ? name.trim() : null,
      business_type: enumCode(idRows.find((r) => r.key === TYPE_KEY)?.value),
      watch,
      pending,
      by_module,
      goals: Number(goalRows[0]?.n ?? 0),
      facts: Number(factRows[0]?.n ?? 0),
      connections: Number(connRows[0]?.n ?? 0),
      needs_reconnect: pausedCount + stoppedCount,
      support_open: Number(openRows[0]?.n ?? 0),
      size_band: sized ? { band: sized.band, via: sized.via } : null,
      stock,
      team,
      pipeline,
      carts,
      access: {
        role: roleOf(access) ?? "viewer",
        signed_in: access.session !== null,
        businesses: memberships.map((m) => ({
          account_id: m.account_id,
          name: m.business,
          role: m.role,
          current: m.account_id === access.account_id,
        })),
      },
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
