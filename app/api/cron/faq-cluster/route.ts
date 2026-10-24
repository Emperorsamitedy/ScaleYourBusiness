// GET /api/cron/faq-cluster — the P4-12 nightly clustering.
//
// Same shape as the other crons: Vercel calls this with
// `Authorization: Bearer ${CRON_SECRET}`. One batched Haiku call per
// business with support enabled and enough open questions; a business
// with fewer than FAQ_MIN_CLUSTER questions costs nothing.

import { bearerMatches } from "../../../../lib/core/secret-compare";
import { logSafeError } from "../../../../lib/core/log-safe";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../../db";
import { supportSettings } from "../../../../db/schema";
import { clusterQuestions } from "../../../../lib/crm/faq";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const rows = await db
      .select({ profile_id: supportSettings.profile_id, account_id: supportSettings.account_id })
      .from(supportSettings);
    const summary = {
      businesses: rows.length,
      proposed: 0,
      unanswered: 0,
      failed: 0,
      cost_eur: 0,
    };
    // One business failing (an API error, or the model declining) is logged
    // and counted; it never stops the rest of the night's run.
    for (const row of rows) {
      try {
        const outcome = await clusterQuestions(row.profile_id, row.account_id);
        if (outcome.proposal_id) summary.proposed += 1;
        summary.unanswered += outcome.unanswered.length;
        summary.cost_eur += outcome.cost_eur;
      } catch (error) {
        summary.failed += 1;
        console.error(
          JSON.stringify({
            event: "faq_cluster_business_failed",
            account_id: row.account_id,
            profile_id: row.profile_id,
            ...logSafeError(error),
          }),
        );
      }
    }
    console.log(JSON.stringify({ event: "faq_cluster_cron", ...summary }));
    return NextResponse.json(summary);
  } catch (error) {
    console.error(JSON.stringify({ event: "faq_cluster_cron_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
