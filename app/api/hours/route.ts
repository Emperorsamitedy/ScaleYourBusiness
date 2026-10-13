// GET /api/hours — the trading-hours view (Phase 2 Session F, P2-26..30).
//
// The owner's opening hours as we read them (parsed once from their own
// words, P2-26), the timezone we judge in, and per weekday the measured
// revenue curve with the opening and closing signals (P2-30). Read-only.

import { and, desc, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles, proposals } from "../../../db/schema";
import { HOURS_MODULE, judgeHoursTrial, syncRunningTrials } from "../../../lib/hours/trials";
import { format, money } from "../../../lib/core/money";
import { ensureOpeningSchedule } from "../../../lib/hours/schedule";
import { ensureTimezone, isValidZone, setTimezone } from "../../../lib/hours/timezone";
import { tradingAnalysis } from "../../../lib/hours/trading";

const COOKIE = "syb_intake_profile";

async function resolveProfile(): Promise<string | null> {
  const store = await cookies();
  const profileId = store.get(COOKIE)?.value;
  if (!profileId || !/^[0-9a-f-]{36}$/i.test(profileId)) return null;
  const [row] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return row?.id ?? null;
}

/** POST /api/hours { timezone } — the owner states their zone (multi-zone countries). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { timezone?: unknown };
  if (typeof body.timezone !== "string" || !isValidZone(body.timezone)) {
    return NextResponse.json(
      { error: "timezone must be a timezone name, e.g. America/Chicago" },
      { status: 422 },
    );
  }
  await setTimezone(profileId, body.timezone);
  return NextResponse.json({ timezone: body.timezone });
}

export async function GET(): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    // Parse-once: a model call only the first time the answer is read.
    let schedule = null;
    let scheduleNote: string | null = null;
    try {
      schedule = (await ensureOpeningSchedule(profileId)).schedule;
      if (schedule === null) scheduleNote = "Your opening hours aren't in your profile yet.";
    } catch (error) {
      scheduleNote = "Your opening hours couldn't be read just now.";
      console.error(JSON.stringify({ event: "schedule_parse_failed", message: String(error) }));
    }
    const timezone = await ensureTimezone(profileId);
    await syncRunningTrials(profileId);
    const analysis = await tradingAnalysis(profileId, new Date(), (m, c) => format(money(m, c)));
    // P3-41: the trials proposed from these signals, each with its verdict so far.
    const rows = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.profile_id, profileId), eq(proposals.module, HOURS_MODULE)))
      .orderBy(desc(proposals.created_at));
    const trials = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        summary: (row.action as { summary: string }).summary,
        status: row.status,
        created_at: row.created_at,
        decided_at: row.decided_at,
        verdict:
          row.status === "approved" || row.status === "executed"
            ? await judgeHoursTrial(row)
            : null,
      })),
    );
    return NextResponse.json({ schedule, schedule_note: scheduleNote, timezone, analysis, trials });
  } catch (error) {
    console.error(JSON.stringify({ event: "hours_read_failed", message: String(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
