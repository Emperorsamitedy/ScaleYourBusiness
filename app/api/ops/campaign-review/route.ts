// POST /api/ops/campaign-review — an operator records that they read an
// account's first campaign (review 2026-10-23, #5c).
//
// The form on /ops posts here: the OPS_KEY, the campaign's id, the
// reviewer's name and the day they read it. A wrong key answers like a
// missing route. The account is the campaign's own (lib/crm/campaign-review),
// never one the form names. Back to /ops after, saying how it went.

import { type NextRequest, NextResponse } from "next/server";
import { secretMatches } from "../../../../lib/core/secret-compare";
import { CampaignReviewError, recordCampaignReview } from "../../../../lib/crm/campaign-review";

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData().catch(() => null);
  const key = form ? field(form, "key") : "";
  if (!form || !secretMatches(key, process.env.OPS_KEY)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const back = (outcome: string) => {
    const url = new URL("/ops", request.nextUrl.origin);
    url.searchParams.set("key", key);
    url.searchParams.set("campaign_review", outcome);
    return NextResponse.redirect(url, 303);
  };
  try {
    await recordCampaignReview({
      proposalId: field(form, "proposal_id"),
      reviewer: field(form, "reviewer"),
      reviewedOn: field(form, "reviewed_on"),
    });
    return back("recorded");
  } catch (error) {
    if (error instanceof CampaignReviewError) return back(error.message);
    console.error(
      JSON.stringify({
        event: "campaign_review_failed",
        account_id: null,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return back("something went wrong on our side");
  }
}
