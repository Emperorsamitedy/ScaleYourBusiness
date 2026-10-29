// Reading the track record for /history — idea 54 (I-54.4). Read-only: one
// business's forecasts, every one, graded or waiting. The words are ./view's.

import { desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { forecastChecks } from "../../db/schema";
import type { TrackView } from "./view";
import { trackView } from "./view";

export async function trackRecord(profileId: string, now: Date = new Date()): Promise<TrackView> {
  const rows = await db
    .select({
      id: forecastChecks.id,
      kind: forecastChecks.kind,
      made_at: forecastChecks.made_at,
      recorded_at: forecastChecks.recorded_at,
      subject: forecastChecks.subject,
      subject_ref: forecastChecks.subject_ref,
      unit: forecastChecks.unit,
      window_start: forecastChecks.window_start,
      window_end: forecastChecks.window_end,
      low_minor: forecastChecks.low_minor,
      high_minor: forecastChecks.high_minor,
      currency: forecastChecks.currency,
      low_num: forecastChecks.low_num,
      high_num: forecastChecks.high_num,
      low_date: forecastChecks.low_date,
      high_date: forecastChecks.high_date,
      claim: forecastChecks.claim,
      basis: forecastChecks.basis,
      graded_at: forecastChecks.graded_at,
      verdict: forecastChecks.verdict,
      actual_note: forecastChecks.actual_note,
    })
    .from(forecastChecks)
    .where(eq(forecastChecks.profile_id, profileId))
    .orderBy(desc(forecastChecks.made_at));
  return trackView(rows, now.toISOString().slice(0, 10));
}
