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
//     = { provider, op, params } with a registered provider. Modules
//     that know the call at proposal time (D2's publish proposals) put
//     it there, where the owner approved it
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
//     gate covers it exactly as it covers publishing
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
// Scheduling precision is the hosting decision recorded in
// TASKS-PHASE3.md: Vercel Hobby runs this once a day with ±59 minutes
// of slack; Pro runs it every minute. The runner is the same either way.

import { logSafeError } from "../core/log-safe";
import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, executions, proposals } from "../../db/schema";
import type { ProposalRow } from "../proposals/service";
import { expireAllDueProposals } from "../proposals/service";
import type { ReconcileSummary } from "../content/publishing";
import { publishPlan, reconcilePublishing } from "../content/publishing";
import { isPublishProposal } from "../content/publish";
import { adsPlan, isAdProposal } from "../ads/executing";
import { applySiteChange } from "../site/apply";
import { SiteChangeError } from "../site/changes";
import { ExecutionRefused, executeProposal, isHalted } from "./engine";
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

/** What the proposal itself says should run, if it says anything. */
export function preboundPlan(proposal: ProposalRow): DispatchPlan | null {
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
  if (params !== undefined && (typeof params !== "object" || params === null)) return null;
  return { provider, op, params: (params as Record<string, unknown> | undefined) ?? {} };
}

export type DueResult = "executed" | "failed" | "refused" | "halted" | "unroutable";

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
  unroutable: number;
  /** P3-21d: items a dead or failed run left `publishing`, read back. */
  reconciled: ReconcileSummary;
  outcomes: DueOutcome[];
}

export interface DueRunOptions {
  now?: () => Date;
  /** Injectable for tests; real backoff by default. */
  sleep?: (ms: number) => Promise<void>;
  /** Scope the run to one profile (tests, a manual trigger). */
  profileId?: string;
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
    unroutable: 0,
    reconciled: { checked: 0, published: 0, not_sent: 0, uncertain: 0 },
    outcomes: [],
  };

  summary.expired = await expireAllDueProposals(now());
  summary.reconciled = await reconcilePublishing({
    now,
    ...(opts.profileId ? { profileId: opts.profileId } : {}),
    ...(opts.providers?.meta_publish ? { provider: opts.providers.meta_publish } : {}),
  });

  const conditions = [
    eq(proposals.status, "approved"),
    isNotNull(proposals.execute_not_before),
    lte(proposals.execute_not_before, now().toISOString()),
    isNull(executions.id),
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
      unroutable: summary.unroutable,
      reconciled: summary.reconciled,
    }),
  );
  return summary;
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
    if (!plan && isAdProposal(proposal)) {
      const routed = adsPlan(proposal);
      if ("unroutable" in routed) {
        return { ...base, result: "unroutable", detail: `${routed.unroutable} — left approved` };
      }
      plan = routed.plan;
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
