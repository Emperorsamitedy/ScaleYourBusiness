// GET /api/cron/close-measurements — architecture v2 steps 5 and 6, nightly.
//
// Same shape as the other crons: Vercel calls this with
// `Authorization: Bearer ${CRON_SECRET}`. Every Proof Ledger plan whose
// window has ended is closed — scored through its capability's measurer,
// or unscored with the reason — and its outcome goes to the Trust Ladder.
// A measurer that fails leaves its plan open for the next night.

import { bearerMatches } from "../../../../lib/core/secret-compare";
import { logSafeError } from "../../../../lib/core/log-safe";
import { type NextRequest, NextResponse } from "next/server";
import { closeAndRecord } from "../../../../lib/ledger/close-due";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const summary = await closeAndRecord();
    console.log(JSON.stringify({ event: "close_measurements_cron", account_id: null, ...summary }));
    return NextResponse.json(summary);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "close_measurements_cron_failed",
        account_id: null,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
