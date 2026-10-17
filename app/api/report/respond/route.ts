// POST /api/report/respond — "Look into this" / "Not for us" (P1-38/39).
// Body: { report_id, index, response: "look_into"|"not_for_us", reason? }
// The reason is optional by design — a required field here produces junk
// (UX spec §7) — but when given it is stored verbatim in the decision
// log's payload: it is the training corpus for everything proposed later.

import { logSafeError } from "../../../../lib/core/log-safe";
import { resolveAccess } from "../../../../lib/auth/access";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "../../../../db";
import { businessProfiles } from "../../../../db/schema";
import { DiagnosisError } from "../../../../lib/diagnosis/findings";
import { respondToRecommendation } from "../../../../lib/report/service";

export async function POST(request: NextRequest): Promise<NextResponse> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  const profileId = (await resolveAccess())?.profile_id;
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const [row] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!row) return NextResponse.json({ error: "no intake session" }, { status: 401 });

  let body: { report_id?: unknown; index?: unknown; response?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const reportId = typeof body.report_id === "string" ? body.report_id : "";
  const index = typeof body.index === "number" && Number.isInteger(body.index) ? body.index : -1;
  const response = body.response;
  if (reportId === "" || index < 0 || (response !== "look_into" && response !== "not_for_us")) {
    return NextResponse.json(
      { error: "report_id, index and a valid response are required" },
      { status: 400 },
    );
  }

  try {
    const recommendation = await respondToRecommendation({
      profileId: row.id,
      reportId,
      index,
      response,
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    });
    return NextResponse.json({ recommendation });
  } catch (error) {
    if (error instanceof DiagnosisError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error(JSON.stringify({ event: "report_error", ...logSafeError(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
