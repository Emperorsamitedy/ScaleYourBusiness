// /resume/<token> — the link an owner clicks a week later, on a
// different phone. It drops them back into the intake exactly where they
// stopped.
//
// GET only asks (login CSRF, security audit 2026-10-17): it sends the
// browser to /resume?token=…, a page that says which interview the link
// opens. Only that page's POST, from our own origin, switches this
// browser to it — otherwise any site could quietly point a visitor's
// browser at an interview someone else can read.
//
// A bad, expired or revoked link lands on the intake with ?resume=expired
// rather than an error page: the worst case should still be a usable
// product, not a dead end with an apology.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { INTAKE_COOKIE, intakeCookieOptions, signProfileCookie } from "../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { resolveResumeToken } from "../../../lib/intake/resume";

type Context = { params: Promise<{ token: string }> };

export async function GET(request: NextRequest, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  const confirm = new URL("/resume", appOriginOf(request.url));
  confirm.searchParams.set("token", token);
  return NextResponse.redirect(confirm, 303);
}

export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  const origin = appOriginOf(request.url);
  if (!isSameOriginPost(request.headers, origin)) {
    console.warn(JSON.stringify({ event: "resume_cross_site_refused" }));
    return NextResponse.redirect(`${origin}/intake?resume=expired`, 303);
  }
  try {
    const { profile_id } = await resolveResumeToken(token);
    const response = NextResponse.redirect(`${origin}/intake?resume=ok`, 303);
    // Signed like every intake cookie; an owned profile still needs its owner's sign-in.
    response.cookies.set(
      INTAKE_COOKIE,
      signProfileCookie(profile_id),
      intakeCookieOptions(60 * 60 * 24 * 180),
    );
    return response;
  } catch {
    return NextResponse.redirect(`${origin}/intake?resume=expired`, 303);
  }
}
