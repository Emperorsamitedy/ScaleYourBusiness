// POST /api/ops/law-review — an operator records the email-law review (P4-15).
//
// The form on /ops posts here: the OPS_KEY, the reviewer's name, the day
// they reviewed it, an optional note, and the sha256 of the table they were
// SHOWN. A wrong key answers like a missing route. A table that changed
// since the page was opened is refused (lib/crm/law-review), so a review
// can only ever vouch for the rules its reviewer read. Back to /ops after.

import { type NextRequest, NextResponse } from "next/server";
import { secretMatches } from "../../../../lib/core/secret-compare";
import { LawReviewError, recordLawReview } from "../../../../lib/crm/law-review";

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
    url.searchParams.set("law_review", outcome);
    return NextResponse.redirect(url, 303);
  };
  try {
    await recordLawReview({
      reviewer: field(form, "reviewer"),
      reviewedOn: field(form, "reviewed_on"),
      tableSha256: field(form, "table_sha256"),
      note: field(form, "note"),
    });
    return back("recorded");
  } catch (error) {
    if (error instanceof LawReviewError) return back(error.message);
    console.error(
      JSON.stringify({
        event: "law_review_failed",
        account_id: null,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return back("something went wrong on our side");
  }
}
