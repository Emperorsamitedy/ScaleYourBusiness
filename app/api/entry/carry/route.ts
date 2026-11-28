// GET /api/entry/carry — writes the free check's answers into the signed-in
// business once, then forgets the result (ux-spec §7.0). Getting started
// sends an owner here when the cookie from "Save this" is present; the
// cookie is cleared whatever happens, so a result is never carried into a
// second business signed in later on the same browser.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { logSafeError } from "../../../../lib/core/log-safe";
import { carryEntryAnswers } from "../../../../lib/journey/carry-entry";
import { ENTRY_COOKIE, isEntryToken } from "../../../../lib/journey/entry-wires";
import { journeyFor } from "../../../../lib/journey/read";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(ENTRY_COOKIE)?.value;
  try {
    const access = await resolveAccess();
    if (access?.session && isEntryToken(token)) {
      const journey = await journeyFor(access.account_id, access.profile_id);
      const interviewDone = journey.steps.find((s) => s.step === "interview")?.done === true;
      // A business already past its questions keeps its own answers.
      if (!interviewDone) await carryEntryAnswers(access.account_id, access.profile_id, token);
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "entry_carry_failed", ...logSafeError(error) }));
  }
  const response = NextResponse.redirect(new URL("/start", request.url), 303);
  response.cookies.delete(ENTRY_COOKIE);
  return response;
}
