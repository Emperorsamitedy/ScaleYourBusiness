// GET /api/ledger/verify — the v1 build spec §3.5: "a verify endpoint that
// walks the chain and returns the first break" (P7-35).
//
// Public on purpose: anyone holding a published chain head can check that
// the ledger still ends in it, without an account. It reveals no business —
// only the chain's length, its head hash, and, if it is broken, the first
// broken entry's sequence number and id. It walks the whole chain, so each
// address may ask a few times a minute.

import { type NextRequest, NextResponse } from "next/server";
import { withinRateLimit } from "../../../../lib/core/rate-limit";
import { logSafeError } from "../../../../lib/core/log-safe";
import { verifyLedger } from "../../../../lib/ledger/chain";

export const VERIFY_LIMIT_PER_MINUTE = 6;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ip =
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  if (!(await withinRateLimit(`ledger-verify:${ip}`, VERIFY_LIMIT_PER_MINUTE, 60_000))) {
    return NextResponse.json({ error: "too many checks — try again in a minute" }, { status: 429 });
  }
  try {
    return NextResponse.json(await verifyLedger());
  } catch (error) {
    console.error(
      JSON.stringify({ event: "ledger_verify_failed", account_id: null, ...logSafeError(error) }),
    );
    return NextResponse.json(
      { error: "the check couldn't run — try again shortly" },
      { status: 500 },
    );
  }
}
