// The due runner — P3-20e (Session D, layer D0).
//
// An owner can approve a proposal to run no earlier than a stated time
// (P3-05), and until now nothing ever came back for it: guard 3 in the
// engine refused an early call, and no caller returned later. This is
// the caller. On a clock it selects approved proposals whose
// execute_not_before has passed and that have NO execution row yet, and
// runs each through executeProposal — the seven guards untouched, the
// halt honoured per item, every attempt journaled. It never re-runs a
// proposal that already has an execution row: a failed run stays
// visible for a human to resolve rather than being retried every day
// until something gives (D5 makes "paused, not retrying" explicit).
//
// Unscheduled approvals (execute_not_before null) are NOT picked up.
// Approving a site change today does not apply it; the owner clicks
// Apply. The runner is for the ones the owner scheduled.
//
// How a proposal says what to run:
//   - a pre-bound plan on the proposal itself: action.detail.execution
//     = { provider, op, params }, admitted ONLY when PREBOUND_ALLOWED names
//     that module, provider and op — today the in-repo fixture alone
//     (review 2026-10-23, Session D #7). No real provider is ever run from
//     a plan carried in the detail
//   - a per-item publish proposal (P3-21b): lib/content/publishing's
//     publishPlan builds { meta_publish, op, {item_id, platform, target} }
//     from the approved proposal and its own item — the op follows the
//     item's media, never a caller. While the Session D real-write gate
//     is off the engine refuses it unclaimed: counted as refused, the
//     proposal left approved, the item untouched
//   - an ad proposal (P3-22b): lib/ads/executing's adsPlan builds
//     { meta_ads, op, params } from the approved row — pause, resume, a
//     budget change by the approved share, or a paused create. The op
//     follows the change the owner approved, never a caller; the real-write
//     gate covers it exactly as it covers publishing. P3-54 adds "Run this
//     ad" (create_ad_paused, the whole build) and its separate go-live
//     (resume_campaign naming the build's ad set and ad); a build held
//     "remaining" resumes from its journal (ad_builds), never twice
//   - a campaign (P4-15): lib/crm/campaign-send's campaignPlanFor routes
//     a crm customer_email proposal to { email_campaign, send_campaign,
//     {proposal_id} }. Its schedule floor is set when the owner approves
//     the email itself, so an approved campaign whose email nobody
//     approved is never selected. A run held "remaining" (its per-run cap,
//     or the email service asking it to slow down) is selected again and
//     sends only the recipients still pending; a run that died mid-send is
//     closed as held first (reclaimStaleCampaignRuns)
//   - module "site": applySiteChange, which does its own drift check,
//     health check and auto-rollback through the engine
//   - anything else is UNROUTABLE: counted, logged, left approved. The
//     runner never guesses what an approval meant.
//
// It also sweeps expiry first (P3-06 was lazy, at queue-read time), then
// reconciles any item a dead or failed run left `publishing` by READING
// BACK (P3-21d) — never by posting it again. A proposal with an execution
// row is never selected here, so the read-back is the only way back.
//
// D5 (P3-24b/c): a run journaled `failed` with a HOLD is the one exception
// to "never re-run". held_for "reconnect" (its connection failed sign-in and
// paused itself) and "stop" (the emergency stop came on mid-run, before
// anything was sent) are selected again, and once the cause has cleared
// they go back through executeProposal — every guard re-evaluated, the
// real-write gate, the pre-flight and the schedule included. Before that,
// the sweep resumes any work a reconnect has freed (resumeAfterReconnect),
// and anything routed to a PAUSED connection is skipped as `paused` —
// nothing is sent, and an item approved since the pause is held the same
// way as the rest.
//
// Scheduling precision is the hosting decision recorded in
// TASKS-PHASE3.md: Vercel Hobby runs this once a day with ±59 minutes
// of slack; Pro runs it every minute. The runner is the same either way.

import { logSafeError } from "../core/log-safe";
import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, executions, proposals } from "../../db/schema";
import type { MediaStore } from "../content/media";
import type { ProposalRow } from "../proposals/service";
import { expireAllDueProposals } from "../proposals/service";
import type { ReconcileSummary } from "../content/publishing";
import { publishPlan, reconcilePublishing } from "../content/publishing";
import { isPublishProposal } from "../content/publish";
import { adsPlan, isAdProposal } from "../ads/executing";
import { reclaimStaleAdBuilds } from "../ads/adcreate";
import { campaignPlanFor, reclaimStaleCampaignRuns } from "../crm/campaign-send";
import { applySiteChange } from "../site/apply";
import { SiteChangeError } from "../site/changes";
import { activeExecutionConnection } from "./connections";
import { ExecutionRefused, executeProposal, isHalted } from "./engine";
import type { ResumeOutcome } from "./pause";
import { holdQueuedForPausedConnection, isPausableProvider, resumeAfterReconnect } from "./pause";
import type { ExecutionProvider } from "./providers/fixture";
import { executionProvider } from "./providers/index";
import type { MetaPublishProvider } from "./providers/meta";
import type { ExecutionProviderId } from "./scopes";
import { isExecutionProviderId } from "./scopes";

export interface DispatchPlan {
  provider: ExecutionProviderId;
  op: string;
  params: Record<string, unknown>;
}

/**
 * The only pre-bound plans the runner will run (review 2026-10-23, Session
 * D #7): module → the one provider and the ops it may name. A proposal's
 * action.detail can be shaped by more than one caller (the assistant spreads
 * its extras into it), so a plan carried there must never reach a real
 * provider: Meta, campaign email and site changes are each routed from the
 * approved row by their own module's planner (publishPlan, adsPlan,
 * campaignPlanFor, applySiteChange), never from the detail. What remains is
 * the in-repo fixture, the engine's proving ground — no network, no account.
 * Widening this is a deliberate, reviewed edit; due.test.ts pins it.
 */
export const PREBOUND_ALLOWED: Readonly<
  Record<string, { provider: ExecutionProviderId; ops: readonly string[] }>
> = {
  diagnosis: { provider: "fixture", ops: ["set_value", "append_note"] },
};

/** What the proposal itself says should run, if it says anything the allow-list admits. */
export function preboundPlan(
  proposal: Pick<ProposalRow, "module" | "action">,
): DispatchPlan | null {
  const detail = (proposal.action as { detail?: { execution?: unknown } } | null)?.detail;
  const execution = detail?.execution;
  if (!execution || typeof execution !== "object") return null;
  const { provider, op, params } = execution as {
    provider?: unknown;
    op?: unknown;
    params?: unknown;
  };
  if (typeof provider !== "string" || !isExecutionProviderId(provider)) return null;
  if (typeof op !== "string" || op === "") return null;
  const allowed = Object.hasOwn(PREBOUND_ALLOWED, proposal.module)
    ? PREBOUND_ALLOWED[proposal.module]
    : undefined;
  // Not on the list: no plan — the runner logs it unroutable, with the account, and runs nothing.
  if (allowed === undefined || allowed.provider !== provider || !allowed.ops.includes(op)) {
    return null;
  }
  if (params !== undefined && (typeof params !== "object" || params === null)) return null;
  return { provider, op, params: (params as Record<string, unknown> | undefined) ?? {} };
}

export type DueResult = "executed" | "failed" | "refused" | "halted" | "paused" | "unroutable";

export interface DueOutcome {
  proposal_id: string;
  profile_id: string;
  account_id: string;
  module: string;
  result: DueResult;
  /** The refusal code, the error, or the route taken. */
  detail: string;
}

export interface DueRunSummary {
  expired: number;
  due: number;
  executed: number;
  failed: number;
  refused: number;
  halted: number;
  /** P3-24b: routed to an execute connection that paused itself — skipped, nothing sent. */
  paused: number;
  unroutable: number;
  /** P3-21d: items a dead or failed run left `publishing`, read back. */
  reconciled: ReconcileSummary;
  /** P3-24b: work a reconnect freed, put back in motion before anything ran. */
  resumed: ResumeOutcome[];
  /** P4-15: campaign runs that died mid-send, closed as held for this pass. */
  reclaimed_campaigns: number;
  /** P3-54: ad builds that died between two creates, closed as held to resume from their journal. */
  reclaimed_ad_builds: number;
  outcomes: DueOutcome[];
}

export interface DueRunOptions {
  now?: () => Date;
  /** Injectable for tests; real backoff by default. */
  sleep?: (ms: number) => Promise<void>;
  /** Scope the run to one profile (tests, a manual trigger). */
  profileId?: string;
  /** Tests: the media store the expiry sweep releases renders from (Blob by default). */
  store?: MediaStore;
  /** Tests: a provider object in place of the registered one (a fake Graph behind Meta). */
  providers?: { meta_publish?: MetaPublishProvider } & Partial<
    Record<ExecutionProviderId, ExecutionProvider>
  >;
}

function errorText(error: unknown): string {
  return logSafeError(error).error_message;
}

/** The cron's body: sweep expiry, then run everything that is due. Never throws for one proposal. */
export async function runDueExecutions(opts: DueRunOptions = {}): Promise<DueRunSummary> {
  const now = opts.now ?? (() => new Date());
  const summary: DueRunSummary = {
    expired: 0,
    due: 0,
    executed: 0,
    failed: 0,
    refused: 0,
    halted: 0,
    paused: 0,
    unroutable: 0,
    reconciled: { checked: 0, published: 0, not_sent: 0, uncertain: 0 },
    resumed: [],
    reclaimed_campaigns: 0,
    reclaimed_ad_builds: 0,
    outcomes: [],
  };

  summary.expired = await expireAllDueProposals(now(), opts.store);
  summary.resumed = await resumeAfterReconnect(
    opts.profileId ? { accountId: await accountOf(opts.profileId) } : {},
  );
  // P4-15: a campaign run that died mid-send is held, so it is selected below.
  summary.reclaimed_campaigns = await reclaimStaleCampaignRuns(now());
  // P3-54: an ad build that died between two creates resumes from its journal, never twice.
  summary.reclaimed_ad_builds = await reclaimStaleAdBuilds(now());
  summary.reconciled = await reconcilePublishing({
    now,
    ...(opts.profileId ? { profileId: opts.profileId } : {}),
    ...(opts.providers?.meta_publish ? { provider: opts.providers.meta_publish } : {}),
  });

  const conditions = [
    eq(proposals.status, "approved"),
    isNotNull(proposals.execute_not_before),
    lte(proposals.execute_not_before, now().toISOString()),
    // Never run before — or failed only because it was held (P3-24b/c).
    or(
      isNull(executions.id),
      and(
        eq(executions.status, "failed"),
        isNotNull(executions.held_for),
        // A hold that named a wait is left alone until then (review 2026-10-23, #16).
        or(isNull(executions.held_until), lte(executions.held_until, now().toISOString())),
      ),
    ),
  ];
  if (opts.profileId) conditions.push(eq(proposals.profile_id, opts.profileId));

  const rows = await db
    .select({ proposal: proposals, account_id: businessProfiles.account_id })
    .from(proposals)
    .innerJoin(businessProfiles, eq(businessProfiles.id, proposals.profile_id))
    .leftJoin(executions, eq(executions.proposal_id, proposals.id))
    .where(and(...conditions))
    .orderBy(proposals.execute_not_before, proposals.created_at);
  summary.due = rows.length;

  for (const { proposal, account_id } of rows) {
    const outcome = await runOne(proposal, account_id, opts);
    summary.outcomes.push(outcome);
    summary[outcome.result] += 1;
    console.log(
      JSON.stringify({
        event: "execute_due",
        account_id,
        profile_id: proposal.profile_id,
        proposal_id: proposal.id,
        module: proposal.module,
        result: outcome.result,
        detail: outcome.detail,
      }),
    );
  }

  console.log(
    JSON.stringify({
      event: "execute_due_run",
      expired: summary.expired,
      due: summary.due,
      executed: summary.executed,
      failed: summary.failed,
      refused: summary.refused,
      halted: summary.halted,
      paused: summary.paused,
      unroutable: summary.unroutable,
      reconciled: summary.reconciled,
      resumed: summary.resumed.length,
      reclaimed_campaigns: summary.reclaimed_campaigns,
      reclaimed_ad_builds: summary.reclaimed_ad_builds,
    }),
  );
  return summary;
}

const PAUSED_DETAIL = {
  meta_publish: "The Meta publishing connection is paused",
  meta_ads: "The Meta ad connection is paused",
} as const;

async function accountOf(profileId: string): Promise<string> {
  const [row] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return row?.account_id ?? "00000000-0000-0000-0000-000000000000";
}

async function runOne(
  proposal: ProposalRow,
  accountId: string,
  opts: DueRunOptions,
): Promise<DueOutcome> {
  const base = {
    proposal_id: proposal.id,
    profile_id: proposal.profile_id,
    account_id: accountId,
    module: proposal.module,
  };

  // The stop, before anything is even planned. The engine checks it
  // again; skipping here keeps a halted account's journal quiet.
  if (await isHalted(accountId)) {
    return { ...base, result: "halted", detail: "the emergency stop is on" };
  }

  try {
    let plan = preboundPlan(proposal);
    if (!plan && isPublishProposal(proposal.action)) {
      const routed = await publishPlan(proposal);
      if ("unroutable" in routed) {
        return { ...base, result: "unroutable", detail: `${routed.unroutable} — left approved` };
      }
      plan = routed.plan;
    }
    if (!plan) plan = campaignPlanFor(proposal);
    if (!plan && isAdProposal(proposal)) {
      const routed = adsPlan(proposal);
      if ("unroutable" in routed) {
        return { ...base, result: "unroutable", detail: `${routed.unroutable} — left approved` };
      }
      plan = routed.plan;
    }
    if (plan && isPausableProvider(plan.provider)) {
      // P3-24b: nothing retries on a paused connection until the reconnect.
      const conn = await activeExecutionConnection(accountId, plan.provider);
      if (conn?.status === "paused") {
        if (plan.provider === "meta_publish") {
          await holdQueuedForPausedConnection(accountId, conn.id);
        }
        return {
          ...base,
          result: "paused",
          detail: `${PAUSED_DETAIL[plan.provider]}. ${conn.last_error ?? "Reconnect it on Connections."} Nothing was sent.`,
        };
      }
    }
    if (plan) {
      const execution = await executeProposal({
        proposalId: proposal.id,
        provider: opts.providers?.[plan.provider] ?? executionProvider(plan.provider),
        op: plan.op,
        params: plan.params,
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
      return execution.status === "succeeded"
        ? { ...base, result: "executed", detail: `${plan.provider}.${plan.op}` }
        : { ...base, result: "failed", detail: execution.error ?? execution.status };
    }
    if (proposal.module === "site") {
      const outcome = await applySiteChange({
        proposalId: proposal.id,
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
      });
      if (outcome.rolled_back) {
        return {
          ...base,
          result: "failed",
          detail: `rolled back: ${outcome.health.reasons.join("; ")}`,
        };
      }
      return outcome.execution.status === "succeeded"
        ? { ...base, result: "executed", detail: "site.apply_site_change" }
        : {
            ...base,
            result: "failed",
            detail: outcome.execution.error ?? outcome.execution.status,
          };
    }
    return {
      ...base,
      result: "unroutable",
      detail: `no executor knows how to run a "${proposal.module}" proposal — left approved for a human`,
    };
  } catch (error) {
    if (error instanceof ExecutionRefused) {
      return {
        ...base,
        result: error.code === "halted" ? "halted" : "refused",
        detail: `${error.code}: ${error.message}`,
      };
    }
    if (error instanceof SiteChangeError) {
      return { ...base, result: "refused", detail: error.message };
    }
    return { ...base, result: "failed", detail: errorText(error) };
  }
}
