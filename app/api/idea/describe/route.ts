// POST /api/idea/describe — TASKS-IDEAS I-12: a description of the idea
// in the person's own words, read into the check's answers by Haiku. Public
// (the free check needs no account). Nothing is kept: the answers go back
// to the form to be checked. Each call costs money, so it is capped per
// address per hour AND for everyone per day, the cap protecting the budget.

import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import { withinRateLimit } from "../../../../lib/core/rate-limit";
import { IdeaError } from "../../../../lib/ideas/check";
import {
  MAX_DESCRIPTION_CHARS,
  NO_ACCOUNT,
  describeIdea,
  liveDescribeLlm,
} from "../../../../lib/ideas/describe";

const PER_HOUR = 10;
const ALL_PER_DAY = 300;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "use the form on our page" }, { status: 403 });
  }
  const raw = await request.text();
  if (raw.length > MAX_DESCRIPTION_CHARS * 4) {
    return NextResponse.json({ error: "too large" }, { status: 413 });
  }
  let body: { text?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof body.text !== "string") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const ip =
    request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0] ?? "";
  const who = createHash("sha256").update(`idea-describe:${ip.trim()}`).digest("hex").slice(0, 32);
  if (
    !(await withinRateLimit(`idea-describe:${who}`, PER_HOUR, 3_600_000)) ||
    !(await withinRateLimit("idea-describe:all", ALL_PER_DAY, 86_400_000))
  ) {
    return NextResponse.json({ error: "too_many" }, { status: 429 });
  }
  try {
    const fields = await describeIdea(body.text, liveDescribeLlm(NO_ACCOUNT));
    console.log(
      JSON.stringify({
        event: "idea_described",
        account_id: null,
        filled: Object.keys(fields).length,
      }),
    );
    return NextResponse.json({ fields });
  } catch (error) {
    if (error instanceof IdeaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({ event: "idea_describe_failed", account_id: null, ...logSafeError(error) }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
