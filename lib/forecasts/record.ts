// Writing forecasts to the track record — idea 54 (I-54.2).
//
// Called by the code that shows a forecast, at the moment it shows it:
// the weekly beat's stock-out warnings (lib/stock/warnings) and the
// seasons screen (/api/patterns). Insert-only: the key is unique per
// profile, so showing the same forecast again records nothing new, and
// migration 0067's triggers refuse a row inserted already graded. A
// failure here never stops the screen or the beat that called it.
//
// One run-out counts once (I-54c, owner 2026-11-01: "go ahead with
// I-54c"). A stock warning is said once a week, so an item warned three
// weeks running would be three forecasts of what is likely the same
// run-out. While an item has a stock-out claim still waiting for its
// grade, a later week's warning for it isn't recorded; once that claim is
// graded (it ran out, it lasted, or a delivery made it "can't tell"), the
// next warning is a new forecast. Claims recorded before this stay on the
// record, as every claim does.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import { forecastChecks } from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import type { ForecastClaim } from "./claims";

/** Pure: a stock-out claim's item, its key without the week ("stock_out|<item>|<week>"). */
export function runOutItem(forecastKey: string): string | null {
  if (!forecastKey.startsWith("stock_out|")) return null;
  const cut = forecastKey.lastIndexOf("|");
  return cut > "stock_out".length ? forecastKey.slice(0, cut) : null;
}

/** I-54c: the stock-out claims whose item has no claim still waiting for its grade. */
async function withoutOpenRunOuts(
  claims: readonly ForecastClaim[],
): Promise<readonly ForecastClaim[]> {
  const stock = claims.filter((c) => c.kind === "stock_out");
  if (stock.length === 0) return claims;
  const profiles = [...new Set(stock.map((c) => c.profile_id))];
  const open = await db
    .select({ profile_id: forecastChecks.profile_id, key: forecastChecks.forecast_key })
    .from(forecastChecks)
    .where(
      and(
        inArray(forecastChecks.profile_id, profiles),
        eq(forecastChecks.kind, "stock_out"),
        isNull(forecastChecks.graded_at),
      ),
    );
  const waiting = new Set(open.map((o) => `${o.profile_id}|${runOutItem(o.key)}`));
  return claims.filter(
    (c) =>
      c.kind !== "stock_out" ||
      // The same week's claim is the same row: the key's own conflict handles it.
      open.some((o) => o.profile_id === c.profile_id && o.key === c.forecast_key) ||
      !waiting.has(`${c.profile_id}|${runOutItem(c.forecast_key)}`),
  );
}

/** Record each claim once. Returns how many were new. */
export async function recordForecasts(claims: readonly ForecastClaim[]): Promise<number> {
  const kept = await withoutOpenRunOuts(claims);
  if (kept.length === 0) return 0;
  const rows = await db
    .insert(forecastChecks)
    .values([...kept])
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
