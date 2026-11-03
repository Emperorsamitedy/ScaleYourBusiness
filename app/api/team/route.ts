// GET /api/team — P5-20, the team cover view (Phase 5 Session E, rule 28).
//
// Behind the one door (lib/auth/access). With the team module off — the
// default — it answers { enabled: false } and reads nothing else: no
// booking, no role, no forecast. Read-only, no model, no network.
//
// L-4c: the reading's sentences are written in the request's language
// (the "teamWords" catalogue); the stored facts stay as they were given.

import { NextResponse } from "next/server";
import { resolveAccess } from "../../../lib/auth/access";
import { logSafeError } from "../../../lib/core/log-safe";
import { requestTr } from "../../../lib/i18n/request-tr";
import { teamCoverage } from "../../../lib/team/coverage";
import { teamView } from "../../../lib/team/load";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const lang = await requestTr("teamWords");
    return NextResponse.json(
      await teamView(access.account_id, access.profile_id, new Date(), teamCoverage, lang),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "team_view_error",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
