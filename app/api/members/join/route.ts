// POST /api/members/join { token } — accept an invite (idea 52, I-52.4).
//
// Called from the invite page (/invite), same-origin only. The token says
// WHICH invite; it never says who you are. So:
//
//   · signed in as exactly the invited address → you join now: a users
//     row in that business with the invite's role, a session for it (this
//     browser's old session is retired, as a switch does), logged team_join;
//   · signed in as anybody else → refused, and nothing joins;
//   · not signed in → a sign-in link goes to the INVITED address (never one
//     the request names), carrying the invite; redeeming it joins. With no
//     email set up, development shows that sign-in link on screen, exactly
//     as /login does — production never does (lib/auth/email).
//
// The joiner isn't on the team yet, so there's no role to check: the
// role-wiring test lists this route as an identity route.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  INTAKE_COOKIE,
  authCookieOptions,
  intakeCookieOptions,
  signProfileCookie,
} from "../../../../lib/auth/access";
import { sendLoginEmail } from "../../../../lib/auth/email";
import { TeamError, joinWithSession, peekInvite } from "../../../../lib/auth/members";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { currentSession, requestLogin, revokeSession } from "../../../../lib/auth/service";
import { logSafeError } from "../../../../lib/core/log-safe";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = appOriginOf(request.url);
  if (!isSameOriginPost(request.headers, origin)) {
    return NextResponse.json({ error: "accept the invite on our own page" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as { token?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  try {
    const invite = await peekInvite(token);
    if (!invite || invite.status !== "pending") {
      return NextResponse.json(
        { error: "that invite is no longer open — ask for a new one" },
        { status: 410 },
      );
    }
    const store = await cookies();
    const current = store.get(AUTH_COOKIE)?.value;
    const session = await currentSession(current);

    if (session) {
      if (session.email !== invite.email) {
        return NextResponse.json(
          {
            error: `This invite is for ${invite.email}, and you're signed in as ${session.email}. Sign out first, then open the invite again.`,
          },
          { status: 403 },
        );
      }
      const joined = await joinWithSession(token, session);
      if (joined.user_id !== session.user_id) await revokeSession(current);
      const response = NextResponse.json({ joined: true, redirect: "/profile" });
      response.cookies.set(AUTH_COOKIE, joined.session_token, authCookieOptions());
      if (joined.profile_id) {
        response.cookies.set(
          INTAKE_COOKIE,
          signProfileCookie(joined.profile_id),
          intakeCookieOptions(),
        );
      }
      return response;
    }

    const login = await requestLogin(invite.email, null, invite.invite_id);
    const link = `${origin}/api/auth/redeem?token=${encodeURIComponent(login.token)}`;
    const sent = await sendLoginEmail({ to: login.email, link });
    if (sent.delivered_via === "failed") {
      return NextResponse.json(
        { error: "I couldn't send the sign-in email just now — try again in a minute." },
        { status: 503 },
      );
    }
    return NextResponse.json({
      sent: true,
      delivered_via: sent.delivered_via,
      // Only in local development with no email provider configured.
      ...(sent.delivered_via === "screen" ? { link } : {}),
    });
  } catch (error) {
    if (error instanceof TeamError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(JSON.stringify({ event: "invite_join_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
