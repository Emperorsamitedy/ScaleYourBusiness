// POST /api/u/<token> — unsubscribe, now and for good (P4-15, rule 23, RFC 8058).
//
// The List-Unsubscribe header in every campaign email points here, with
// List-Unsubscribe-Post: List-Unsubscribe=One-Click, so a mail client's own
// "unsubscribe" button POSTs "List-Unsubscribe=One-Click" and gets a plain
// 200 without anyone visiting a page. The page's button POSTs here too and
// is sent back to the page, which then says it's done.
//
// GET never unsubscribes (a scanner following the header's URL changes
// nothing): it redirects to the page, which shows one button.
//
// The token alone is the credential. No cookie is read or set.

import { type NextRequest, NextResponse } from "next/server";
import { TOKEN_RE, unsubscribe } from "../../../../lib/unsubscribe/unsubscribe";

const pageFor = (request: NextRequest, token: string) =>
  new URL(`/u/${encodeURIComponent(token)}`, request.nextUrl.origin);

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
  const oneClick = /(^|&)List-Unsubscribe=One-Click(&|$)/.test(body.trim());
  if (!TOKEN_RE.test(token)) {
    return oneClick
      ? new NextResponse("not found", { status: 404 })
      : NextResponse.redirect(pageFor(request, token), 303);
  }
  try {
    const view = await unsubscribe(token);
    if (oneClick) {
      return view === null
        ? new NextResponse("not found", { status: 404 })
        : new NextResponse("unsubscribed", { status: 200 });
    }
    return NextResponse.redirect(pageFor(request, token), 303);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "unsubscribe_failed",
        account_id: null,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return new NextResponse("something went wrong on our side — try the link again", {
      status: 500,
    });
  }
}
