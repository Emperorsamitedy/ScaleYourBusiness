// GET /api/cron/fx-rates — the multi-market spec §A.3: the ECB's daily
// reference rates, fetched once a day and stored. Same shape as the other
// crons: Vercel calls with `Authorization: Bearer ${CRON_SECRET}`. A day
// already stored is kept exactly as it was.

import { type NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "../../../../lib/core/secret-compare";
import { logSafeError } from "../../../../lib/core/log-safe";
import { fetchAndStoreEcb } from "../../../../lib/fx/ecb";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const result = await fetchAndStoreEcb();
    console.log(JSON.stringify({ event: "fx_rates_cron", account_id: null, ...result }));
    return NextResponse.json(result);
  } catch (error) {
    console.error(
      JSON.stringify({ event: "fx_rates_cron_failed", account_id: null, ...logSafeError(error) }),
    );
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
