// The weekly summary's runner — idea 42. Rides the weekly beat
// (app/api/cron/weekly-watch), after every other step, so this week's
// snapshot, goal checks and proposals are already on record.
//
// For each business with a mode decision whose owner hasn't switched it
// off: read the week (gatherSummary), compose it (./compose, no model),
// claim the (account, ISO week) row, then send. The claim comes BEFORE the
// provider call and is never retried, so a re-run of the cron — or two
// racing — sends nothing twice; Resend's Idempotency-Key backs that up
// inside its own 24 hours. With no RESEND_API_KEY or no APP_URL nothing is
// claimed and nothing is sent: setting them later in the week still lets
// that week's email go. Logs carry ids and counts only — never the
// owner's address, never a line of the email.

import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  executions,
  forecastChecks,
  modeDecisions,
  proposals,
  supportTickets,
  watchActivity,
  weeklySummaries,
} from "../../db/schema";
import type { OwnerEmail, OwnerEmailOutcome } from "../auth/email";
import { ownerEmailConfigured, sendOwnerEmail } from "../auth/email";
import { getProvider } from "../connectors/registry";
import { isProviderId } from "../connectors/scopes";
import { logSafeError } from "../core/log-safe";
import { appUrl } from "../env";
import { personLocale, wordsFor } from "../i18n/recipient";
import { readCurrentField } from "../profile/field-store";
import { READBACK, readbackForProposal } from "../trust/readback";
import type { ComposedSummary, ForecastsGraded, SummaryInput, SummaryReadback } from "./compose";
import { composeSummary } from "./compose";
import { accountOwner, stopToken, summaryOn, summaryPref } from "./prefs";
import { isoWeek, summaryWindow } from "./week";

const DAY_MS = 86_400_000;

/** Executed this long ago or less, a change's readback is still worth a line. */
export const READBACK_LOOKBACK_DAYS = READBACK.before_days + READBACK.min_after_days;

async function businessName(profileId: string): Promise<string | null> {
  for (const key of ["identity.legal_name", "identity.business_name"]) {
    const field = await readCurrentField<unknown>(profileId, key);
    if (!field || (field.status !== "answered" && field.status !== "inferred")) continue;
    if (typeof field.value === "string" && field.value.trim() !== "") return field.value.trim();
  }
  return null;
}

/** Everything the week holds for one business, read — nothing composed yet. */
export async function gatherSummary(args: {
  profileId: string;
  now: Date;
  origin: string;
  stopUrl: string;
}): Promise<SummaryInput> {
  const { profileId, now } = args;
  const window = summaryWindow(now);

  const activity = await db
    .select({
      at: watchActivity.at,
      kind: watchActivity.kind,
      detail: watchActivity.detail,
      meta: watchActivity.meta,
    })
    .from(watchActivity)
    .where(
      and(
        eq(watchActivity.profile_id, profileId),
        gt(watchActivity.at, window.from),
        lte(watchActivity.at, window.to),
      ),
    );

  const ran = await db
    .select({
      at: executions.finished_at,
      status: executions.status,
      action: proposals.action,
    })
    .from(executions)
    .innerJoin(proposals, eq(proposals.id, executions.proposal_id))
    .where(
      and(
        eq(executions.profile_id, profileId),
        inArray(executions.status, ["succeeded", "undone"]),
        gt(executions.finished_at, window.from),
        lte(executions.finished_at, window.to),
      ),
    );

  const pending = await db
    .select({ action: proposals.action })
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        eq(proposals.status, "pending"),
        gt(proposals.expires_at, window.to),
      ),
    )
    .orderBy(desc(proposals.created_at));

  const [tickets] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(supportTickets)
    .where(and(eq(supportTickets.profile_id, profileId), eq(supportTickets.status, "open")));

  // Readbacks: executed proposals recent enough that the verdict is news.
  const since = new Date(now.getTime() - READBACK_LOOKBACK_DAYS * DAY_MS).toISOString();
  const recent = await db
    .select({ proposal: proposals })
    .from(proposals)
    .innerJoin(executions, eq(executions.proposal_id, proposals.id))
    .where(
      and(
        eq(proposals.profile_id, profileId),
        eq(proposals.status, "executed"),
        gt(executions.finished_at, since),
      ),
    )
    .orderBy(desc(executions.finished_at));
  const readbacks: SummaryReadback[] = [];
  for (const { proposal } of recent) {
    const outcome = await readbackForProposal(proposal, now);
    const revenue = outcome.judged_on === "revenue";
    readbacks.push({
      summary: summaryOf(proposal.action),
      verdict: outcome.verdict,
      judged_on: outcome.judged_on,
      currency: outcome.currency,
      before_minor: revenue ? (outcome.before?.mean_minor ?? null) : null,
      after_minor: revenue ? (outcome.after?.mean_minor ?? null) : null,
      delta_pct: outcome.delta_pct,
    });
  }

  // Idea 54: SYB's own forecasts graded this week (the beat grades them just before).
  const gradedRows = await db
    .select({ verdict: forecastChecks.verdict, n: sql<number>`count(*)::int` })
    .from(forecastChecks)
    .where(
      and(
        eq(forecastChecks.profile_id, profileId),
        gt(forecastChecks.graded_at, window.from),
        lte(forecastChecks.graded_at, window.to),
      ),
    )
    .groupBy(forecastChecks.verdict);
  const forecasts: ForecastsGraded = { inside: 0, above: 0, below: 0, cant_tell: 0 };
  for (const r of gradedRows) {
    if (r.verdict && r.verdict in forecasts) {
      forecasts[r.verdict as keyof ForecastsGraded] = Number(r.n);
    }
  }

  const providerLabels: Record<string, string> = {};
  for (const row of activity) {
    const provider = ((row.meta ?? {}) as { provider?: unknown }).provider;
    if (typeof provider === "string" && isProviderId(provider)) {
      providerLabels[provider] = getProvider(provider).label;
    }
  }

  return {
    business: await businessName(profileId),
    window,
    origin: args.origin,
    stop_url: args.stopUrl,
    activity,
    executed: ran
      .filter((r): r is typeof r & { at: string } => r.at !== null)
      .map((r) => ({
        at: r.at,
        summary: summaryOf(r.action),
        undone: r.status === "undone",
      })),
    pending: pending.map((p) => ({ summary: summaryOf(p.action) })),
    open_tickets: Number(tickets?.n ?? 0),
    readbacks,
    provider_labels: providerLabels,
    forecasts,
  };
}

/** A proposal's own summary, or null for none (the email says "A proposal" in the owner's words). */
function summaryOf(action: unknown): string | null {
  const s = (action as { summary?: unknown } | null)?.summary;
  return typeof s === "string" && s.trim() !== "" ? s.trim() : null;
}

/** The email as Resend receives it. */
export function summaryEmail(args: {
  to: string;
  accountId: string;
  week: string;
  composed: ComposedSummary;
  stopUrl: string;
  oneClickUrl: string;
}): OwnerEmail {
  return {
    to: args.to,
    subject: args.composed.subject,
    text: args.composed.text,
    html: args.composed.html,
    headers: {
      // RFC 8058: a mail client's own "unsubscribe" POSTs here and it's done.
      "List-Unsubscribe": `<${args.oneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    idempotency_key: `syb-weekly-summary-${args.accountId}-${args.week}`,
  };
}

export type SummaryOutcome =
  | "sent"
  | "off"
  | "no_owner"
  | "already_sent"
  | "not_configured"
  | "refused"
  | "unknown"
  | "failed";

export interface SummaryRunResult {
  considered: number;
  sent: number;
  off: number;
  already_sent: number;
  not_configured: number;
  failed: number;
}

export interface SummaryRunOptions {
  /** Tests scope the run to their own accounts; the cron passes nothing. */
  accountIds?: readonly string[];
  /** The sender; tests pass a fake. Defaults to Resend via lib/auth/email. */
  send?: (mail: OwnerEmail) => Promise<OwnerEmailOutcome>;
  /** The origin links use; defaults to APP_URL. */
  origin?: string | null;
}

/** One account's week. Returns what happened; never throws for a send. */
export async function summariseAccount(
  account: { account_id: string; profile_id: string },
  now: Date,
  opts: SummaryRunOptions = {},
): Promise<SummaryOutcome> {
  const owner = await accountOwner(account.account_id);
  if (!owner) return "no_owner";
  // Every account here has a mode decision; the owner's word decides the rest.
  if (!summaryOn(summaryPref(owner.prefs), true)) return "off";

  const origin = (opts.origin === undefined ? appUrl() : opts.origin)?.replace(/\/$/, "") ?? null;
  const configured = opts.send !== undefined || ownerEmailConfigured();
  if (!origin || !configured) return "not_configured";

  const week = isoWeek(now);
  const token = stopToken(owner.id);
  const stopUrl = `${origin}/summary/stop/${token}`;
  const oneClickUrl = `${origin}/api/summary/stop/${token}`;
  // L-6: in the owner's own language, while it is open to them; English otherwise.
  const words = await wordsFor(
    personLocale(owner.language, { email: owner.email, account_id: account.account_id }),
    "emails.summary",
  );
  const composed = composeSummary(
    await gatherSummary({ profileId: account.profile_id, now, origin, stopUrl }),
    words,
  );

  // The claim: the unique (account, week) index lets exactly one run through.
  const [claim] = await db
    .insert(weeklySummaries)
    .values({
      account_id: account.account_id,
      iso_week: week,
      quiet: composed.quiet,
      line_count: composed.line_count,
    })
    .onConflictDoNothing()
    .returning({ id: weeklySummaries.id });
  if (!claim) return "already_sent";

  const send = opts.send ?? ((mail: OwnerEmail) => sendOwnerEmail(mail));
  let outcome: OwnerEmailOutcome;
  try {
    outcome = await send(
      summaryEmail({
        to: owner.email,
        accountId: account.account_id,
        week,
        composed,
        stopUrl,
        oneClickUrl,
      }),
    );
  } catch (error) {
    outcome = { kind: "unknown", why: error instanceof Error ? error.name : "error" };
  }
  // not_configured can't happen past the check above, but if it does nothing went out.
  const status =
    outcome.kind === "sent"
      ? "sent"
      : outcome.kind === "refused" || outcome.kind === "not_configured"
        ? "refused"
        : "unknown";
  await db
    .update(weeklySummaries)
    .set({
      status,
      provider_id: outcome.kind === "sent" ? outcome.provider_id : null,
      settled_at: new Date().toISOString(),
    })
    .where(eq(weeklySummaries.id, claim.id));
  return status;
}

/** Businesses with a mode decision: watching, or acting right away. */
async function inCare(): Promise<{ account_id: string; profile_id: string }[]> {
  return db
    .selectDistinct({ account_id: businessProfiles.account_id, profile_id: businessProfiles.id })
    .from(modeDecisions)
    .innerJoin(businessProfiles, eq(businessProfiles.id, modeDecisions.profile_id));
}

/** The weekly sweep. One account's failure never stops the rest. */
export async function runWeeklySummaries(
  now: Date = new Date(),
  opts: SummaryRunOptions = {},
): Promise<SummaryRunResult> {
  const all = await inCare();
  const accounts = opts.accountIds
    ? all.filter((a) => opts.accountIds!.includes(a.account_id))
    : all;
  const result: SummaryRunResult = {
    considered: accounts.length,
    sent: 0,
    off: 0,
    already_sent: 0,
    not_configured: 0,
    failed: 0,
  };
  const week = isoWeek(now);
  for (const account of accounts) {
    let outcome: SummaryOutcome;
    try {
      outcome = await summariseAccount(account, now, opts);
    } catch (error) {
      outcome = "failed";
      console.error(
        JSON.stringify({
          event: "weekly_summary_failed",
          account_id: account.account_id,
          iso_week: week,
          ...logSafeError(error),
        }),
      );
    }
    if (outcome === "sent") result.sent++;
    else if (outcome === "off" || outcome === "no_owner") result.off++;
    else if (outcome === "already_sent") result.already_sent++;
    else if (outcome === "not_configured") result.not_configured++;
    else result.failed++;
    console.log(
      JSON.stringify({
        event: "weekly_summary",
        account_id: account.account_id,
        iso_week: week,
        outcome,
      }),
    );
  }
  return result;
}
