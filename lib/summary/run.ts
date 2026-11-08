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
//
// P6-07: the owner may choose WhatsApp instead of, or as well as, email.
// Each channel is worked out first (WhatsApp needs its four keys and the
// owner's live opt-in, read now — so a yes withdrawn today stops this
// week's message); with none possible nothing is claimed. The one claim
// still comes before any send and covers both channels; each channel's
// outcome lands on the same row, and neither is ever retried. An
// email-only owner gets exactly what they got before.

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
import type { WhatsAppEnv } from "../env";
import { appUrl, whatsappEnv } from "../env";
import type { AppLocale } from "../i18n/locales";
import { personLocale, wordsFor } from "../i18n/recipient";
import { readCurrentField } from "../profile/field-store";
import { READBACK, readbackForProposal } from "../trust/readback";
import type { ComposedSummary, ForecastsGraded, SummaryInput, SummaryReadback } from "./compose";
import { composeSummary } from "./compose";
import {
  accountOwner,
  stopToken,
  summaryChannel,
  summaryOn,
  summaryPref,
  wantsEmail,
  wantsWhatsApp,
} from "./prefs";
import { isoWeek, summaryWindow } from "./week";
import type { TwilioFetch, WhatsAppMessage, WhatsAppOutcome } from "./whatsapp";
import { sendWhatsApp, templateFor, whatsappVariables } from "./whatsapp";
import type { LiveOptin } from "./whatsapp-optin";
import { liveOptin } from "./whatsapp-optin";

/** Rule 34: the workload a WhatsApp summary's cost line is tagged with. */
export const WHATSAPP_SUMMARY_WORKLOAD = "weekly_summary_whatsapp";

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
  /** P6-07: Twilio's transport; tests pass a fake HTTP. Defaults to fetch. */
  twilioFetch?: TwilioFetch;
}

/** P6-07: WhatsApp can go when it is configured AND the owner's yes is live — read at send time. */
async function whatsappDelivery(
  userId: string,
): Promise<{ env: WhatsAppEnv; optin: LiveOptin } | null> {
  const env = whatsappEnv();
  if (!env) return null;
  const optin = await liveOptin(userId);
  return optin ? { env, optin } : null;
}

type ChannelStatus = "sent" | "refused" | "unknown";

/** Every channel that went, sent: sent. Any that may have gone: unknown. Otherwise refused. */
function combined(statuses: readonly ChannelStatus[]): ChannelStatus {
  if (statuses.every((s) => s === "sent")) return "sent";
  return statuses.includes("unknown") ? "unknown" : "refused";
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
  // P6-07: each channel the owner chose, if it can go. Email is the default.
  const channel = summaryChannel(owner.prefs);
  const configured = wantsEmail(channel) && (opts.send !== undefined || ownerEmailConfigured());
  const wa = wantsWhatsApp(channel) ? await whatsappDelivery(owner.id) : null;
  if (!origin || (!configured && !wa)) return "not_configured";

  const week = isoWeek(now);
  const token = stopToken(owner.id);
  const stopUrl = `${origin}/summary/stop/${token}`;
  const oneClickUrl = `${origin}/api/summary/stop/${token}`;
  // L-6: in the owner's own language, while it is open to them; English otherwise.
  const locale = personLocale(owner.language, {
    email: owner.email,
    account_id: account.account_id,
  });
  const words = await wordsFor(locale, "emails.summary");
  const input = await gatherSummary({ profileId: account.profile_id, now, origin, stopUrl });
  const composed = composeSummary(input, words);

  // The WhatsApp message, built before the claim: the template in the
  // owner's language when there is one, English's otherwise — and then the
  // digest in English too, so the message never mixes two languages.
  let message: WhatsAppMessage | null = null;
  let templateLocale: string | null = null;
  if (wa) {
    const template = templateFor(wa.env.templates, locale)!;
    templateLocale = template.locale;
    const waWords =
      template.locale === locale
        ? words
        : await wordsFor(template.locale as AppLocale, "emails.summary");
    message = {
      to: wa.optin.phone_number,
      content_sid: template.content_sid,
      variables: whatsappVariables({
        business: input.business,
        composed: waWords === words ? composed : composeSummary(input, waWords),
        origin,
        w: waWords,
      }),
    };
  }

  // The claim: the unique (account, week) index lets exactly one run through,
  // however many channels it carries.
  const [claim] = await db
    .insert(weeklySummaries)
    .values({
      account_id: account.account_id,
      iso_week: week,
      quiet: composed.quiet,
      line_count: composed.line_count,
      ...(configured ? {} : { status: null }),
      ...(wa ? { whatsapp_status: "sending" as const, whatsapp_optin_id: wa.optin.id } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: weeklySummaries.id });
  if (!claim) return "already_sent";

  const statuses: ChannelStatus[] = [];
  if (configured) {
    statuses.push(
      await emailSummary({
        claimId: claim.id,
        owner,
        account,
        week,
        composed,
        stopUrl,
        oneClickUrl,
        opts,
      }),
    );
  }
  if (wa && message) {
    statuses.push(
      await whatsappSummary({
        claimId: claim.id,
        env: wa.env,
        message,
        accountId: account.account_id,
        week,
        templateLocale,
        opts,
      }),
    );
  }
  return combined(statuses);
}

/** The email, as it always went: one send, its outcome recorded on the claimed row. */
async function emailSummary(args: {
  claimId: string;
  owner: { email: string };
  account: { account_id: string };
  week: string;
  composed: ComposedSummary;
  stopUrl: string;
  oneClickUrl: string;
  opts: SummaryRunOptions;
}): Promise<ChannelStatus> {
  const { claimId, owner, account, week, composed, stopUrl, oneClickUrl, opts } = args;
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
    .where(eq(weeklySummaries.id, claimId));
  return status;
}

/**
 * P6-07: the WhatsApp message — one POST to Twilio, never retried, its own
 * outcome and Twilio's message SID (or error code) on the same claimed row.
 * Rule 34: a cost line per send, tagged by workload. Twilio prices a
 * WhatsApp template by country and category and says so only on its bill,
 * so the line records the send and says the cost is unknown.
 */
async function whatsappSummary(args: {
  claimId: string;
  env: WhatsAppEnv;
  message: WhatsAppMessage;
  accountId: string;
  week: string;
  templateLocale: string | null;
  opts: SummaryRunOptions;
}): Promise<ChannelStatus> {
  let outcome: WhatsAppOutcome;
  try {
    outcome = await sendWhatsApp(args.env, args.message, args.opts.twilioFetch ?? fetch);
  } catch (error) {
    outcome = { kind: "unknown", why: error instanceof Error ? error.name : "error" };
  }
  const status: ChannelStatus = outcome.kind;
  await db
    .update(weeklySummaries)
    .set({
      whatsapp_status: status,
      whatsapp_sid: outcome.kind === "sent" ? outcome.sid : null,
      whatsapp_error_code: outcome.kind === "refused" ? outcome.code : null,
      settled_at: new Date().toISOString(),
    })
    .where(eq(weeklySummaries.id, args.claimId));
  // Ids and counts only — never the number, never a variable's text.
  console.log(
    JSON.stringify({
      event: "weekly_summary_whatsapp",
      workload: WHATSAPP_SUMMARY_WORKLOAD,
      provider: "twilio",
      account_id: args.accountId,
      summary_id: args.claimId,
      iso_week: args.week,
      outcome: status,
      http_status: outcome.kind === "refused" ? outcome.status : null,
      error_code: outcome.kind === "refused" ? outcome.code : null,
      template_locale: args.templateLocale,
      variable_chars: Object.values(args.message.variables).reduce((n, v) => n + v.length, 0),
      cost: null,
      cost_known: false,
      cost_note: "Twilio and Meta bill per template message by country; not known at send time",
    }),
  );
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
