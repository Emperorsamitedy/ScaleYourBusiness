// POST /api/idea — the idea check (TASKS-IDEAS.md). Public: no account, no
// session. The answers in, the worked result and its share token out, in
// milliseconds (no model is called). Same-origin only, and capped per
// address per hour; the address is used for the cap only, hashed, never
// stored with the check.

import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { logSafeError } from "../../../lib/core/log-safe";
import { withinRateLimit } from "../../../lib/core/rate-limit";
import { BENCH_WORDS } from "../../../lib/benchmarks/map";
import { isAppLocale } from "../../../lib/i18n/locales";
import { requestWords } from "../../../lib/i18n/request-words";
import { IdeaError, runIdea } from "../../../lib/ideas/check";

const PER_HOUR = 30;
const MAX_BODY_BYTES = 4 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "use the form on our page" }, { status: 403 });
  }
  const ip =
    request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0] ?? "";
  const who = createHash("sha256").update(`idea:${ip.trim()}`).digest("hex").slice(0, 32);
  if (!(await withinRateLimit(`idea:${who}`, PER_HOUR, 3_600_000))) {
    return NextResponse.json({ error: "too_many" }, { status: 429 });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES)
    return NextResponse.json({ error: "too large" }, { status: 413 });
  let body: { answers?: unknown; locale?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const locale = typeof body.locale === "string" && isAppLocale(body.locale) ? body.locale : "en";
  try {
    const out = await runIdea({
      answers: body.answers,
      locale,
      words: await requestWords(BENCH_WORDS, locale),
    });
    console.log(
      JSON.stringify({
        event: "idea_result",
        account_id: null,
        status: out.result.status,
        money: out.result.status === "worked" ? out.result.money.status : null,
        survival: out.result.status === "worked" ? out.result.survival.status : null,
      }),
    );
    return NextResponse.json(out);
  } catch (error) {
    if (error instanceof IdeaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({ event: "idea_failed", account_id: null, ...logSafeError(error) }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
