// POST /api/auth/login — ask for a sign-in link (P1-49).
//
// Takes an email; sends the link via Resend when configured, otherwise
// returns it for the screen (the resume-link precedent: a visible link
// beats a promised email). Always 200 for a valid email — whether the
// address is known is not something this endpoint reveals.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { INTAKE_COOKIE, claimableProfile } from "../../../../lib/auth/access";
import { RETURN_COOKIE, returnCookieOptions, returnPath } from "../../../../lib/auth/return-to";
import { sendLoginEmail } from "../../../../lib/auth/email";
import { AuthError, requestLogin } from "../../../../lib/auth/service";
import { CURRENCY_COOKIE, LANGUAGE_COOKIE } from "../../../../lib/i18n/locales";
import { ResumeError } from "../../../../lib/intake/resume";

function appUrl(request: NextRequest): string {
  return process.env.APP_URL || new URL(request.url).origin;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { email?: unknown; next?: unknown };
    if (typeof body.email !== "string") {
      return NextResponse.json({ error: "an email address is needed" }, { status: 422 });
    }
    const store = await cookies();
    // Only a profile nobody owns yet can be claimed by a sign-in.
    const profileId = await claimableProfile(store.get(INTAKE_COOKIE)?.value);

    // L-1: the first step's language and currency travel with the link.
    const login = await requestLogin(body.email, profileId, null, {
      language: store.get(LANGUAGE_COOKIE)?.value,
      currency: store.get(CURRENCY_COOKIE)?.value,
    });
    const link = `${appUrl(request)}/api/auth/redeem?token=${encodeURIComponent(login.token)}`;
    const sent = await sendLoginEmail({ to: login.email, link });
    if (sent.delivered_via === "failed") {
      return NextResponse.json(
        { error: "I couldn't send the sign-in email just now — try again in a minute." },
        { status: 503 },
      );
    }

    const response = NextResponse.json({
      email: login.email,
      expires_at: login.expires_at,
      delivered_via: sent.delivered_via,
      // Only in local development with no email provider configured.
      ...(sent.delivered_via === "screen" ? { link } : {}),
    });
    // Idea 53: a sign-in started from a proposal's card comes back to it.
    const back = returnPath(body.next);
    if (back) response.cookies.set(RETURN_COOKIE, back, returnCookieOptions());
    return response;
  } catch (error) {
    if (error instanceof AuthError || error instanceof ResumeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // The error's name only: a database error's message carries the query's values (the email).
    console.error(
      JSON.stringify({
        event: "login_request_failed",
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
