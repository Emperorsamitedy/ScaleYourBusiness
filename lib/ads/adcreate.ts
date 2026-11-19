// "Run this as an ad" — P3-54 (Session K). One approved proposal that creates,
// all PAUSED, a Meta campaign, an ad set, (for a video) an uploaded ad video,
// a creative from a content item's media, and the ad itself. Going live is a
// SEPARATE approved proposal (proposeGoLive), through resume_campaign.
//
// What is checked here, at generation, and again by the executor before
// anything is sent (lib/execution/providers/meta.ts):
//
//   the watch     nothing is proposed while a business is being watched (rule 15)
//   the item      a post or video with its image or clip, drafted or queued —
//                 the caption exactly as it goes out (with its AI disclosure,
//                 rule 17) and the media, hashed, so what runs is what was seen
//   the spend     a daily budget at or above Meta's floor, inside the owner's
//                 stated monthly ceiling over the whole account (8.1i) — and
//                 no ceiling, no new spend (lib/ads/guard, newSpendGuard)
//   the audience  the owner's country (or a radius from real coordinates), an
//                 age band, interests left broad, named placements; special
//                 ad categories set with Meta's restricted targeting, or the
//                 ad refused (lib/ads/targeting) — never bypassed
//   the limits    the owner's 13.5 hard limits (rule 14): a no_paid_ads limit
//                 makes the proposal born blocked, shown as restraint
//
// The scenario is arithmetic from the owner's own measured numbers where they
// exist (the simulator's conventions, lib/simulate): spend is the budget ×
// days, at most; what comes back is the spend × the measured spread of the
// business's own campaigns' weekly return on ad spend, × its margin. Reach is
// not forecast — Meta's reach for an ad isn't read yet, and the card says so.
// No model call anywhere here except the hard limits' one-time parse.
//
// Audience input: an explicit AdAudienceInput, else the creative brief the
// item was made from (lib/content/brief-links), else a conservative default
// derived from the profile.

import { randomBytes } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  adBuilds,
  businessProfiles,
  contentItems,
  decisionLog,
  executions,
  proposals,
} from "../../db/schema";
import { careState } from "../care/day-zero";
import { enumCode } from "../core/enum-value";
import { format, money, roundMinorTo } from "../core/money";
import type { ScenarioBlock } from "../diagnosis/recommendations";
import { activeExecutionConnection, executionSecret } from "../execution/connections";
import { consentLines, hashConsentPayload } from "../execution/consent";
import { EXECUTION_SETUP } from "../execution/setup";
import type { AdRunParams } from "../execution/providers/meta";
import {
  approvedPublishHash,
  parseMetaExecutionCredential,
  publishCaption,
} from "../execution/providers/meta";
import { countryCode } from "../hours/timezone";
import { readCurrentField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import {
  checkHardLimits,
  ensureHardLimits,
  limitCaption,
  liveLimitLlm,
} from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal } from "../proposals/service";
import { gatherInputs } from "../simulate/inputs";
import {
  ADCREATE,
  AD_RUN_UNDO,
  CREATES_PAUSED_NOTE,
  GO_LIVE_UNDO,
  adReadiness,
  adScenario,
} from "./ad-run";
import type { AdItemLike } from "./ad-run";
import { shiftDay } from "../trust/series";
import { suppressedKinds } from "../trust/suppression";
import { NO_CEILING_FOR_NEW_SPEND, dailyBudgetFloor, newSpendGuard, toMetaBudget } from "./guard";
import {
  ADS,
  ADS_MODULE,
  accountDailySpend,
  loadCampaignSeries,
  monthlyAdCeiling,
} from "./proposals";
import { briefAudienceOf, briefForItem } from "../content/brief-links";
import type { AdAudienceInput, AdGoal } from "./targeting";
import {
  AD_GOALS,
  DSA_COUNTRIES,
  SPECIAL_CATEGORY_WORD,
  buildTargeting,
  specialCategories,
} from "./targeting";
import { watchingUntil } from "../care/watch-words";

export { ADCREATE, AD_RUN_UNDO, CREATES_PAUSED_NOTE, GO_LIVE_UNDO, adReadiness, adScenario };
export type { AdItemLike };

/** The proposal kind both ad-creation proposals are filed under (a no_paid_ads limit blocks it). */
export const AD_RUN_KIND = "paid_ads_start_or_increase";

const AD_RUN_SENDING =
  "Approved, it goes to Meta on the next scheduled run: a dry run before each part, then the campaign, ad set, creative and ad, one after another, all paused and re-checked against your limits. The emergency stop halts it between any two. Meta ad changes stay switched off until the two-week unattended test completes; until then it waits, approved.";

const GO_LIVE_SENDING =
  "Approved, it goes to Meta on the next scheduled run: the ad, then its ad set, then the campaign are switched on, each with a dry run first, re-checked against your ceiling. Meta ad changes stay switched off until the two-week unattended test completes; until then it waits, approved.";

/* ── the profile reads ── */

async function textField(profileId: string, key: string): Promise<string | null> {
  const f = await readCurrentField<unknown>(profileId, key);
  if (!f || f.status !== "answered") return null;
  return typeof f.value === "string" && f.value.trim() !== "" ? f.value.trim() : null;
}

async function codeField(profileId: string, key: string): Promise<string | null> {
  const f = await readCurrentField<unknown>(profileId, key);
  if (!f || f.status !== "answered") return null;
  return enumCode(f.value) ?? null;
}

/**
 * Rule 13 for the new ops: the meta_ads connection's consent row covers
 * TODAY's consent lines. The row stores only a hash of what was shown and
 * typed; recomputed with today's lines (and the one phrase the screen
 * accepts), it matches only a consent given to today's wording — so a
 * connection agreed before ad creation was in the consent has not agreed to it.
 */
export async function adConsentCurrent(accountId: string): Promise<boolean> {
  const row = await activeExecutionConnection(accountId, "meta_ads");
  const phrase = EXECUTION_SETUP.meta_ads?.confirm_phrase;
  if (!row || phrase === undefined) return false;
  const expected = hashConsentPayload({
    account_id: accountId,
    connection_id: row.id,
    provider: "meta_ads",
    granted_scopes: row.granted_scopes,
    consent_lines: consentLines("meta_ads"),
    typed_confirmation: phrase,
  });
  const [hit] = await db
    .select({ id: decisionLog.id })
    .from(decisionLog)
    .where(
      and(
        eq(decisionLog.kind, "consent"),
        eq(decisionLog.ref_id, row.id),
        eq(decisionLog.payload_hash, expected),
      ),
    )
    .limit(1);
  return hit !== undefined;
}

/** The sentence when the ad connection's consent predates ad creation. */
export const RECONSENT_FOR_ADS =
  "your Meta ad connection was agreed before ScaleX could create ads — reconnect it on Connections to agree to the new wording";

/** The Page (and Instagram account) an ad runs as: the publish connection's ids, never its token. */
export async function adIdentityFor(
  accountId: string,
): Promise<{ page_id: string; ig_user_id: string | null } | { refused: string }> {
  const row = await activeExecutionConnection(accountId, "meta_publish");
  if (!row || row.status !== "connected") {
    return {
      refused:
        "An ad runs as your Facebook Page, and ScaleX reads which Page from the Meta publishing connection — connect it on Connections. Nothing was created.",
    };
  }
  const cred = parseMetaExecutionCredential(executionSecret(row), "meta_publish");
  if (cred.page_id === null) {
    return { refused: "The Meta publishing connection names no Page. Nothing was created." };
  }
  return { page_id: cred.page_id, ig_user_id: cred.ig_user_id };
}

async function watchSkip(profileId: string, now: Date): Promise<string | null> {
  const care = await careState(profileId);
  if (!care) return "not in care yet — no mode decision";
  if (care.watch_ends_at && now.toISOString() < care.watch_ends_at) {
    return watchingUntil(care.watch_ends_at);
  }
  return null;
}

/** Live proposal states: one of these on the same item means it is already proposed. */
const LIVE_STATES = ["pending", "approved", "blocked", "executed"] as const;

export interface AdRunArgs {
  item_id: string;
  /** From a creative brief or the owner; absent → a conservative default from the profile. */
  audience?: AdAudienceInput | null;
  daily_budget_minor?: number;
  run_days?: number;
  now?: Date;
  limitLlm?: LimitLlm;
}

export type AdRunOutcome = { created: ProposalRow } | { skipped: string };

/** Make the one "Run this ad" proposal for an item — through every gate — or say why not. */
export async function proposeAdRun(profileId: string, args: AdRunArgs): Promise<AdRunOutcome> {
  const now = args.now ?? new Date();
  const watching = await watchSkip(profileId, now);
  if (watching) return { skipped: watching };

  const [item] = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.id, args.item_id), eq(contentItems.profile_id, profileId)));
  if (!item) return { skipped: "no such item" };
  const ready = adReadiness(item);
  if (!ready.ok) return { skipped: `I can't run this as an ad: ${ready.reason}` };
  // Session K: an item made from a creative brief brings the brief's audience.
  const audience = args.audience ?? briefAudienceOf(await briefForItem(profileId, item.provenance));

  const ref = `ads:run:${item.id}`;
  const [already] = await db
    .select({ id: proposals.id, status: proposals.status })
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        eq(proposals.originating_finding, ref),
        inArray(proposals.status, [...LIVE_STATES]),
      ),
    )
    .limit(1);
  if (already) return { skipped: `this item is already proposed as an ad (${already.status})` };
  const silenced = (await suppressedKinds(profileId)).get(AD_RUN_KIND);
  if (silenced) {
    return {
      skipped: `you've declined this kind of ad change ${silenced.rejections} times: I've stopped proposing it`,
    };
  }

  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) return { skipped: "no such business" };
  const ads = await activeExecutionConnection(profile.account_id, "meta_ads");
  if (!ads || ads.status !== "connected") {
    return { skipped: "connect Meta ad management on Connections first" };
  }
  if (!(await adConsentCurrent(profile.account_id))) return { skipped: RECONSENT_FOR_ADS };
  const identity = await adIdentityFor(profile.account_id);
  if ("refused" in identity)
    return { skipped: identity.refused.replace(" Nothing was created.", "") };

  // The spend: Meta's floor, the owner's ceiling, the account's measured days.
  const ceiling = await monthlyAdCeiling(profileId);
  if (!ceiling) return { skipped: `I won't propose this: ${NO_CEILING_FOR_NEW_SPEND}` };
  const currency = ceiling.currency.toUpperCase();
  const floor = dailyBudgetFloor(currency, null);
  if (floor === null) {
    return {
      skipped: `I don't know Meta's minimum daily budget in ${currency}, so I won't set one`,
    };
  }
  const today = now.toISOString().slice(0, 10);
  const series = await loadCampaignSeries(
    profile.account_id,
    shiftDay(today, -(ADS.raise_window_days + 1)),
    shiftDay(today, -1),
  );
  const accountDaily = series.length === 0 ? 0 : accountDailySpend(series, today, currency);
  // Floored to a whole multiple of 30 first, so the division is exact (hard rule 1).
  const headroomMonthly = ceiling.amount_minor - accountDaily * 30;
  const headroomDaily = roundMinorTo(headroomMonthly, 30, "down") / 30;
  let daily: number;
  try {
    const asked =
      args.daily_budget_minor ??
      // Never under Meta's floor: with no room under the ceiling, the guard below says so in figures.
      Math.max(floor, Math.min(floor * ADCREATE.default_floor_multiple, headroomDaily));
    daily = toMetaBudget(Math.max(0, Math.floor(asked)), currency).sent_minor;
  } catch (error) {
    return { skipped: error instanceof Error ? error.message : "the budget can't be sent to Meta" };
  }
  const spendRefusal = newSpendGuard({
    daily_minor: daily,
    currency,
    account_daily_minor: accountDaily,
    monthly_ceiling: ceiling,
    floor_minor: floor,
  });
  if (spendRefusal) return { skipped: `I won't propose this: ${spendRefusal}` };
  const runDays = args.run_days ?? ADCREATE.default_run_days;
  if (
    !Number.isInteger(runDays) ||
    runDays < ADCREATE.min_run_days ||
    runDays > ADCREATE.max_run_days
  ) {
    return {
      skipped: `an ad runs for ${ADCREATE.min_run_days} to ${ADCREATE.max_run_days} days, not ${runDays}`,
    };
  }

  // Who it's for: special categories first (no bypass), then the audience.
  const [businessType, restrictions, countryRaw, website, legalName] = await Promise.all([
    codeField(profileId, "identity.business_type"),
    textField(profileId, "legal.advertising_restrictions"),
    textField(profileId, "legal.country"),
    textField(profileId, "presence.website_url"),
    textField(profileId, "identity.legal_name"),
  ]);
  const verdict = specialCategories({
    business_type: businessType,
    restrictions_text: restrictions,
    item_text: `${item.title}\n${item.body}`,
  });
  if (verdict.refused) return { skipped: verdict.refused };
  const profileCountry = countryRaw ? countryCode(countryRaw) : null;
  const target = buildTargeting({
    audience: audience ?? null,
    profile_country: profileCountry,
    categories: verdict.categories,
    instagram: identity.ig_user_id !== null,
    video: ready.media.kind === "video",
    countryCode,
  });
  if ("refused" in target) return { skipped: `I won't propose this: ${target.refused}` };

  const geo = target.targeting.geo_locations;
  const shownIn = "countries" in geo ? geo.countries[0]! : profileCountry;
  let dsa: AdRunParams["dsa"] = null;
  if (shownIn === null || DSA_COUNTRIES.has(shownIn)) {
    if (!legalName) {
      return {
        skipped:
          "an ad shown in the EU names the business it is for — tell me the business's name first (question 1.1)",
      };
    }
    dsa = { beneficiary: legalName.slice(0, 200), payor: legalName.slice(0, 200) };
  }

  const site = website && /^https:\/\/\S+$/i.test(website) ? website : null;
  const goal: AdGoal = site ? "traffic" : "awareness";
  const g = AD_GOALS[goal];
  const link = site ?? `https://www.facebook.com/${identity.page_id}`;
  const caption = publishCaption(item);
  const name = item.title.trim().slice(0, 100) || "ScaleX ad";
  const ad: AdRunParams = {
    build_tag: `SYB-${randomBytes(4).toString("hex")}`,
    item_id: item.id,
    approved_hash: approvedPublishHash(item),
    name,
    objective: g.objective,
    optimization_goal: g.optimization_goal,
    destination_type: g.destination_type,
    special_ad_categories: verdict.categories,
    daily_budget_minor: daily,
    currency,
    run_days: runDays,
    targeting: target.targeting as unknown as Record<string, unknown>,
    page_id: identity.page_id,
    ig_user_id: identity.ig_user_id,
    media: ready.media,
    caption,
    link,
    call_to_action: g.call_to_action,
    dsa,
  };

  const inputs = await gatherInputs(profileId, now);
  const sized = adScenario({
    daily_minor: daily,
    run_days: runDays,
    currency,
    campaigns: inputs.ads.campaigns,
    margin: inputs.margin,
    as_of: inputs.as_of,
  });
  const limits = (await ensureHardLimits(profileId, args.limitLlm ?? liveLimitLlm)).limits;
  const hard = checkHardLimits(limits, AD_RUN_KIND);
  const fmt = (v: number) => format(money(v, currency));

  const row = await createProposal({
    profile_id: profileId,
    module: ADS_MODULE,
    originating_finding: ref,
    action: {
      kind: AD_RUN_KIND,
      summary: `Run "${name}" as a Meta ad — ${fmt(daily)} a day for ${runDays} days, created paused`,
      detail: {
        change: "run_ad",
        item_id: item.id,
        item_title: item.title,
        ad,
        budget: {
          daily_minor: daily,
          currency,
          run_days: runDays,
          total_minor: daily * runDays,
          ceiling_minor: ceiling.amount_minor,
          account_daily_minor: accountDaily,
        },
        audience: target.words,
        goal: g.words,
        special_ad_categories: verdict.categories.map((c) => SPECIAL_CATEGORY_WORD[c]),
        special_why: verdict.why,
        notes: target.notes,
        creates: [
          "campaign",
          "ad set",
          ...(ready.media.kind === "video" ? ["ad video"] : []),
          "creative",
          "ad",
        ],
        paused_note: CREATES_PAUSED_NOTE,
        // What it creates can't be removed (Meta's DELETED and ARCHIVED are permanent).
        irreversible: true,
        currency,
        execute_on_approval: true,
        sending: AD_RUN_SENDING,
        manual_limits: hard.manual.map((l) => l.quote),
        ...(audience ? { audience_from: "brief" } : { audience_from: "profile" }),
      },
    },
    scenario: sized.scenario,
    reversibility: { level: "hard", if_you_change_your_mind: AD_RUN_UNDO },
    expires_at: new Date(now.getTime() + ADCREATE.expiry_days * 86_400_000).toISOString(),
    blocked_by_limit: hard.verdict === "blocked" ? limitCaption(hard.limit) : null,
  });
  return { created: row };
}

/** A hard-limit parse is never made from inside the ads path: an unparsed limit leaves it to the owner's button. */
const noModelInTheAdsPath: LimitLlm = async () => {
  throw new Error("the hard limits need a fresh parse — propose going live from Content");
};

/**
 * The separate "go live" proposal for a finished build: resume_campaign with
 * the build's ad set and ad. Made automatically when a build completes
 * (without a model call — a limit that needs parsing leaves it to the owner's
 * "Propose going live" on Content), and by that button. One per build.
 */
export async function proposeGoLive(
  profileId: string,
  buildId: string,
  opts: { now?: Date; limitLlm?: LimitLlm } = {},
): Promise<AdRunOutcome> {
  const now = opts.now ?? new Date();
  const [build] = await db
    .select()
    .from(adBuilds)
    .where(and(eq(adBuilds.id, buildId), eq(adBuilds.profile_id, profileId)));
  if (!build) return { skipped: "no such ad" };
  if (build.status !== "built" || !build.campaign_id || !build.adset_id || !build.ad_id) {
    return { skipped: "the ad isn't fully created on Meta yet" };
  }
  if (build.go_live_proposal_id) {
    const [prior] = await db
      .select({ status: proposals.status })
      .from(proposals)
      .where(eq(proposals.id, build.go_live_proposal_id));
    if (prior && (LIVE_STATES as readonly string[]).includes(prior.status)) {
      return { skipped: `going live is already proposed (${prior.status})` };
    }
  }
  const watching = await watchSkip(profileId, now);
  if (watching) return { skipped: watching };
  const [source] = await db.select().from(proposals).where(eq(proposals.id, build.proposal_id));
  const detail = (source?.action as { detail?: { ad?: AdRunParams; audience?: unknown } } | null)
    ?.detail;
  const ad = detail?.ad;
  if (!source || !ad) return { skipped: "the approved ad can't be read" };
  const limits = (await ensureHardLimits(profileId, opts.limitLlm ?? liveLimitLlm)).limits;
  const hard = checkHardLimits(limits, AD_RUN_KIND);
  const fmt = (v: number) => format(money(v, ad.currency));

  const row = await createProposal({
    profile_id: profileId,
    module: ADS_MODULE,
    originating_finding: `ads:live:${build.id}`,
    action: {
      kind: AD_RUN_KIND,
      summary: `Put "${ad.name}" live on Meta — ${fmt(ad.daily_budget_minor)} a day for ${ad.run_days} days`,
      detail: {
        change: "go_live",
        build_id: build.id,
        item_id: build.item_id,
        campaign_ref: build.campaign_id,
        campaign_name: ad.name,
        adset_id: build.adset_id,
        ad_id: build.ad_id,
        run_days: ad.run_days,
        budget: {
          daily_minor: ad.daily_budget_minor,
          currency: ad.currency,
          run_days: ad.run_days,
          total_minor: ad.daily_budget_minor * ad.run_days,
        },
        audience: detail?.audience ?? null,
        currency: ad.currency,
        execute_on_approval: true,
        sending: GO_LIVE_SENDING,
        manual_limits: hard.manual.map((l) => l.quote),
      },
    },
    scenario: source.scenario as ScenarioBlock,
    reversibility: { level: "easy", if_you_change_your_mind: GO_LIVE_UNDO },
    expires_at: new Date(now.getTime() + ADCREATE.expiry_days * 86_400_000).toISOString(),
    blocked_by_limit: hard.verdict === "blocked" ? limitCaption(hard.limit) : null,
  });
  await db
    .update(adBuilds)
    .set({ go_live_proposal_id: row.id, updated_at: now.toISOString() })
    .where(eq(adBuilds.id, build.id));
  return { created: row };
}

/** Called once a build completes: the go-live proposal, made without a model call. Never throws. */
export async function proposeGoLiveAfterBuild(profileId: string, buildId: string): Promise<void> {
  try {
    const out = await proposeGoLive(profileId, buildId, { limitLlm: noModelInTheAdsPath });
    console.log(
      JSON.stringify({
        event: "ad_go_live_proposed",
        profile_id: profileId,
        build_id: buildId,
        ...("created" in out ? { proposal_id: out.created.id } : { skipped: out.skipped }),
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "ad_go_live_proposal_failed",
        profile_id: profileId,
        build_id: buildId,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
}

/* ── the due runner's sweep ── */

/**
 * A build run that died mid-way (the process ended between two creates)
 * stays `running` for ever, and nothing would pick it up. After
 * ADCREATE.stale_run_ms it is closed failed, held "remaining", so the next
 * run resumes it from its journal — every step with an id skipped, a step
 * sent without an answer read back, never sent twice.
 */
export async function reclaimStaleAdBuilds(now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(executions)
    .set({
      status: "failed",
      held_for: "remaining",
      error:
        "The ad's build stopped part-way. It carries on from where it stopped on the next run — nothing is created twice, and nothing is live.",
      finished_at: now.toISOString(),
    })
    .where(
      and(
        eq(executions.provider, "meta_ads"),
        eq(executions.op, "create_ad_paused"),
        eq(executions.status, "running"),
        lt(executions.started_at, new Date(now.getTime() - ADCREATE.stale_run_ms).toISOString()),
      ),
    )
    .returning({ id: executions.id, account_id: executions.account_id });
  for (const r of rows) {
    console.log(
      JSON.stringify({ event: "ad_build_reclaimed", account_id: r.account_id, execution_id: r.id }),
    );
  }
  return rows.length;
}

/* ── what /content shows ── */

export interface AdItemState {
  /** Why it can't be an ad, when it can't. */
  reason: string | null;
  proposal: { id: string; status: string } | null;
  build: {
    id: string;
    status: string;
    last_error: string | null;
    campaign_id: string | null;
    ad_id: string | null;
  } | null;
  go_live: { id: string; status: string } | null;
}

/** Per item: can it be an ad, and where its ad stands — proposal, build, go-live. */
export async function adItemStates(
  profileId: string,
  items: readonly (AdItemLike & { id: string })[],
): Promise<Record<string, AdItemState>> {
  const out: Record<string, AdItemState> = {};
  if (items.length === 0) return out;
  const refs = items.map((i) => `ads:run:${i.id}`);
  const props = await db
    .select({
      id: proposals.id,
      status: proposals.status,
      ref: proposals.originating_finding,
      created_at: proposals.created_at,
    })
    .from(proposals)
    .where(and(eq(proposals.profile_id, profileId), inArray(proposals.originating_finding, refs)));
  const builds = await db
    .select()
    .from(adBuilds)
    .where(
      and(
        eq(adBuilds.profile_id, profileId),
        inArray(
          adBuilds.item_id,
          items.map((i) => i.id),
        ),
      ),
    );
  const liveIds = builds.map((b) => b.go_live_proposal_id).filter((v): v is string => v !== null);
  const lives = liveIds.length
    ? await db
        .select({ id: proposals.id, status: proposals.status })
        .from(proposals)
        .where(inArray(proposals.id, liveIds))
    : [];
  for (const item of items) {
    const ready = adReadiness(item);
    const mine = props
      .filter((p) => p.ref === `ads:run:${item.id}`)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const build = builds
      .filter((b) => b.item_id === item.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const live = build?.go_live_proposal_id
      ? lives.find((l) => l.id === build.go_live_proposal_id)
      : undefined;
    out[item.id] = {
      reason: ready.ok ? null : ready.reason,
      proposal: mine ? { id: mine.id, status: mine.status } : null,
      build: build
        ? {
            id: build.id,
            status: build.status,
            last_error: build.last_error,
            campaign_id: build.campaign_id,
            ad_id: build.ad_id,
          }
        : null,
      go_live: live ? { id: live.id, status: live.status } : null,
    };
  }
  return out;
}

/** For the executor's backend: one step's patch, merged into the journal. Pure SQL helper. */
export function stepPatchSql(step: string, patch: Record<string, unknown>) {
  return sql`jsonb_set(${adBuilds.steps}, ${`{${step}}`}::text[], coalesce(${adBuilds.steps} -> ${step}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, true)`;
}
