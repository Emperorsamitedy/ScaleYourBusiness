// Writing forecasts to the track record — idea 54 (I-54.2).
//
// Called by the code that shows a forecast, at the moment it shows it:
// the weekly beat's stock-out warnings (lib/stock/warnings) and the
// seasons screen (/api/patterns). Insert-only: the key is unique per
// profile, so showing the same forecast again records nothing new, and
// migration 0067's triggers refuse a row inserted already graded. A
// failure here never stops the screen or the beat that called it.

import { db } from "../../db";
import { forecastChecks } from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import type { ForecastClaim } from "./claims";

/** Record each claim once. Returns how many were new. */
export async function recordForecasts(claims: readonly ForecastClaim[]): Promise<number> {
  if (claims.length === 0) return 0;
  const rows = await db
    .insert(forecastChecks)
    .values([...claims])
    .onConflictDoNothing()
    .returning({ id: forecastChecks.id });
  return rows.length;
}

/** The same, for a caller that must carry on whatever happens: logs and returns 0 on failure. */
export async function recordForecastsQuietly(
  claims: readonly ForecastClaim[],
  context: { account_id: string; event: string },
): Promise<number> {
  try {
    const written = await recordForecasts(claims);
    if (written > 0) {
      console.log(
        JSON.stringify({ event: context.event, account_id: context.account_id, written }),
      );
    }
    return written;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: `${context.event}_failed`,
        account_id: context.account_id,
        ...logSafeError(error),
      }),
    );
    return 0;
  }
}
