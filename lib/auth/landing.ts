// Where a proven sign-in lands, and the cookies it leaves — shared by the
// emailed link (/api/auth/redeem) and the emailed code (/api/auth/redeem-code)
// so the two can never drift apart.
//
// The auth session is the durable identity; the intake cookie is the working
// credential every existing route already reads — re-pointing it at the
// account's profile is what makes sign-in-from-a-new-device just work.

import type { NextResponse } from "next/server";
import { LANGUAGE_COOKIE } from "../i18n/locales";
import { languageCookieOptions } from "../i18n/server";
import {
  AUTH_COOKIE,
  INTAKE_COOKIE,
  authCookieOptions,
  intakeCookieOptions,
  signProfileCookie,
} from "./access";
import { RETURN_COOKIE, isIdeaReturn, returnPath } from "./return-to";
import type { RedeemedSession } from "./service";

/**
 * Pure: the path a sign-in lands on. Idea 52: an email on several
 * businesses' teams is asked which one first. Idea 53: otherwise back to the
 * proposal card the sign-in started from, once; else Home.
 *
 * L8: a sign-in gives a person with no business one, so Home is where a new
 * person lands and the interview is offered there. The one sign-in that
 * makes none is on its way to keeping an idea, and it goes back to the
 * check it came from (TASKS-IDEAS G-3, which a new person never reached).
 * The interview stays the fallback for a session with no business and
 * nowhere to return to.
 */
export function landingPath(session: RedeemedSession, returnCookie: string | undefined): string {
  if (session.choose) return "/login/choose";
  const back = returnPath(returnCookie);
  if (!session.profile_id) return back !== null && isIdeaReturn(back) ? back : "/intake";
  return back ?? "/home";
}

/** Set the signed-in cookies on `response` and clear the one-time return path. */
export function setSignInCookies(response: NextResponse, session: RedeemedSession): NextResponse {
  response.cookies.delete(RETURN_COOKIE);
  response.cookies.set(AUTH_COOKIE, session.session_token, authCookieOptions());
  // L-1: the person's own language follows them to this browser.
  if (session.language) {
    response.cookies.set(LANGUAGE_COOKIE, session.language, languageCookieOptions());
  }
  if (session.profile_id) {
    response.cookies.set(
      INTAKE_COOKIE,
      signProfileCookie(session.profile_id),
      intakeCookieOptions(),
    );
  }
  return response;
}
