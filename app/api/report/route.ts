// The report API — Session G.
//
//   GET  /api/report   the latest report, or 404 when none exists yet
//   POST /api/report   generate — returns the existing report unchanged
//                      when the profile has not moved (the cost guard)
//
// Session-scoped like everything else; the intake cookie is the identity.

import { logSafeError } from "../../../lib/core/log-safe";
import { resolveAccess } from "../../../lib/auth/access";
import { NextResponse } from "next/server";
import { DiagnosisError } from "../../../lib/diagnosis/findings";
import { hasPaidReport, paymentsConfigured } from "../../../lib/payments/stripe";
import { generateReport, latestReport } from "../../../lib/report/service";

async function resolveSession(): Promise<{ account_id: string; profile_id: string } | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  const access = await resolveAccess();
  return access ? { profile_id: access.profile_id, account_id: access.account_id } : null;
}

export async function GET(): Promise<NextResponse> {
  const session = await resolveSession();
  if (!session) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const report = await latestReport(session.profile_id);
    if (!report) return NextResponse.json({ error: "no report yet" }, { status: 404 });
    return NextResponse.json(report);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "report_error",
        account_id: session.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

export async function POST(): Promise<NextResponse> {
  const session = await resolveSession();
  if (!session) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    // The payment gate (P1-50). Armed only when Stripe is configured, so
    // an environment without keys behaves exactly as before — logged, so
    // nobody mistakes an unarmed gate for a passed one. A profile that
    // already has a report keeps access to it (the cost guard returns the
    // existing one); what payment buys is the expensive generation.
    if (paymentsConfigured()) {
      const paid = await hasPaidReport(session.profile_id);
      const existing = await latestReport(session.profile_id);
      if (!paid && !existing) {
        return NextResponse.json(
          { error: "the report needs to be paid for first", payment_required: true },
          { status: 402 },
        );
      }
    } else {
      console.log(JSON.stringify({ event: "report_gate_unarmed", account_id: session.account_id }));
    }
    const { report, fresh } = await generateReport({
      accountId: session.account_id,
      profileId: session.profile_id,
    });
    return NextResponse.json({ ...report, fresh });
  } catch (error) {
    if (error instanceof DiagnosisError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error(
      JSON.stringify({
        event: "report_error",
        account_id: session.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
