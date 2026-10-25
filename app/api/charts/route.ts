// The trading-style charts — GET /api/charts.
//
// Read-only: the market chart ("your shop, read like a stock") with its
// opportunity-cost overlay, and the smaller bookings and ads charts where
// the business has that data (lib/charts/load). Nothing here writes,
// executes or calls a model. Reading needs the same access as every other
// owner screen (lib/auth/access).

import { NextResponse } from "next/server";
import { resolveAccess } from "../../../lib/auth/access";
import { loadCharts } from "../../../lib/charts/load";
import { logSafeError } from "../../../lib/core/log-safe";

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    return NextResponse.json(await loadCharts(access.account_id, access.profile_id));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "charts_load_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
