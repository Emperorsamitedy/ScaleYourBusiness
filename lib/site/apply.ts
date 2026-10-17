// Applying a site change — Phase 3 Session F (P3-31/32/33).
//
// The approved change goes through the SAME engine as every write —
// watching block, emergency stop, idempotency, undo captured first —
// and then the page is health-checked. A HARD failure (server error,
// empty page, load regression past the pinned thresholds) rolls the
// change back automatically, as the system, on the record. Anything
// softer never does: this module has NO conversion input — not a
// param, not a metric read — so "conversion noise" cannot trigger a
// rollback even by accident. The absence is structural, the
// no-generated-video pattern again.
//
// Drift honesty: the live page is refetched at apply time. If the
// approved find-text no longer matches exactly once, the apply refuses
// — the owner approved a change to the page as it WAS, and applying a
// stale diff to a moved page is how sites get mangled.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { proposals } from "../../db/schema";
import { executeProposal, undoExecution } from "../execution/engine";
import type { ExecutionRow } from "../execution/engine";
import { fixtureSiteExecutor } from "../execution/providers/fixture-site";
import type { ExecutionProvider } from "../execution/providers/fixture";
import type { PageFetcher } from "./fetch";
import { livePageFetcher } from "./fetch";
import type { SiteChangeDetail } from "./changes";
import { SiteChangeError } from "./changes";

/** P3-33's thresholds — code, with boundary tests, both directions. */
export const HEALTH = {
  /** A post-change load beyond baseline × this is a regression… */
  load_factor: 3,
  /** …but never for less than this absolute headroom, so a 40ms page
   * isn't "regressed" at 121ms. */
  load_floor_ms: 2000,
  /** A page smaller than this came back effectively empty. */
  min_bytes: 100,
} as const;

export interface HealthReport {
  ok: boolean;
  reasons: string[];
  status: number;
  duration_ms: number;
  threshold_ms: number;
}

/** Hard failures only. No conversion data exists anywhere near this. */
export async function checkSiteHealth(
  url: string,
  baselineMs: number,
  fetcher: PageFetcher,
): Promise<HealthReport> {
  const thresholdMs = Math.max(baselineMs * HEALTH.load_factor, baselineMs + HEALTH.load_floor_ms);
  try {
    const page = await fetcher(url);
    const reasons: string[] = [];
    if (page.status >= 500) reasons.push(`the server answered ${page.status}`);
    if (page.html.length < HEALTH.min_bytes) reasons.push("the page came back effectively empty");
    if (page.duration_ms > thresholdMs) {
      reasons.push(
        `load regression: ${page.duration_ms}ms against a ${baselineMs}ms baseline (threshold ${thresholdMs}ms)`,
      );
    }
    return {
      ok: reasons.length === 0,
      reasons,
      status: page.status,
      duration_ms: page.duration_ms,
      threshold_ms: thresholdMs,
    };
  } catch (error) {
    return {
      ok: false,
      reasons: [
        `the page stopped answering: ${error instanceof Error ? error.message : String(error)}`,
      ],
      status: 0,
      duration_ms: 0,
      threshold_ms: thresholdMs,
    };
  }
}

export interface ApplyOutcome {
  execution: ExecutionRow;
  health: HealthReport;
  rolled_back: boolean;
}

export interface ApplySiteChangeArgs {
  proposalId: string;
  /** Ownership scope: when set, only this profile's proposals apply. */
  expectedProfileId?: string;
  provider?: ExecutionProvider;
  fetcher?: PageFetcher;
  sleep?: (ms: number) => Promise<void>;
}

/** Apply an approved site change through the engine, then judge it. */
export async function applySiteChange(args: ApplySiteChangeArgs): Promise<ApplyOutcome> {
  const fetcher = args.fetcher ?? livePageFetcher;

  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, args.proposalId));
  if (!proposal) throw new SiteChangeError("no such proposal", 404);
  // Ownership clause (2026-09-26 review): a foreign profile's proposal
  // is "missing" — 404, never confirmation across the boundary.
  if (args.expectedProfileId && proposal.profile_id !== args.expectedProfileId) {
    throw new SiteChangeError("no such proposal", 404);
  }
  if (proposal.module !== "site") throw new SiteChangeError("not a site proposal", 422);
  const detail = (proposal.action as { detail: SiteChangeDetail }).detail;
  if (detail.manual_instructions) {
    throw new SiteChangeError(
      `${detail.platform.platform} can't be edited programmatically — this change is applied by you, with the instructions on the card`,
      409,
    );
  }

  // Which provider can actually WRITE this site? Real platform write
  // providers arrive with Session D, each behind its own consent —
  // claiming success against anything else would be a progress bar
  // over a lie. Only the in-repo fixture site is writable today.
  const provider =
    args.provider ??
    (new URL(detail.url).hostname.endsWith(".example") ? fixtureSiteExecutor : null);
  if (!provider) {
    throw new SiteChangeError(
      `applying to ${detail.platform.platform} needs its write access connected — that arrives with its own consent screen (Session D gate). Until then this card, with its before/after, is the reference for changing it yourself`,
      409,
    );
  }

  // Drift check: the page as it is NOW, not as it was at proposal time.
  const current = await fetcher(detail.url);
  const occurrences = current.html.split(detail.find).length - 1;
  if (occurrences !== 1) {
    throw new SiteChangeError(
      occurrences === 0
        ? "the page changed since you approved — the text isn't there any more; re-propose against today's page"
        : "the page changed since you approved — the text is no longer unique; re-propose against today's page",
      409,
    );
  }
  // A function replacement is literal: "$&", "$'" and friends in the owner's
  // text must be written as typed, never expanded into page content.
  const nextHtml = current.html.replace(detail.find, () => detail.replace);

  const execution = await executeProposal({
    proposalId: proposal.id,
    provider,
    op: "apply_site_change",
    params: { url: detail.url, next_html: nextHtml },
    ...(args.sleep ? { sleep: args.sleep } : {}),
  });
  if (execution.status !== "succeeded") {
    return {
      execution,
      health: {
        ok: false,
        reasons: ["the apply itself failed"],
        status: 0,
        duration_ms: 0,
        threshold_ms: 0,
      },
      rolled_back: false,
    };
  }

  const health = await checkSiteHealth(detail.url, detail.health_baseline_ms, fetcher);
  if (health.ok) return { execution, health, rolled_back: false };

  // P3-33: hard failure → the SYSTEM undoes its own change, on the record.
  console.log(
    JSON.stringify({
      event: "site_auto_rollback",
      account_id: execution.account_id,
      proposal_id: proposal.id,
      reasons: health.reasons,
    }),
  );
  const undone = await undoExecution({ executionId: execution.id, provider, userId: null });
  return { execution: undone, health, rolled_back: true };
}
