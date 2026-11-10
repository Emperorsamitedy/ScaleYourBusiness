// GET /api/cron/ledger-head — the v1 build spec §3.5: the chain head,
// published daily (P7-35). Vercel calls this with
// `Authorization: Bearer ${CRON_SECRET}`; a second call the same day is a
// no-op. Where it goes is lib/ledger/chain.ts publishChainHead (D27).

import { type NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "../../../../lib/core/secret-compare";
import { logSafeError } from "../../../../lib/core/log-safe";
import { publishChainHead } from "../../../../lib/ledger/chain";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const day = new Date().toISOString().slice(0, 10);
    const result = await publishChainHead(day);
    console.log(JSON.stringify({ event: "ledger_head_cron", account_id: null, day, ...result }));
    return NextResponse.json({ day, ...result });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "ledger_head_cron_failed",
        account_id: null,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
