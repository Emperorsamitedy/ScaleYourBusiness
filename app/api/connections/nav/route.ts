// /api/connections/nav — NAV Online Számla for this business (the
// multi-market spec §E.4, §E.5).
//
//   POST    { login, password, signature_key, tax_number }: prove the
//           technical user with NAV at once, then store it sealed under
//           the business's own key; answers with NAV's name for the business
//   DELETE  one-tap revocation: the stored credentials are deleted now, and
//           the answer says, in Hungarian, to delete the technical user on
//           NAV's side too
//
// Signed in, from SYB's own pages, by someone who manages connections. The
// request body holds credentials, so nothing here logs it, and every error
// is a fixed sentence — never NAV's own message, never the input.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { requireRole } from "../../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { currentSession } from "../../../../lib/auth/service";
import { withinRateLimit } from "../../../../lib/core/rate-limit";
import { NavServiceError, connectNav, revokeNav } from "../../../../lib/connectors/nav/service";

const AUTH_COOKIE = "syb_session";
/** Each attempt is a call to NAV with a password: a few an hour per account. */
const CONNECT_LIMIT_PER_HOUR = 5;

async function signedIn() {
  const store = await cookies();
  return currentSession(store.get(AUTH_COOKIE)?.value);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "that has to come from ScaleX itself" }, { status: 403 });
  }
  const session = await signedIn();
  if (!session)
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  const denied = requireRole(session, "connections.manage");
  if (denied) return denied;
  if (
    !(await withinRateLimit(`nav-connect:${session.account_id}`, CONNECT_LIMIT_PER_HOUR, 3_600_000))
  ) {
    return NextResponse.json(
      {
        error: "too many attempts — try again in an hour",
        error_hu: "Túl sok próbálkozás — próbálja újra egy óra múlva.",
      },
      { status: 429 },
    );
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const field = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : "");
  try {
    const result = await connectNav(session.account_id, {
      login: field("login"),
      password: field("password"),
      signatureKey: field("signature_key"),
      taxNumber: field("tax_number"),
    });
    console.log(
      JSON.stringify({
        event: "nav_connected",
        account_id: session.account_id,
        connection_id: result.connection_id,
      }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof NavServiceError) {
      return NextResponse.json(
        { error: error.message, error_hu: error.hu },
        { status: error.status },
      );
    }
    console.error(
      JSON.stringify({
        event: "nav_connect_failed",
        account_id: session.account_id,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "that has to come from ScaleX itself" }, { status: 403 });
  }
  const session = await signedIn();
  if (!session)
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  const denied = requireRole(session, "connections.manage");
  if (denied) return denied;
  const result = await revokeNav(session.account_id);
  console.log(
    JSON.stringify({
      event: "nav_revoked",
      account_id: session.account_id,
      revoked: result.revoked,
    }),
  );
  return NextResponse.json(result);
}
