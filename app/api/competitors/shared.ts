// Shared by the /api/competitors routes: the one door, and errors in words.

import { NextResponse } from "next/server";
import type { Access } from "../../../lib/auth/access";
import { resolveAccess } from "../../../lib/auth/access";
import { logSafeError } from "../../../lib/core/log-safe";
import { CompetitorError } from "../../../lib/competitors/service";

export async function session(): Promise<Access | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  // The whole access, so the routes can check the role (idea 52).
  return resolveAccess();
}

export const signedOut = () => NextResponse.json({ error: "no intake session" }, { status: 401 });

export async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function failure(error: unknown, accountId: string, event: string): NextResponse {
  if (error instanceof CompetitorError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ event, account_id: accountId, ...logSafeError(error) }));
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}
