// /api/auth/oauth/:provider/callback — the provider comes back.
//
// GET for Google and Microsoft, POST for Apple's form_post. Both
// paths: check the state against its cookie, exchange the code for a
// proven email, and hand that email to the same `signInWithEmail`
// the emailed link uses — then set the same two cookies the redeem
// route sets. One account model, three ways to prove an address.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import {
  exchangeCodeForEmail,
  oauthProvider,
  STATE_COOKIE,
} from "../../../../../../lib/auth/oauth";
import { AuthError, signInWithEmail } from "../../../../../../lib/auth/service";

const INTAKE_COOKIE = "syb_intake_profile";
const AUTH_COOKIE = "syb_session";

async function finish(
  request: NextRequest,
  providerId: string,
  code: string | null,
  state: string | null,
  providerError: string | null,
): Promise<NextResponse> {
  const origin = process.env.APP_URL ?? new URL(request.url).origin;
  const store = await cookies();
  const stateCookie = store.get(STATE_COOKIE)?.value ?? "";
  const [expectedState, from = "/signup"] = stateCookie.split(":");

  const fail = (message: string) =>
    NextResponse.redirect(new URL(`${from}?error=${encodeURIComponent(message)}`, origin));

  try {
    const provider = oauthProvider(providerId);
    if (!provider) return fail("that sign-in isn't connected yet — your email works today.");
    if (providerError === "access_denied" || providerError === "user_cancelled_authorize") {
      return NextResponse.redirect(new URL(from, origin));
    }
    if (providerError) {
      return fail(`${provider.label} sign-in failed — try again or use the email link`);
    }
    if (!code || !state || !expectedState || state !== expectedState) {
      return fail("that sign-in attempt expired — try again");
    }

    const redirectUri = `${origin}/api/auth/oauth/${provider.id}/callback`;
    const email = await exchangeCodeForEmail(provider, code, redirectUri);
    const profileId = store.get(INTAKE_COOKIE)?.value ?? null;
    const session = await signInWithEmail(email, profileId);
    console.log(
      JSON.stringify({
        event: "oauth_signin",
        provider: provider.id,
        account_id: session.account_id,
      }),
    );

    const response = NextResponse.redirect(
      new URL(session.profile_id ? "/profile" : "/intake", origin),
    );
    response.cookies.delete(STATE_COOKIE);
    response.cookies.set(AUTH_COOKIE, session.session_token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 90,
    });
    if (session.profile_id) {
      response.cookies.set(INTAKE_COOKIE, session.profile_id, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    }
    return response;
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message);
    console.error(
      JSON.stringify({
        event: "oauth_callback_failed",
        provider: providerId,
        message: String(error),
      }),
    );
    return fail("something went wrong on our side — the email link still works");
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await params;
  const q = request.nextUrl.searchParams;
  return finish(request, provider, q.get("code"), q.get("state"), q.get("error"));
}

/** Apple's form_post lands here. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await params;
  const form = await request.formData();
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : null;
  };
  return finish(request, provider, field("code"), field("state"), field("error"));
}
