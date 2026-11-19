// Competitors' hours — P2-31 (Phase 2 Session F).
//
// Competitor research (P1-15..21) now records each competitor's opening
// hours as their own pages state them (competitors.<id>.opening_hours,
// research confidence 0.5, `unknown` when not stated — never guessed).
// Those words are parsed into a schedule the same way, once, as the
// owner's (lib/hours/schedule), and compared weekday by weekday: "2 of
// the 3 competitors whose hours we found open by 18:00 on Fridays".
//
// The parse is the only model call, and only for hours not yet parsed.
// The comparison reads stored schedules and calls nothing.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { competitors } from "../../db/schema";
import { readCurrentField } from "../profile/field-store";
import type { OpeningSchedule, ScheduleLlm, Weekday } from "./schedule";
import { ensureOpeningSchedule, liveScheduleLlm, openSpan } from "./schedule";

const hoursKey = (id: string) => `competitors.${id}.opening_hours`;
const scheduleKey = (id: string) => `competitors.${id}.opening_schedule`;

/** Parse every researched competitor's stated hours not yet parsed. */
export async function parseCompetitorHours(
  profileId: string,
  llm: ScheduleLlm = liveScheduleLlm,
): Promise<{ parsed: number; reused: number }> {
  const rows = await db
    .select({ id: competitors.id })
    .from(competitors)
    .where(eq(competitors.profile_id, profileId));
  let parsed = 0;
  let reused = 0;
  for (const { id } of rows) {
    const out = await ensureOpeningSchedule(profileId, llm, {
      hours: hoursKey(id),
      schedule: scheduleKey(id),
    });
    if (out.via === "parsed") parsed++;
    if (out.via === "reused") reused++;
  }
  return { parsed, reused };
}

export interface CompetitorOpening {
  /** Competitors with a parsed schedule that states this weekday. */
  known: number;
  /** First open hour (trading-day hour) of each that opens that day. */
  opens: number[];
  /** How many of the known are closed that day. */
  closed: number;
}

/** Per weekday, when the competitors whose hours we found open. Reads only. */
export async function competitorOpenings(
  profileId: string,
): Promise<Map<Weekday, CompetitorOpening>> {
  const rows = await db
    .select({ id: competitors.id })
    .from(competitors)
    .where(eq(competitors.profile_id, profileId));
  const out = new Map<Weekday, CompetitorOpening>();
  for (const { id } of rows) {
    const field = await readCurrentField<OpeningSchedule>(profileId, scheduleKey(id));
    const schedule = field?.value;
    if (!schedule) continue;
    for (const [weekday, periods] of Object.entries(schedule.days) as [
      Weekday,
      OpeningSchedule["days"][Weekday],
    ][]) {
      if (schedule.unstated.includes(weekday)) continue;
      const entry = out.get(weekday) ?? { known: 0, opens: [], closed: 0 };
      entry.known += 1;
      const span = openSpan(periods);
      if (span === null) entry.closed += 1;
      else entry.opens.push(span.first);
      out.set(weekday, entry);
    }
  }
  return out;
}

/** The owner-readable line for one weekday, against the owner's own first hour. */
export function competitorLine(
  entry: CompetitorOpening | undefined,
  ownFirst: number | null,
): string | null {
  if (!entry || entry.known === 0) return null;
  const hh = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
  if (ownFirst === null || entry.opens.length === 0) {
    return `${entry.known} competitor(s) state their hours this day; ${entry.closed} are closed`;
  }
  const earlier = entry.opens.filter((h) => h < ownFirst).length;
  const earliest = Math.min(...entry.opens);
  return (
    `${earlier} of the ${entry.known} competitor(s) whose hours we found open before you (${hh(ownFirst)})` +
    (earlier > 0 ? `, the earliest at ${hh(earliest)}` : "") +
    (entry.closed > 0 ? `; ${entry.closed} are closed that day` : "") +
    ", from their own pages"
  );
}
