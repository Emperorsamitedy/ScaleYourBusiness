// The weekly summary's switch — idea 42.
//
//   GET /api/summary   { enabled, owner, in_care, sending, configured, last_sent_at }
//   PUT /api/summary   { enabled } — the owner's own notification_prefs
//
// Behind the one door (lib/auth/access). An account with no owner yet has
// no address to email, so there is nothing to switch: the PUT says so.

import { and, desc, eq, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { modeDecisions, weeklySummaries } from "../../../db/schema";
import { resolveAccess } from "../../../lib/auth/access";
import { ownerEmailConfigured } from "../../../lib/auth/email";
import { appUrl } from "../../../lib/env";
import { accountOwner, setSummaryPref, summaryOn, summaryPref } from "../../../lib/summary/prefs";
import { requireRole } from "../../../lib/auth/roles";

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const owner = await accountOwner(access.account_id);
  const [decided] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(modeDecisions)
    .where(eq(modeDecisions.profile_id, access.profile_id));
  const inCare = Number(decided?.n ?? 0) > 0;
  const [last] = await db
    .select({ at: weeklySummaries.settled_at })
    .from(weeklySummaries)
    .where(
      and(eq(weeklySummaries.account_id, access.account_id), eq(weeklySummaries.status, "sent")),
    )
    .orderBy(desc(weeklySummaries.created_at))
    .limit(1);
  const pref = owner ? summaryPref(owner.prefs) : null;
  return NextResponse.json({
    // The switch as the owner sees it: on unless they turned it off.
    enabled: owner !== null && pref !== false,
    owner: owner !== null,
    in_care: inCare,
    sending: owner !== null && summaryOn(pref, inCare),
    // Whether this server can send email at all — the screen says so rather than promise one.
    configured: ownerEmailConfigured() && appUrl() !== null,
    last_sent_at: last?.at ?? null,
  });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "summary.settings");
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 422 });
  }
  const owner = await accountOwner(access.account_id);
  if (!owner) {
    return NextResponse.json(
      { error: "sign up first: the summary goes to the address you sign in with" },
      { status: 409 },
    );
  }
  await setSummaryPref(owner.id, body.enabled);
  console.log(
    JSON.stringify({
      event: "weekly_summary_switched",
      account_id: access.account_id,
      on: body.enabled,
      via: "screen",
    }),
  );
  return NextResponse.json({ enabled: body.enabled });
}
