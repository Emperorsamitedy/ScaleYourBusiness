// Module selection — Session H (P1-48).
//
//   GET /api/modules   the five selectable modules + analytics (fixed)
//   PUT /api/modules   { module, enabled } — analytics is not a module
//                      here and cannot be sent, so it cannot be disabled.

import { resolveAccess } from "../../../lib/auth/access";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { accountModules } from "../../../db/schema";

/** The Phase 2+ modules an owner can opt into ahead of time. */
export const SELECTABLE_MODULES = [
  "marketing",
  "sales",
  "support",
  "operations",
  "finance",
] as const;

async function resolveAccount(): Promise<string | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  return (await resolveAccess())?.account_id ?? null;
}

export async function GET(): Promise<NextResponse> {
  const accountId = await resolveAccount();
  if (!accountId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const rows = await db
    .select()
    .from(accountModules)
    .where(eq(accountModules.account_id, accountId));
  const byModule = new Map(rows.map((r) => [r.module, r.enabled]));
  return NextResponse.json({
    modules: SELECTABLE_MODULES.map((m) => ({ module: m, enabled: byModule.get(m) ?? true })),
    // Not togglable, and the reason is part of the payload so the UI
    // never has to invent the explanation.
    analytics: {
      enabled: true,
      fixed: true,
      why: "The watching mode is blind without measurement — analytics is what it watches with.",
    },
  });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const accountId = await resolveAccount();
  if (!accountId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const body = (await request.json()) as { module?: unknown; enabled?: unknown };
  const module = body.module;
  if (typeof module !== "string" || !SELECTABLE_MODULES.includes(module as never)) {
    // "analytics" lands here too, deliberately: it is not selectable.
    return NextResponse.json({ error: "not a selectable module" }, { status: 422 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 422 });
  }
  await db
    .insert(accountModules)
    .values({ account_id: accountId, module, enabled: body.enabled })
    .onConflictDoUpdate({
      target: [accountModules.account_id, accountModules.module],
      set: { enabled: body.enabled, updated_at: new Date().toISOString() },
    });
  return NextResponse.json({ module, enabled: body.enabled });
}
