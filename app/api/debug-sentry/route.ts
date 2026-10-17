// P0-07b's acceptance test: a deliberate exception, throwable on demand
// but only with the shared secret — a stranger cannot spam our quota.
// GET /api/debug-sentry?key=<SENTRY_TEST_KEY> throws; anything else 404s.

import { secretMatches } from "../../../lib/core/secret-compare";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function GET(request: NextRequest): NextResponse {
  const expected = process.env.SENTRY_TEST_KEY;
  const given = request.nextUrl.searchParams.get("key");
  if (!secretMatches(given, expected)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  throw new Error(`P0-07b deliberate test exception · ${new Date().toISOString()}`);
}
