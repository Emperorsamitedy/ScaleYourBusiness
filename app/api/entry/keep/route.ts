// GET /api/entry/keep?token= — "Save this and get your full diagnosis" on
// the free check's result (ux-spec §7.0). Remembers which result for an
// hour, then opens Create account; Getting started writes its answers into
// the new business (lib/journey/carry-entry). The token is the result's
// own share token: unguessable, and naming nothing but six answers.

import { type NextRequest, NextResponse } from "next/server";
import {
  ENTRY_COOKIE,
  ENTRY_COOKIE_SECONDS,
  isEntryToken,
} from "../../../../lib/journey/entry-wires";

export function GET(request: NextRequest): NextResponse {
  const token = request.nextUrl.searchParams.get("token");
  const response = NextResponse.redirect(new URL("/signup", request.url), 303);
  if (isEntryToken(token)) {
    response.cookies.set(ENTRY_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: ENTRY_COOKIE_SECONDS,
    });
  }
  return response;
}
