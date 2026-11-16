// POST /api/idea/keep — TASKS-IDEAS I-10: keep a shared idea check as an
// idea business. For the signed-in person only: a NEW account and profile
// for the same verified email, made an idea, then this browser switches
// into it (like POST /api/auth/business). Nothing in the current business
// changes, so no role is needed (the role-wiring test lists it).

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  INTAKE_COOKIE,
  authCookieOptions,
  intakeCookieOptions,
  signProfileCookie,
} from "../../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { currentSession } from "../../../../lib/auth/service";
import { logSafeError } from "../../../../lib/core/log-safe";
import { isAppLocale } from "../../../../lib/i18n/locales";
import { IdeaError } from "../../../../lib/ideas/check";
import { keepIdea } from "../../../../lib/ideas/keep";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "use the form on our page" }, { status: 403 });
  }
  const store = await cookies();
  const token = store.get(AUTH_COOKIE)?.value;
  const session = await currentSession(token);
  if (!session) return NextResponse.json({ error: "sign_in" }, { status: 401 });
  let body: { token?: unknown; locale?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{8,40}$/.test(body.token)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    const next = await keepIdea({
      session,
      currentToken: token,
      token: body.token,
      language: typeof body.locale === "string" && isAppLocale(body.locale) ? body.locale : "en",
    });
    const response = NextResponse.json({ href: "/idea/mine" });
    response.cookies.set(AUTH_COOKIE, next.session_token, authCookieOptions());
    if (next.profile_id) {
      response.cookies.set(
        INTAKE_COOKIE,
        signProfileCookie(next.profile_id),
        intakeCookieOptions(),
      );
    }
    return response;
  } catch (error) {
    if (error instanceof IdeaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "idea_keep_failed",
        account_id: session.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
