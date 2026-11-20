// Module selection — Session H (P1-48).
//
//   GET /api/modules   the five selectable modules + analytics (fixed),
//                      and P5-18's team switch (off by default, rule 28)
//   PUT /api/modules   { module, enabled } — analytics is not a module
//                      here and cannot be sent, so it cannot be disabled.

import { resolveAccess } from "../../../lib/auth/access";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { accountModules } from "../../../db/schema";
import { TEAM_DEFAULT_ON, TEAM_MODULE, TEAM_WHY } from "../../../lib/team/module";
import { requireRole } from "../../../lib/auth/roles";

/**
 * The Phase 2+ modules an owner can opt into ahead of time, and P5-18's
 * team module (rule 28), which is the one that starts OFF.
 */
export const SELECTABLE_MODULES = [
  "marketing",
  "sales",
  "support",
  "operations",
  "finance",
  TEAM_MODULE,
] as const;

type SelectableModule = (typeof SELECTABLE_MODULES)[number];

/** What a module is when the owner has never touched its switch. */
const DEFAULT_ON: Record<SelectableModule, boolean> = {
  marketing: true,
  sales: true,
  support: true,
  operations: true,
  finance: true,
  [TEAM_MODULE]: TEAM_DEFAULT_ON,
};

/** The line beside a switch whose meaning isn't "for when I start acting". */
const WHY: Partial<Record<SelectableModule, string>> = { [TEAM_MODULE]: TEAM_WHY };

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
    modules: SELECTABLE_MODULES.map((m) => ({
      module: m,
      enabled: byModule.get(m) ?? DEFAULT_ON[m],
      ...(WHY[m] ? { why: WHY[m] } : {}),
    })),
    // Not togglable, and the reason is part of the payload so the UI
    // never has to invent the explanation.
    analytics: {
      enabled: true,
      fixed: true,
      why: "The watching mode is blind without measurement: analytics is what it watches with.",
    },
  });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  const accountId = access?.account_id ?? null;
  if (!accountId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "rules.manage");
  if (denied) return denied;
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
