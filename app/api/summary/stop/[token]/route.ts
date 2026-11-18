// POST /api/summary/stop/<token> — stop the weekly summary (idea 42, RFC 8058).
//
// The List-Unsubscribe header of every summary points here, with
// List-Unsubscribe-Post: List-Unsubscribe=One-Click, so a mail client's own
// "unsubscribe" POSTs and gets a plain 200. The page's button POSTs here
// too and is sent back to the page, which then says it's done. GET never
// stops anything (a scanner following the link changes nothing): it
// redirects to the page. The signed token alone is the credential; no
// cookie is read or set. Switching it back on is on the Watching screen.

import { type NextRequest, NextResponse } from "next/server";
import { isOneClickPost } from "../../../../../lib/unsubscribe/unsubscribe";
import { STOP_TOKEN_RE, stopSummaries } from "../../../../../lib/summary/prefs";

const pageFor = (request: NextRequest, token: string) =>
  new URL(`/summary/stop/${encodeURIComponent(token)}`, request.nextUrl.origin);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  return NextResponse.redirect(pageFor(request, token), 303);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  const body = await request.text().catch(() => "");
  const oneClick = await isOneClickPost(request.headers.get("content-type"), body);
  if (!STOP_TOKEN_RE.test(token)) {
    return oneClick
      ? new NextResponse("not found", { status: 404 })
      : NextResponse.redirect(pageFor(request, token), 303);
  }
  try {
    const done = await stopSummaries(token);
    if (oneClick) {
      return done === null
        ? new NextResponse("not found", { status: 404 })
        : new NextResponse("stopped", { status: 200 });
    }
    return NextResponse.redirect(pageFor(request, token), 303);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "weekly_summary_stop_failed",
        account_id: null,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return new NextResponse("something went wrong on our side: try the link again", {
      status: 500,
    });
  }
}
