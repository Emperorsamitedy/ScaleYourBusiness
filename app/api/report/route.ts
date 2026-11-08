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
import { requireRole } from "../../../lib/auth/roles";
import type { Access } from "../../../lib/auth/access";
import { factWords, labelFactMap } from "../../../lib/bank/fact-words";
import { loadBankWords } from "../../../lib/bank/words";
import { requestLocale } from "../../../lib/i18n/server";

/**
 * L-3a: the fact map's labels and coded values in the reader's language,
 * from the bank's overlay (lib/bank/fact-words). English names only codes;
 * the report's own text (L-5) and nothing stored is touched.
 */
async function inLanguage<
  T extends {
    fact_map: Record<string, { value: string | null }>;
    data_gaps: { question_id: string; prompt: string }[];
  },
>(report: T): Promise<T> {
  const locale = await requestLocale();
  const words = await loadBankWords(locale);
  // English keeps its own labels and gaps; a coded answer reads as the
  // option the owner chose ("Facebook ads", not "facebook ads").
  if (locale === "en")
    return { ...report, fact_map: labelFactMap(report.fact_map, factWords(words)) };
  return {
    ...report,
    fact_map: labelFactMap(report.fact_map, factWords(words)),
    data_gaps: report.data_gaps.map((g) => ({
      ...g,
      prompt: words.prompt(g.question_id, g.prompt),
    })),
  };
}

async function resolveSession(): Promise<Access | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  return resolveAccess();
}

export async function GET(): Promise<NextResponse> {
  const session = await resolveSession();
  if (!session) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const report = await latestReport(session.profile_id);
    if (!report) return NextResponse.json({ error: "no report yet" }, { status: 404 });
    return NextResponse.json(await inLanguage(report));
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
  const denied = requireRole(session, "report.generate");
  if (denied) return denied;
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
      // L-5: the model writes the report in the generating person's language.
      locale: await requestLocale(),
    });
    return NextResponse.json({ ...(await inLanguage(report)), fresh });
  } catch (error) {
    if (error instanceof DiagnosisError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    // A copy without the AI key (a local demo) can't write a diagnosis.
    // Say so, instead of "something went wrong": nothing was lost.
    if (error instanceof Error && /ANTHROPIC_API_KEY/.test(error.message)) {
      return NextResponse.json(
        {
          error:
            "The diagnosis needs the AI, and it isn't connected on this copy yet. Everything you answered is saved.",
          code: "ai_not_connected",
        },
        { status: 503 },
      );
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
