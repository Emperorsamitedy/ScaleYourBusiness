// GET /api/ops?key=…&days=30 — the pilot instrument panel (P1-51/53).
//
// Operator-only, gated by the OPS_KEY shared secret (the SENTRY_TEST_KEY
// pattern). Unset key = endpoint off. Wrong key answers exactly like a
// missing route — nothing to enumerate.

import { type NextRequest, NextResponse } from "next/server";
import { abandonmentSummary, costSummary, funnelSummary } from "../../../lib/ops/summary";
import { crossCustomerApprovalRate } from "../../../lib/trust/gate";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.OPS_KEY;
  const key = request.nextUrl.searchParams.get("key");
  if (!secret || key !== secret) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const days = Math.min(
    365,
    Math.max(1, Number.parseInt(request.nextUrl.searchParams.get("days") ?? "30", 10) || 30),
  );
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  try {
    const [funnel, abandonment, costs, gate2] = await Promise.all([
      funnelSummary(since),
      abandonmentSummary(since),
      costSummary(since),
      crossCustomerApprovalRate(),
    ]);
    return NextResponse.json({ since, days, funnel, abandonment, costs, gate2 });
  } catch (error) {
    console.error(JSON.stringify({ event: "ops_summary_failed", message: String(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
