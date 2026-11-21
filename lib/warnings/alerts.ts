// Warnings sent at once: the database side (2026-11-20; Vistta: an alert
// must look ahead). The watch writes a warning's line (lib/watch/job for the
// cash forecast's tight week, lib/stock/warnings for an item that runs out
// before its next delivery). Until now that line reached only the app and
// the Monday summary. `raiseWarningAlerts` is called by the sweep
// (./sweep) with the lines that are news for one business and, at once:
//
//   1. gives each a row in warning_alerts (one per line, so a second sweep
//      raises nothing twice);
//   2. sends the owner ONE email for them, unless they switched it off:
//      three items running low in one run are one email, not three. The
//      rows are claimed BEFORE the provider is called and never tried again.
//      No email goes when Monday's summary, sent after the lines were
//      written, has just carried the same sentences: twice is noise;
//   3. asks once for the account's phone alerts to be flushed, where the
//      warnings ride the proposals' rules (the stop, quiet hours, one a day:
//      lib/push/plan). Held, the morning beat sends them.
//
// It never throws: a warning's alert must not fail the beat that found it.
// Logs carry ids and outcomes only, never the owner's address or a line of
// the warning.

import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, warningAlerts, weeklySummaries } from "../../db/schema";
import type { EmailFetch } from "../auth/email";
import { ownerEmailConfigured, sendOwnerEmail } from "../auth/email";
import { logSafeError } from "../core/log-safe";
import { appUrl } from "../env";
import { personLocale, wordsFor } from "../i18n/recipient";
import { flushPushes } from "../push/flush";
import type { WarningKind } from "../push/plan";
import { isWarningKind } from "../push/plan";
import type { PushService } from "../push/send";
import { accountOwner } from "../summary/prefs";
import { logWords } from "../watch/words";
import { composeWarningEmail } from "./email";
import { warningEmailOn, warningPref } from "./switch";

/** The menu's own key for each warning's screen. */
const SCREEN_NAME: Readonly<Record<WarningKind, string>> = {
  cash_warning: "item.cash",
  stock_warning: "item.stock",
};

export type WarningEmailOutcome =
  | "sent"
  /** The owner switched these emails off. */
  | "off"
  /** No key to send with, or no address of its own for the app's links. */
  | "not_configured"
  /** Monday's summary, sent after these lines were written, carried them. */
  | "in_summary"
  | "no_owner"
  | "failed";

export interface RaisedWarnings {
  /** The alerts made by this call: none for lines that already had theirs. */
  alert_ids: string[];
  /** What became of the email; null when no alert was made. */
  email: WarningEmailOutcome | null;
}

export interface WarningLine {
  /** The watch_activity row just written. */
  id: string;
  kind: string;
  /** The line as logged, in English. */
  detail: string;
  /** When the line was written, as the log holds it; absent, no summary is taken to carry it. */
  at?: string;
}

interface Raised {
  alert_id: string;
  kind: WarningKind;
  detail: string;
  at: string | null;
}

/**
 * Did a weekly summary reach the owner's inbox after every one of these
 * lines was written? It reads the seven days up to the moment it is composed
 * (lib/summary/week), so it carried them all under "What I noticed".
 */
async function summaryCarried(accountId: string, raised: readonly Raised[]): Promise<boolean> {
  const times = raised.map((r) => r.at);
  if (times.length === 0 || times.some((t) => t === null)) return false;
  const [sent] = await db
    .select({ id: weeklySummaries.id })
    .from(weeklySummaries)
    .where(
      and(
        eq(weeklySummaries.account_id, accountId),
        eq(weeklySummaries.status, "sent"),
        ...times.map((t) => gte(weeklySummaries.created_at, t as string)),
      ),
    )
    .limit(1);
  return sent !== undefined;
}

async function emailWarnings(
  raised: readonly Raised[],
  accountId: string,
  fetchImpl: EmailFetch | undefined,
): Promise<WarningEmailOutcome> {
  const owner = await accountOwner(accountId);
  if (!owner) return "no_owner";
  if (!warningEmailOn(warningPref(owner.prefs))) return "off";
  const origin = appUrl();
  if (!ownerEmailConfigured() || !origin) return "not_configured";
  if (await summaryCarried(accountId, raised)) return "in_summary";

  // Claimed before the provider is called: two runs racing send one email.
  const claimed = await db
    .update(warningAlerts)
    .set({ email_claimed_at: new Date().toISOString() })
    .where(
      and(
        inArray(
          warningAlerts.id,
          raised.map((r) => r.alert_id),
        ),
        isNull(warningAlerts.email_claimed_at),
      ),
    )
    .returning({ id: warningAlerts.id });
  const mine = raised.filter((r) => claimed.some((c) => c.id === r.alert_id));
  const first = mine[0];
  if (!first) return "sent";

  const locale = personLocale(owner.language, { email: owner.email, account_id: accountId });
  const [w, pw, nav, ww] = await Promise.all([
    wordsFor(locale, "emails.warning"),
    wordsFor(locale, "warningPush"),
    wordsFor(locale, "nav"),
    wordsFor(locale, "watchWords"),
  ]);
  // One kind in a run of the watch is the usual case; a mixed lot opens on the first.
  const mail = composeWarningEmail(
    {
      kind: first.kind,
      sentences: mine.map((r) => logWords(r.detail, { tr: ww.t, locale })),
      screen: nav.t(SCREEN_NAME[first.kind]),
      settings: nav.t("item.alerts"),
      origin: origin.replace(/\/+$/, ""),
      to: owner.email,
      alert_id: first.alert_id,
    },
    w,
    pw,
  );
  const outcome = fetchImpl ? await sendOwnerEmail(mail, fetchImpl) : await sendOwnerEmail(mail);
  return outcome.kind === "sent" ? "sent" : "failed";
}

/**
 * Lines of the watch's log that are news for one business: raise their
 * alerts. Idempotent per line, and it never throws.
 */
export async function raiseWarningAlerts(
  profileId: string,
  lines: readonly WarningLine[],
  opts: { fetchImpl?: EmailFetch; push?: PushService; now?: Date } = {},
): Promise<RaisedWarnings> {
  const wanted = lines.flatMap((l) => (isWarningKind(l.kind) ? [{ ...l, kind: l.kind }] : []));
  if (wanted.length === 0) return { alert_ids: [], email: null };
  try {
    const [profile] = await db
      .select({ account_id: businessProfiles.account_id })
      .from(businessProfiles)
      .where(eq(businessProfiles.id, profileId));
    if (!profile) return { alert_ids: [], email: null };
    const made = await db
      .insert(warningAlerts)
      .values(wanted.map((l) => ({ profile_id: profileId, activity_id: l.id, kind: l.kind })))
      .onConflictDoNothing({ target: warningAlerts.activity_id })
      .returning({ id: warningAlerts.id, activity_id: warningAlerts.activity_id });
    const raised: Raised[] = made.flatMap((m) => {
      const line = wanted.find((l) => l.id === m.activity_id);
      return line
        ? [{ alert_id: m.id, kind: line.kind, detail: line.detail, at: line.at ?? null }]
        : [];
    });
    if (raised.length === 0) return { alert_ids: [], email: null };
    const ids = raised.map((r) => r.alert_id);

    let email: WarningEmailOutcome = "failed";
    try {
      email = await emailWarnings(raised, profile.account_id, opts.fetchImpl);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "warning_email_failed",
          account_id: profile.account_id,
          ...logSafeError(error),
        }),
      );
    }
    await db
      .update(warningAlerts)
      .set({ email_outcome: email })
      .where(inArray(warningAlerts.id, ids));

    // The phone alert: sent now when it may be, held or dropped by the plan otherwise.
    try {
      await flushPushes(profileId, {
        ...(opts.push ? { service: opts.push } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "warning_push_failed",
          account_id: profile.account_id,
          ...logSafeError(error),
        }),
      );
    }
    console.log(
      JSON.stringify({
        event: "warning_alerts",
        account_id: profile.account_id,
        count: ids.length,
        kinds: [...new Set(raised.map((r) => r.kind))],
        email,
      }),
    );
    return { alert_ids: ids, email };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "warning_alerts_failed",
        profile_id: profileId,
        ...logSafeError(error),
      }),
    );
    return { alert_ids: [], email: null };
  }
}
