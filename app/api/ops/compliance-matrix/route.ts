// POST /api/ops/compliance-matrix — an operator changes one country's row in
// the compliance matrix (the v1 build spec §9.2, §9.5; P7-32).
//
// The form on /ops posts here: the OPS_KEY, the operator's name, why, and
// the country's whole row. A wrong key answers like a missing route. The
// matrix module refuses an unblock without counsel's dated sign-off, and the
// table's trigger logs every change with who and why — so the matrix changes
// without a deploy, and never without a record. Back to /ops after.

import { type NextRequest, NextResponse } from "next/server";
import { secretMatches } from "../../../../lib/core/secret-compare";
import { MatrixError, setCountryRule } from "../../../../lib/compliance/matrix";

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};

/** A checkbox: present means on. The form sends every box, so absence means off. */
const ticked = (form: FormData, name: string): boolean => form.get(name) === "on";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData().catch(() => null);
  const key = form ? field(form, "key") : "";
  if (!form || !secretMatches(key, process.env.OPS_KEY)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const back = (outcome: string) => {
    const url = new URL("/ops", request.nextUrl.origin);
    url.searchParams.set("key", key);
    url.searchParams.set("compliance_matrix", outcome);
    url.hash = "ops-matrix-title";
    return NextResponse.redirect(url, 303);
  };
  const regime = field(form, "recording_regime");
  if (regime !== "all_party" && regime !== "single_party") {
    return back("choose all-party or single-party recording");
  }
  try {
    await setCountryRule({
      country: field(form, "country"),
      actor: field(form, "actor"),
      reason: field(form, "reason"),
      change: {
        recording_regime: regime,
        criminal_penalty: ticked(form, "criminal_penalty"),
        outbound_consent_required: ticked(form, "outbound_consent_required"),
        blocked: ticked(form, "blocked"),
        outbound_blocked: ticked(form, "outbound_blocked"),
        execution_halted: ticked(form, "execution_halted"),
        legal_signoff_date: field(form, "legal_signoff_date") || null,
        legal_signoff_reference: field(form, "legal_signoff_reference") || null,
        note: field(form, "note") || null,
      },
    });
    return back("saved");
  } catch (error) {
    if (error instanceof MatrixError) return back(error.message);
    console.error(
      JSON.stringify({
        event: "compliance_matrix_change_failed",
        account_id: null,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return back("something went wrong on our side");
  }
}
