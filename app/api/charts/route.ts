// The trading-style charts — GET /api/charts.
//
// Read-only: the market chart ("your shop, read like a stock") with its
// opportunity-cost overlay, and the smaller bookings and ads charts where
// the business has that data (lib/charts/load). Nothing here writes,
// executes or calls a model. Reading needs the same access as every other
// owner screen (lib/auth/access).
//
// L-4b: the sentences the charts carry (headline, summaries, reasons,
// formulas, event labels) go out in the request's language; nothing here
// is stored, so nothing stored changes language.

import { NextResponse } from "next/server";
import { resolveAccess } from "../../../lib/auth/access";
import { loadCharts } from "../../../lib/charts/load";
import { logSafeError } from "../../../lib/core/log-safe";
import { requestWords } from "../../../lib/i18n/request-words";

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const words = await requestWords("chartsWords");
    return NextResponse.json(
      await loadCharts(access.account_id, access.profile_id, new Date(), words),
    );
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
