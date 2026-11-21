// Warnings sent at once: the sweep. The one place that decides which of the
// watch's warning lines become an alert.
//
// The writers only write (lib/watch/job for cash, lib/stock/warnings for
// stock): nothing in them contacts anyone, as before. The sweep reads the
// cash and stock warning lines of the last two days that have no alert yet,
// keeps the ones that are news (./news: a warning said again because the week
// turned, or a squeeze that carries on, is not), and hands each business's
// lot to `raiseWarningAlerts` (./alerts), which records them, sends the one
// email and asks for the phone alert.
//
// It runs every morning after the look at stock and cash (./daily) and on
// Mondays at the end of the weekly beat, after the summaries have gone, so
// a warning the summary has just carried gets no second email. Running it
// twice changes nothing: a line with an alert is not looked at again, and a
// line that was not news yesterday is not news today, since what was said
// before it does not change. A line older than the window is never alerted:
// news that is two days old is not sent late.

import { and, asc, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { db } from "../../db";
import { warningAlerts, watchActivity } from "../../db/schema";
import type { EmailFetch } from "../auth/email";
import { logSafeError } from "../core/log-safe";
import { WARNING_KINDS } from "../push/plan";
import type { PushService } from "../push/send";
import { parseInstant } from "../watch/watch-view";
import type { WarningLine } from "./alerts";
import { raiseWarningAlerts } from "./alerts";
import type { SaidStock, StandingCash } from "./news";
import { STOCK_NEWS_WINDOW_DAYS, cashIsNews, stockIsNews } from "./news";

/** A line older than this is no longer told as news. */
export const WARNING_SWEEP_HOURS = 48;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface SweepResult {
  /** Warning lines of the window that had no alert yet. */
  looked: number;
  /** Of those, the ones that were news. */
  news: number;
  /** Alerts recorded. */
  alerts: number;
  /** Emails that went out. */
  emails: number;
  /** Businesses whose lot could not be read. */
  failed: number;
}

interface Candidate {
  id: string;
  profile_id: string;
  at: string;
  kind: string;
  detail: string;
  meta: unknown;
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** What a cash line's meta says about its week (lib/watch/job writes it). */
function cashOf(meta: unknown): StandingCash {
  const m = (meta ?? {}) as Record<string, unknown>;
  return {
    cleared: m.cleared === true || text(m.signature) === null,
    week_start: text(m.week_start),
    week_end: text(m.week_end),
  };
}

/** What a stock line's meta says about its item (lib/stock/warnings writes it). */
function stockOf(meta: unknown): SaidStock {
  const m = (meta ?? {}) as Record<string, unknown>;
  return { key: text(m.key), level: text(m.level) };
}

async function isNews(line: Candidate): Promise<boolean> {
  if (line.kind === "cash_warning") {
    const said = cashOf(line.meta);
    if (said.cleared) return false; // good news is a line to read, not an alert
    const [before] = await db
      .select({ meta: watchActivity.meta })
      .from(watchActivity)
      .where(
        and(
          eq(watchActivity.profile_id, line.profile_id),
          eq(watchActivity.kind, "cash_warning"),
          lt(watchActivity.at, line.at),
        ),
      )
      .orderBy(desc(watchActivity.at))
      .limit(1);
    return cashIsNews(before ? cashOf(before.meta) : null, said);
  }
  const since = new Date(parseInstant(line.at) - STOCK_NEWS_WINDOW_DAYS * DAY_MS).toISOString();
  const earlier = await db
    .select({ meta: watchActivity.meta })
    .from(watchActivity)
    .where(
      and(
        eq(watchActivity.profile_id, line.profile_id),
        eq(watchActivity.kind, "stock_warning"),
        lt(watchActivity.at, line.at),
        gt(watchActivity.at, since),
      ),
    );
  return stockIsNews(
    earlier.map((e) => stockOf(e.meta)),
    stockOf(line.meta),
  );
}

/**
 * Raise the alerts that are due. Never throws: one business failing is
 * counted and logged, and the rest are still told.
 */
export async function raiseDueWarningAlerts(
  now: Date = new Date(),
  opts: {
    profileIds?: readonly string[];
    fetchImpl?: EmailFetch;
    push?: PushService;
  } = {},
): Promise<SweepResult> {
  const result: SweepResult = { looked: 0, news: 0, alerts: 0, emails: 0, failed: 0 };
  let lines: Candidate[];
  try {
    lines = await db
      .select({
        id: watchActivity.id,
        profile_id: watchActivity.profile_id,
        at: watchActivity.at,
        kind: watchActivity.kind,
        detail: watchActivity.detail,
        meta: watchActivity.meta,
      })
      .from(watchActivity)
      .leftJoin(warningAlerts, eq(warningAlerts.activity_id, watchActivity.id))
      .where(
        and(
          inArray(watchActivity.kind, [...WARNING_KINDS]),
          gt(
            watchActivity.at,
            new Date(now.getTime() - WARNING_SWEEP_HOURS * HOUR_MS).toISOString(),
          ),
          isNull(warningAlerts.id),
          ...(opts.profileIds ? [inArray(watchActivity.profile_id, [...opts.profileIds])] : []),
        ),
      )
      .orderBy(asc(watchActivity.at));
  } catch (error) {
    console.error(JSON.stringify({ event: "warning_sweep_failed", ...logSafeError(error) }));
    return { ...result, failed: 1 };
  }
  result.looked = lines.length;

  const byBusiness = new Map<string, Candidate[]>();
  for (const line of lines) {
    byBusiness.set(line.profile_id, [...(byBusiness.get(line.profile_id) ?? []), line]);
  }
  for (const [profileId, lot] of byBusiness) {
    try {
      const news: WarningLine[] = [];
      for (const line of lot) {
        if (await isNews(line)) {
          news.push({ id: line.id, kind: line.kind, detail: line.detail, at: line.at });
        }
      }
      if (news.length === 0) continue;
      result.news += news.length;
      const raised = await raiseWarningAlerts(profileId, news, {
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.push ? { push: opts.push } : {}),
        now,
      });
      result.alerts += raised.alert_ids.length;
      if (raised.email === "sent") result.emails++;
    } catch (error) {
      result.failed++;
      console.error(
        JSON.stringify({
          event: "warning_sweep_business_failed",
          profile_id: profileId,
          ...logSafeError(error),
        }),
      );
    }
  }
  console.log(JSON.stringify({ event: "warning_sweep", ...result }));
  return result;
}
