// The weekly summary's switch — idea 42, and its channel — P6-07.
//
//   GET /api/summary   { enabled, owner, in_care, sending, configured, last_sent_at,
//                        channel, whatsapp }
//   PUT /api/summary   { enabled } and/or { channel: "email" | "whatsapp" | "both" }
//
// Behind the one door (lib/auth/access). An account with no owner yet has
// no address to email, so there is nothing to switch: the PUT says so. The
// WhatsApp yes itself is /api/summary/whatsapp. The number is never
// returned whole: the screen shows its last three digits.

import { and, desc, eq, or, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { modeDecisions, weeklySummaries } from "../../../db/schema";
import { resolveAccess } from "../../../lib/auth/access";
import { ownerEmailConfigured } from "../../../lib/auth/email";
import { appUrl, whatsappMissing } from "../../../lib/env";
import {
  accountOwner,
  isSummaryChannel,
  setSummaryChannel,
  setSummaryPref,
  summaryChannel,
  summaryOn,
  summaryPref,
} from "../../../lib/summary/prefs";
import { maskNumber } from "../../../lib/summary/whatsapp";
import { liveOptin } from "../../../lib/summary/whatsapp-optin";
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
      and(
        eq(weeklySummaries.account_id, access.account_id),
        or(eq(weeklySummaries.status, "sent"), eq(weeklySummaries.whatsapp_status, "sent")),
      ),
    )
    .orderBy(desc(weeklySummaries.created_at))
    .limit(1);
  const pref = owner ? summaryPref(owner.prefs) : null;
  const optin = owner ? await liveOptin(owner.id) : null;
  return NextResponse.json({
    // The switch as the owner sees it: on unless they turned it off.
    enabled: owner !== null && pref !== false,
    owner: owner !== null,
    in_care: inCare,
    sending: owner !== null && summaryOn(pref, inCare),
    // Whether this server can send email at all — the screen says so rather than promise one.
    configured: ownerEmailConfigured() && appUrl() !== null,
    last_sent_at: last?.at ?? null,
    channel: owner ? summaryChannel(owner.prefs) : "email",
    whatsapp: {
      // The setting names only, never a value: the screen says what's needed.
      missing: [...whatsappMissing(), ...(appUrl() === null ? ["APP_URL"] : [])],
      opted_in: optin !== null,
      number: optin ? maskNumber(optin.phone_number) : null,
      opted_in_at: optin?.opted_in_at ?? null,
      // The yes is the recipient's own: only the owner the summary goes to can give it.
      yours: owner !== null && access.session?.user_id === owner.id,
    },
  });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "summary.settings");
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as {
    enabled?: unknown;
    channel?: unknown;
  };
  if (body.channel !== undefined && !isSummaryChannel(body.channel)) {
    return NextResponse.json({ error: "channel must be email, whatsapp or both" }, { status: 422 });
  }
  if (typeof body.enabled !== "boolean" && body.channel === undefined) {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 422 });
  }
  const owner = await accountOwner(access.account_id);
  if (!owner) {
    return NextResponse.json(
      { error: "sign up first: the summary goes to the address you sign in with" },
      { status: 409 },
    );
  }
  if (typeof body.enabled === "boolean") {
    await setSummaryPref(owner.id, body.enabled);
    console.log(
      JSON.stringify({
        event: "weekly_summary_switched",
        account_id: access.account_id,
        on: body.enabled,
        via: "screen",
      }),
    );
  }
  if (isSummaryChannel(body.channel)) {
    await setSummaryChannel(owner.id, body.channel);
    console.log(
      JSON.stringify({
        event: "weekly_summary_channel",
        account_id: access.account_id,
        channel: body.channel,
      }),
    );
  }
  return NextResponse.json({
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    ...(isSummaryChannel(body.channel) ? { channel: body.channel } : {}),
  });
}
