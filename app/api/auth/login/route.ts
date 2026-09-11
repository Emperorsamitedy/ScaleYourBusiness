// POST /api/auth/login — ask for a sign-in link (P1-49).
//
// Takes an email; sends the link via Resend when configured, otherwise
// returns it for the screen (the resume-link precedent: a visible link
// beats a promised email). Always 200 for a valid email — whether the
// address is known is not something this endpoint reveals.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { sendLoginEmail } from "../../../../lib/auth/email";
import { AuthError, requestLogin } from "../../../../lib/auth/service";
import { ResumeError } from "../../../../lib/intake/resume";

const INTAKE_COOKIE = "syb_intake_profile";

function appUrl(request: NextRequest): string {
  return process.env.APP_URL ?? new URL(request.url).origin;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { email?: unknown };
    if (typeof body.email !== "string") {
      return NextResponse.json({ error: "an email address is needed" }, { status: 422 });
    }
    const store = await cookies();
    const profileId = store.get(INTAKE_COOKIE)?.value ?? null;

    const login = await requestLogin(body.email, profileId);
    const link = `${appUrl(request)}/api/auth/redeem?token=${encodeURIComponent(login.token)}`;
    const sent = await sendLoginEmail({ to: login.email, link });

    return NextResponse.json({
      email: login.email,
      expires_at: login.expires_at,
      delivered_via: sent.delivered_via,
      // Only when no email provider is configured — dev and pilot.
      ...(sent.delivered_via === "screen" ? { link } : {}),
    });
  } catch (error) {
    if (error instanceof AuthError || error instanceof ResumeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(JSON.stringify({ event: "login_request_failed", message: String(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
