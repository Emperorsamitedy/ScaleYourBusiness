// Warnings sent at once: the morning look. A warning that looks ahead is
// worth telling the day it becomes true, and until 2026-11-20 the watch only
// looked on Mondays, in the same beat that sends the weekly summary. So a
// stock level read on a Tuesday that will not last until the next delivery
// waited six days to be said.
//
// Every morning between two Mondays (app/api/cron/daily-warnings; Monday's
// own beat does all of this itself):
//
//   1. stock: the same check the weekly beat makes, for every business in
//      care (lib/stock/warnings). It says an item once a week per level, so a
//      morning with nothing new writes nothing;
//   2. cash: the forecast's first tight week, for every business under a
//      watch, written only when no warning stands (lib/watch/job). What
//      moved or cleared waits for Monday;
//   3. the sweep (./sweep): the lines that are news become a phone alert and
//      one email.
//
// Arithmetic over what is already in the database: no connector is read
// (the daily sync has run by then), nothing is proposed, and no model is
// called. One step failing is logged and the next still runs.

import { logSafeError } from "../core/log-safe";
import type { EmailFetch } from "../auth/email";
import type { PushService } from "../push/send";
import { runStockWarnings } from "../stock/warnings";
import { runDailyCashWarnings } from "../watch/job";
import type { SweepResult } from "./sweep";
import { raiseDueWarningAlerts } from "./sweep";

export interface DailyWarningsResult {
  /** Null when the step failed as a whole. */
  stock: { logged: number; failed: number } | null;
  cash: { looked: number; appeared: number } | null;
  alerts: SweepResult;
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    console.error(
      JSON.stringify({ event: "daily_warnings_step_failed", step: name, ...logSafeError(error) }),
    );
    return null;
  }
}

export async function runDailyWarnings(
  now: Date = new Date(),
  opts: {
    /** Tests scope the run to their own businesses. */
    profileIds?: readonly string[];
    fetchImpl?: EmailFetch;
    push?: PushService;
  } = {},
): Promise<DailyWarningsResult> {
  const scope = opts.profileIds ? { profileIds: opts.profileIds } : {};
  const stock = await step("stock", () => runStockWarnings(now, scope));
  const cash = await step("cash", () => runDailyCashWarnings(now, scope));
  const alerts = await raiseDueWarningAlerts(now, opts);
  return { stock, cash, alerts };
}
