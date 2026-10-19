// Per-post and per-campaign readback fixtures — P3-23, for tests only.
//
// Seeds a business with a Meta publishing EXECUTE connection, published
// content items (with the execution row that says which op published them),
// daily lifetime snapshots of each post, and — for ad changes — a Meta ads
// MEASURE connection with per-campaign spend and attributed value. Cleans
// all of it up. Nothing in app code imports this file.

import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  accounts,
  anomalies,
  businessProfiles,
  channels,
  connections,
  connectorSyncs,
  contentItems,
  executions,
  fieldRecords,
  goals,
  intakeEvents,
  metricObservations,
  offers,
  proposals,
  users,
  utterances,
  watchActivity,
} from "../../db/schema";
import { canonicalDimensions } from "../connectors/service";
import { encryptSecret } from "../connectors/secrets";
import { expectedExecutionScopes } from "../execution/connections";
import { bootstrapIntake } from "../intake/service";
import { approveProposal, createProposal, recordExecution } from "../proposals/service";
import { shiftDay } from "../trust/series";

export const FX_TOKEN = "EAAFakeReadbackSystemUserTokenForTests";
export const FX_PAGE = "1000000001";
export const FX_IG = "17800000000000001";
export const FX_SECRET = JSON.stringify({
  access_token: FX_TOKEN,
  page_id: FX_PAGE,
  ig_user_id: FX_IG,
});

export const fxScenario = {
  assumptions: [],
  base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — fixture",
} as never;

export interface FxBusiness {
  account_id: string;
  profile_id: string;
  user_id: string;
  plan_id: string;
}

const created: FxBusiness[] = [];

export async function fxBusiness(): Promise<FxBusiness> {
  const s = await bootstrapIntake();
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-23-${crypto.randomUUID()}@test.local`,
      display_name: "Readback owner",
      role: "owner",
    })
    .returning({ id: users.id });
  const plan = await createProposal({
    profile_id: s.profile_id,
    module: "content",
    action: { kind: "content_publishing", summary: "fixture plan" },
    scenario: fxScenario,
    reversibility: { level: "easy", if_you_change_your_mind: "discard" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const b = { ...s, user_id: u!.id, plan_id: plan.id };
  created.push(b);
  return b;
}

/** A connected meta_publish execute connection holding exactly its consent's scopes. */
export async function fxExecuteConnection(
  accountId: string,
  status: "connected" | "paused" = "connected",
) {
  const [row] = await db
    .insert(connections)
    .values({
      account_id: accountId,
      provider: "meta_publish",
      purpose: "execute",
      status,
      encrypted_secret: encryptSecret(FX_SECRET),
      granted_scopes: [...expectedExecutionScopes("meta_publish")],
    })
    .returning();
  return row!;
}

/** A Meta ads MEASURE connection (P2-19's read side), ads_read only. */
export async function fxMeasureMetaAds(accountId: string) {
  const [row] = await db
    .insert(connections)
    .values({
      account_id: accountId,
      provider: "meta_ads",
      purpose: "measure",
      status: "connected",
      encrypted_secret: encryptSecret(
        JSON.stringify({ ad_account_id: "act_1234567890", access_token: FX_TOKEN }),
      ),
      granted_scopes: ["ads_read"],
    })
    .returning();
  return row!;
}

export type FxOp =
  "publish_page_post" | "publish_page_photo" | "publish_page_video" | "publish_ig_media";

/** A published item, with the execution row naming the op that published it. */
export async function fxPublishedItem(
  b: FxBusiness,
  args: {
    platform: "facebook" | "instagram";
    post_id: string;
    published_at: string;
    kind?: "post" | "video";
    op?: FxOp;
    status?: "published" | "withdrawn";
    title?: string;
  },
) {
  const kind = args.kind ?? "post";
  const op: FxOp =
    args.op ??
    (args.platform === "instagram"
      ? "publish_ig_media"
      : kind === "video"
        ? "publish_page_video"
        : "publish_page_photo");
  const publish = await createProposal({
    profile_id: b.profile_id,
    module: "content",
    originating_finding: `publish:${args.post_id}`,
    action: { kind: "content_publishing", summary: `Publish ${args.post_id}`, detail: {} },
    scenario: fxScenario,
    reversibility: { level: "easy", if_you_change_your_mind: "delete it" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const [item] = await db
    .insert(contentItems)
    .values({
      profile_id: b.profile_id,
      proposal_id: b.plan_id,
      kind,
      channel_label: args.platform === "instagram" ? "Instagram" : "Facebook",
      scheduled_for: args.published_at.slice(0, 10),
      title: args.title ?? `Post ${args.post_id}`,
      body: "Fixture.\n\nWritten with AI assistance.",
      disclosure: "Written with AI assistance.",
      provenance: { test: true },
      status: args.status ?? "published",
      platform: args.platform,
      platform_post_id: args.post_id,
      published_at: args.published_at,
      publish_proposal_id: publish.id,
    })
    .returning();
  // The publish proposal names its item, as P3-21a's do.
  await db
    .update(proposals)
    .set({
      action: {
        kind: "content_publishing",
        summary: `Publish ${args.post_id}`,
        detail: { item_id: item!.id, platform: args.platform },
      },
    })
    .where(eq(proposals.id, publish.id));
  await approveProposal({ proposalId: publish.id, userId: b.user_id });
  await db
    .update(proposals)
    .set({ decided_at: args.published_at })
    .where(eq(proposals.id, publish.id));
  const [execution] = await db
    .insert(executions)
    .values({
      proposal_id: publish.id,
      profile_id: b.profile_id,
      account_id: b.account_id,
      provider: "meta_publish",
      op,
      status: "succeeded",
      attempts: 1,
      started_at: args.published_at,
      finished_at: args.published_at,
    })
    .returning({ id: executions.id });
  const executed = await recordExecution({ proposalId: publish.id, result: { ok: true } });
  await db
    .update(contentItems)
    .set({ publish_execution_id: execution!.id })
    .where(eq(contentItems.id, item!.id));
  return { item: item!, proposal: executed };
}

/** Daily lifetime snapshots of one post, by age in days after its posting day. */
export async function fxSnapshots(
  connectionId: string,
  platform: "facebook" | "instagram",
  postId: string,
  publishedDay: string,
  byAge: readonly { age: number; views?: number; reach?: number; interactions?: number }[],
) {
  const dimensions = { platform, platform_post_id: postId };
  const rows = byAge.flatMap((s) =>
    (
      [
        ["content.views.daily", s.views],
        ["content.reach.daily", s.reach],
        ["content.interactions.daily", s.interactions],
      ] as const
    ).flatMap(([metric, v]) =>
      v === undefined
        ? []
        : [
            {
              connection_id: connectionId,
              provider: "meta_publish",
              metric_key: metric,
              dimensions,
              dimension_key: canonicalDimensions(dimensions),
              period_date: shiftDay(publishedDay, s.age),
              value_num: v.toFixed(4),
              observed_at: new Date().toISOString(),
            },
          ],
    ),
  );
  if (rows.length > 0) await db.insert(metricObservations).values(rows);
}

/** Per-campaign spend and attributed value, plus the account-level coverage row, per day. */
export async function fxCampaignDays(
  connectionId: string,
  campaignRef: string,
  days: readonly { date: string; spend: number; value: number }[],
  coveredOnly: readonly string[] = [],
) {
  const camp = { currency: "EUR", campaign_ref: campaignRef, campaign_name: "Autumn push" };
  const rows = [];
  for (const d of days) {
    for (const [metric, v] of [
      ["ad_spend.campaign.daily", d.spend],
      ["ad_purchase_value.campaign.daily", d.value],
    ] as const) {
      rows.push({
        connection_id: connectionId,
        provider: "meta_ads",
        metric_key: metric,
        dimensions: camp,
        dimension_key: canonicalDimensions(camp),
        period_date: d.date,
        value_minor: v,
        currency: "EUR",
        observed_at: new Date().toISOString(),
      });
    }
  }
  for (const date of [...days.map((d) => d.date), ...coveredOnly]) {
    rows.push({
      connection_id: connectionId,
      provider: "meta_ads",
      metric_key: "ad_spend.daily",
      dimensions: { currency: "EUR" },
      dimension_key: '{"currency":"EUR"}',
      period_date: date,
      value_minor: days.find((d) => d.date === date)?.spend ?? 0,
      currency: "EUR",
      observed_at: new Date().toISOString(),
    });
  }
  if (rows.length > 0) await db.insert(metricObservations).values(rows);
}

/** An executed ad change on one campaign, decided (and run) on `day`. */
export async function fxAdChange(
  b: FxBusiness,
  args: { campaign_ref: string; change: "pause" | "raise_budget"; day: string },
) {
  const row = await createProposal({
    profile_id: b.profile_id,
    module: "ads",
    originating_finding: `ads:${args.campaign_ref}:${args.change}`,
    action: {
      kind: args.change === "pause" ? "paid_ads_decrease_or_pause" : "paid_ads_start_or_increase",
      summary: `${args.change} Autumn push`,
      detail: {
        campaign_ref: args.campaign_ref,
        campaign_name: "Autumn push",
        change: args.change,
        currency: "EUR",
      },
    },
    scenario: fxScenario,
    reversibility: { level: "easy", if_you_change_your_mind: "undo" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await approveProposal({ proposalId: row.id, userId: b.user_id });
  await db
    .update(proposals)
    .set({ decided_at: `${args.day}T09:00:00.000Z` })
    .where(eq(proposals.id, row.id));
  return recordExecution({ proposalId: row.id, result: { ok: true } });
}

/** Remove everything the fixtures (and the code under test) wrote for these businesses. */
export async function fxCleanup(): Promise<void> {
  const ids = created.map((b) => b.profile_id);
  const accountIds = created.map((b) => b.account_id);
  if (ids.length === 0) return;
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.account_id, accountIds));
  const connIds = conns.map((c) => c.id);
  if (connIds.length > 0) {
    await db.delete(anomalies).where(inArray(anomalies.connection_id, connIds));
    await db.delete(metricObservations).where(inArray(metricObservations.connection_id, connIds));
    await db.delete(connectorSyncs).where(inArray(connectorSyncs.connection_id, connIds));
  }
  await db.delete(watchActivity).where(inArray(watchActivity.profile_id, ids));
  await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
  await db.delete(executions).where(inArray(executions.profile_id, ids));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(utterances).where(inArray(utterances.profile_id, ids));
  await db.delete(goals).where(inArray(goals.profile_id, ids));
  await db.delete(channels).where(inArray(channels.profile_id, ids));
  await db.delete(offers).where(inArray(offers.profile_id, ids));
  if (connIds.length > 0) await db.delete(connections).where(inArray(connections.id, connIds));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
  created.length = 0;
}
