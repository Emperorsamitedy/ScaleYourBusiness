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
//
// And adsPlan: the due runner's route for an ad proposal, built from the
// approved proposal row — never from a client. The op follows the change
// the owner approved; the executor re-reads the campaign before it sends.

import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db";
import { connections, executions, watchActivity } from "../../db/schema";
import { activeExecutionConnection, executionSecret } from "../execution/connections";
import type { DispatchPlan } from "../execution/due";
import type { AdsBackend } from "../execution/providers/meta";
import { parseMetaExecutionCredential } from "../execution/providers/meta";
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
  };
}
