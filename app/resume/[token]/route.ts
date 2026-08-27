// GET /resume/<token> — the link an owner clicks a week later, on a
// different phone. Exchanges the token for the profile cookie and drops
// them back into the intake exactly where they stopped.
//
// A bad, expired or revoked link lands on the intake with ?resume=expired
// rather than an error page: the worst case should still be a usable
// product, not a dead end with an apology.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { resolveResumeToken } from "../../../lib/intake/resume";

const COOKIE = "syb_intake_profile";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  const origin = request.nextUrl.origin;

  try {
    const { profile_id } = await resolveResumeToken(token);
    const response = NextResponse.redirect(`${origin}/intake?resume=ok`);
    response.cookies.set(COOKIE, profile_id, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24 * 180,
    });
    return response;
  } catch {
    return NextResponse.redirect(`${origin}/intake?resume=expired`);
  }
}
