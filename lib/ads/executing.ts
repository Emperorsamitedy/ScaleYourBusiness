// The ad executor's database side and the due runner's route — P3-22b/c/d
// (Session D, layer D3).
//
// lib/execution/providers/meta.ts sends; this file remembers, as
// lib/content/publishing.ts does for the publish path. The Meta executor
// holds no database import of its own and reaches state through AdsBackend:
//
//   credential         the live meta_ads execute connection, decrypted
//   capturedUndo       the undo the engine stored before attempt one — the
//                      baseline a budget change is computed from
//   ceiling            the owner's monthly ad ceiling (8.1i) — the same fact
//                      the generator reads (monthlyAdCeiling)
//   accountDailySpend  the account's measured average day — the generator's
//                      own arithmetic (accountDailySpend)
//   sawTier            P3-22d: the access tier Meta last reported, on the
//                      execute connection (migration 0043)
//   changed            one watch-log line the owner can read
//   paused             P3-24b: Meta refused the sign-in — the ad connection
//                      pauses itself (lib/execution/pause.ts)
//   consentCurrent …   P3-54: the ad build — whether the ad connection's
//                      consent covers today's wording, the Page it runs as,
//                      what was approved, and the build's journal (ad_builds)
//
// And adsPlan: the due runner's route for an ad proposal, built from the
// approved proposal row — never from a client. The op follows the change
// the owner approved; the executor re-reads the campaign before it sends.

import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db";
import { adBuilds, connections, contentItems, executions, watchActivity } from "../../db/schema";
import { activeExecutionConnection, executionSecret } from "../execution/connections";
import { pauseExecutionConnection } from "../execution/pause";
import type { DispatchPlan } from "../execution/due";
import type { AdBuildJournal, AdsBackend } from "../execution/providers/meta";
import { approvedPublishHash, parseMetaExecutionCredential } from "../execution/providers/meta";
import { adConsentCurrent, adIdentityFor, proposeGoLiveAfterBuild, stepPatchSql } from "./adcreate";
import type { ProposalRow } from "../proposals/service";
import { shiftDay } from "../trust/series";
import {
  ADS,
  ADS_MODULE,
  accountDailySpend,
  loadCampaignSeries,
  monthlyAdCeiling,
} from "./proposals";

/** The two proposal kinds the ad generator makes (lib/ads/proposals.ts). */
export const AD_KINDS = ["paid_ads_decrease_or_pause", "paid_ads_start_or_increase"] as const;

/** Which kind each change belongs to — a change under the other kind is not routed. */
const CHANGE_KIND: Readonly<Record<string, (typeof AD_KINDS)[number]>> = {
  pause: "paid_ads_decrease_or_pause",
  lower_budget: "paid_ads_decrease_or_pause",
  resume: "paid_ads_start_or_increase",
  raise_budget: "paid_ads_start_or_increase",
  create_paused: "paid_ads_start_or_increase",
  // P3-54: "Run this ad" (created paused) and its separate go-live.
  run_ad: "paid_ads_start_or_increase",
  go_live: "paid_ads_start_or_increase",
};

export function isAdProposal(proposal: Pick<ProposalRow, "module">): boolean {
  return proposal.module === ADS_MODULE;
}

interface AdDetail {
  change?: unknown;
  campaign_ref?: unknown;
  share?: unknown;
  currency?: unknown;
  name?: unknown;
  objective?: unknown;
  special_ad_categories?: unknown;
  daily_budget_minor?: unknown;
}

/**
 * The due runner's route for an ad proposal (P3-22b). Pure over the
 * approved row the runner read from the database. Null plan = unroutable,
 * with the reason, and the proposal stays approved for a human.
 */
export function adsPlan(
  proposal: Pick<ProposalRow, "module" | "action">,
): { plan: DispatchPlan } | { unroutable: string } {
  if (!isAdProposal(proposal)) return { unroutable: "not an ad proposal" };
  const action = (proposal.action ?? {}) as { kind?: unknown; detail?: AdDetail };
  const d = action.detail ?? {};
  const change = typeof d.change === "string" ? d.change : "";
  const kind = CHANGE_KIND[change];
  if (kind === undefined) return { unroutable: `no ad op makes a "${change || "unnamed"}" change` };
  if (action.kind !== kind) {
    return { unroutable: `a "${change}" change under "${String(action.kind)}" doesn't add up` };
  }
  if (change === "run_ad") {
    // P3-54: the approved ad exactly as the card showed it; the executor re-checks every part.
    const ad = (d as { ad?: unknown }).ad;
    if (!ad || typeof ad !== "object") return { unroutable: "the ad proposal carries no ad" };
    return {
      plan: {
        provider: "meta_ads",
        op: "create_ad_paused",
        params: { ...(ad as Record<string, unknown>) },
      },
    };
  }
  if (change === "go_live") {
    // P3-54: going live is resume_campaign, naming the build's own ad set and ad.
    const g = d as {
      campaign_ref?: unknown;
      adset_id?: unknown;
      ad_id?: unknown;
      run_days?: unknown;
    };
    const ids = [g.campaign_ref, g.adset_id, g.ad_id];
    if (!ids.every((v) => typeof v === "string" && /^\d{5,}$/.test(v))) {
      return { unroutable: "the go-live names no Meta campaign, ad set and ad" };
    }
    return {
      plan: {
        provider: "meta_ads",
        op: "resume_campaign",
        params: {
          campaign_id: g.campaign_ref,
          adset_id: g.adset_id,
          ad_id: g.ad_id,
          run_days: g.run_days,
        },
      },
    };
  }
  if (change === "create_paused") {
    return {
      plan: {
        provider: "meta_ads",
        op: "create_campaign_paused",
        params: {
          name: d.name ?? null,
          objective: d.objective ?? null,
          special_ad_categories: d.special_ad_categories ?? [],
          ...(d.daily_budget_minor !== undefined
            ? { daily_budget_minor: d.daily_budget_minor, currency: d.currency ?? null }
            : {}),
        },
      },
    };
  }
  const ref = typeof d.campaign_ref === "string" ? d.campaign_ref : "";
  if (!/^\d{5,}$/.test(ref)) return { unroutable: "the ad proposal names no Meta campaign" };
  if (change === "pause") {
    return { plan: { provider: "meta_ads", op: "pause_campaign", params: { campaign_id: ref } } };
  }
  if (change === "resume") {
    return { plan: { provider: "meta_ads", op: "resume_campaign", params: { campaign_id: ref } } };
  }
  const share = typeof d.share === "number" && Number.isFinite(d.share) ? d.share : null;
  if (share === null || (change === "raise_budget" ? share <= 0 : share >= 0)) {
    return { unroutable: `the ${change.replace("_", " ")} names no amount in the right direction` };
  }
  if (typeof d.currency !== "string") return { unroutable: "the budget change names no currency" };
  return {
    plan: {
      provider: "meta_ads",
      op: "set_daily_budget",
      params: { campaign_id: ref, share, currency: d.currency },
    },
  };
}

/** The database behind the Meta ad executor. */
export function dbAdsBackend(opts: { now?: () => Date } = {}): AdsBackend {
  const now = opts.now ?? (() => new Date());
  return {
    async credential(accountId) {
      const row = await activeExecutionConnection(accountId, "meta_ads");
      if (!row) {
        return {
          refused:
            "Meta ad management isn't connected. Connect it on Connections; nothing was changed.",
        };
      }
      if (row.status !== "connected") {
        return {
          refused: `The Meta ad connection is ${row.status}. Reconnect it on Connections; nothing was changed.`,
        };
      }
      return parseMetaExecutionCredential(executionSecret(row), "meta_ads");
    },

    async capturedUndo(executionId) {
      const [row] = await db
        .select({ undo_payload: executions.undo_payload })
        .from(executions)
        .where(eq(executions.id, executionId));
      return row?.undo_payload ?? null;
    },

    ceiling: (profileId) => monthlyAdCeiling(profileId),

    async accountDailySpend(accountId, currency) {
      const today = now().toISOString().slice(0, 10);
      const campaigns = await loadCampaignSeries(
        accountId,
        shiftDay(today, -(ADS.raise_window_days + 1)),
        shiftDay(today, -1),
      );
      return campaigns.length === 0 ? null : accountDailySpend(campaigns, today, currency);
    },

    async sawTier(accountId, tier) {
      await db
        .update(connections)
        .set({ access_tier: tier, access_tier_seen_at: now().toISOString() })
        .where(
          and(
            eq(connections.account_id, accountId),
            eq(connections.provider, "meta_ads"),
            eq(connections.purpose, "execute"),
            ne(connections.status, "disconnected"),
          ),
        );
    },

    async changed(profileId, detail, meta) {
      await db.insert(watchActivity).values({
        profile_id: profileId,
        kind: "ad_changed",
        detail,
        meta,
      });
    },

    async paused({ account_id, failure }) {
      await pauseExecutionConnection({
        accountId: account_id,
        provider: "meta_ads",
        failure,
        source: "ad_change",
      });
    },

    /* ── P3-54: the ad build ── */

    consentCurrent: (accountId) => adConsentCurrent(accountId),

    adIdentity: (accountId) => adIdentityFor(accountId),

    async itemAsApproved(profileId, itemId, approvedHash) {
      const [item] = await db
        .select({
          body: contentItems.body,
          disclosure: contentItems.disclosure,
          media_path: contentItems.media_path,
        })
        .from(contentItems)
        .where(and(eq(contentItems.id, itemId), eq(contentItems.profile_id, profileId)));
      return item !== undefined && approvedPublishHash(item) === approvedHash;
    },

    async adBuild(executionId, init) {
      const existing = await buildRow(executionId);
      if (existing) return journalOf(existing);
      const [run] = await db
        .select({
          proposal_id: executions.proposal_id,
          profile_id: executions.profile_id,
          account_id: executions.account_id,
        })
        .from(executions)
        .where(eq(executions.id, executionId));
      if (!run) throw new Error("the ad build's run is missing");
      await db
        .insert(adBuilds)
        .values({
          execution_id: executionId,
          proposal_id: run.proposal_id,
          profile_id: run.profile_id,
          account_id: run.account_id,
          item_id: init.item_id,
          build_tag: init.build_tag,
        })
        .onConflictDoNothing();
      const row = await buildRow(executionId);
      if (!row) throw new Error("the ad build's journal could not be written");
      return journalOf(row);
    },

    async adStep(executionId, step, patch) {
      const column = STEP_COLUMN[step];
      await db
        .update(adBuilds)
        .set({
          steps: stepPatchSql(step, patch as Record<string, unknown>),
          ...(typeof patch.id === "string" ? { [column]: patch.id } : {}),
          updated_at: now().toISOString(),
        })
        .where(eq(adBuilds.execution_id, executionId));
    },

    async adBuildSettled(executionId, outcome) {
      const [row] = await db
        .update(adBuilds)
        .set({
          status: outcome.status,
          last_error: outcome.error ?? null,
          updated_at: now().toISOString(),
        })
        .where(eq(adBuilds.execution_id, executionId))
        .returning({ id: adBuilds.id, profile_id: adBuilds.profile_id });
      // Going live is a separate approval: proposed the moment the build is whole.
      if (row && outcome.status === "built") await proposeGoLiveAfterBuild(row.profile_id, row.id);
    },
  };
}

const STEP_COLUMN = {
  campaign: "campaign_id",
  adset: "adset_id",
  video: "video_id",
  creative: "creative_id",
  ad: "ad_id",
} as const;

async function buildRow(executionId: string) {
  const [row] = await db.select().from(adBuilds).where(eq(adBuilds.execution_id, executionId));
  return row;
}

function journalOf(row: typeof adBuilds.$inferSelect): AdBuildJournal {
  return {
    status: row.status as AdBuildJournal["status"],
    steps: (row.steps ?? {}) as AdBuildJournal["steps"],
  };
}
