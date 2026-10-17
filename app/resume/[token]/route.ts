// GET /resume/<token> — the link an owner clicks a week later, on a
// different phone. Exchanges the token for the profile cookie and drops
// them back into the intake exactly where they stopped.
//
// A bad, expired or revoked link lands on the intake with ?resume=expired
// rather than an error page: the worst case should still be a usable
// product, not a dead end with an apology.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { INTAKE_COOKIE, intakeCookieOptions, signProfileCookie } from "../../../lib/auth/access";
import { resolveResumeToken } from "../../../lib/intake/resume";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  const origin = request.nextUrl.origin;

  try {
    const { profile_id } = await resolveResumeToken(token);
    const response = NextResponse.redirect(`${origin}/intake?resume=ok`);
    // Signed like every intake cookie; an owned profile still needs its owner's sign-in.
    response.cookies.set(
      INTAKE_COOKIE,
      signProfileCookie(profile_id),
      intakeCookieOptions(60 * 60 * 24 * 180),
    );
    return response;
  } catch {
    return NextResponse.redirect(`${origin}/intake?resume=expired`);
  }
}
