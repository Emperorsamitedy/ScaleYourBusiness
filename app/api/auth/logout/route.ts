// POST /api/auth/logout — end this browser's session (the security review of 2026-10-17).
//
// Revokes the session server-side, so a copied cookie stops working too,
// and clears both cookies. Before this there was no way to end a 90-day
// session on a shared or lost device.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  INTAKE_COOKIE,
  authCookieOptions,
  intakeCookieOptions,
} from "../../../../lib/auth/access";
import { revokeSession } from "../../../../lib/auth/service";

export async function POST(): Promise<NextResponse> {
  const store = await cookies();
  try {
    await revokeSession(store.get(AUTH_COOKIE)?.value);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "logout_failed",
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
  const response = NextResponse.json({ signed_out: true });
  response.cookies.set(AUTH_COOKIE, "", { ...authCookieOptions(), maxAge: 0 });
  response.cookies.set(INTAKE_COOKIE, "", { ...intakeCookieOptions(), maxAge: 0 });
  return response;
}
