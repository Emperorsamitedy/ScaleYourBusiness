// POST /api/idea/interest — gap 5 (TASKS-IDEAS): a visitor to a test page
// says "I'd buy this at this price". Public, same-origin, capped per
// address; recorded once per visitor as an HMAC, never the address itself.

import { type NextRequest, NextResponse } from "next/server";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import { withinRateLimit } from "../../../../lib/core/rate-limit";
import { pageBySlug, recordTestEvent, visitorOf } from "../../../../lib/ideas/testpage";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "use the page" }, { status: 403 });
  }
  let body: { slug?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof body.slug !== "string")
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const found = await pageBySlug(body.slug);
    if (!found || !found.open) return NextResponse.json({ error: "not found" }, { status: 404 });
    const address =
      request.headers.get("x-real-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0] ??
      "";
    const visitor = visitorOf(
      found.page.slug,
      address.trim(),
      request.headers.get("user-agent") ?? "",
    );
    if (!(await withinRateLimit(`idea-interest:${visitor}`, 10, 3_600_000))) {
      return NextResponse.json({ error: "too_many" }, { status: 429 });
    }
    await recordTestEvent({ page: found.page, kind: "interest", visitor });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(
      JSON.stringify({ event: "idea_interest_failed", account_id: null, ...logSafeError(error) }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
