// GET /api/stock/po/:id — a purchase order as a document (P6-04).
//
// The order the owner made (and approved, or not yet), laid out as a
// printable page in the business's language: what they download, keep,
// print or save as a PDF from the browser. With ?download=1 it comes as a
// file. Read-only, behind the one door (lib/auth/access), and only the
// caller's own business's order: a foreign id is "no such order" (404).

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { logSafeError } from "../../../../../lib/core/log-safe";
import { wordsFor } from "../../../../../lib/i18n/recipient";
import { poDocument } from "../../../../../lib/purchasing/po";
import { PO_WORDS, poForDocument } from "../../../../../lib/purchasing/send";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "no such order" }, { status: 404 });
  try {
    const found = await poForDocument(access.profile_id, id);
    if (!found) return NextResponse.json({ error: "no such order" }, { status: 404 });
    const html = poDocument(found.po, await wordsFor(found.locale, PO_WORDS), found.status);
    const download = request.nextUrl.searchParams.get("download") === "1";
    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        // The page carries no script and loads nothing from anywhere else.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "X-Content-Type-Options": "nosniff",
        ...(download
          ? { "Content-Disposition": `attachment; filename="${found.po.number}.html"` }
          : {}),
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "purchase_order_document_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
