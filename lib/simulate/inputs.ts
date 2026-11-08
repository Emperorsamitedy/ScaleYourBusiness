// The campaign simulator's database side — feature 36. Reads the raw
// figures lib/simulate/model.ts works from, and nothing else: every read
// is one the product already makes elsewhere (the segments, the campaign
// series, the per-post snapshots, the measured daily series, the
// economics engine, the readbacks). Read-only; no model call anywhere.

import { and, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  contentItems,
  metricObservations,
  proposals,
} from "../../db/schema";
import type { Basis } from "../../components/report/basis";
import { basisOf } from "../../components/report/basis";
import { loadCampaignSeries, monthlyAdCeiling, platformOf } from "../ads/proposals";
import { CADENCE, listChannels } from "../content/plan";
import { listContacts, outboundPosture } from "../crm/contacts";
import { SEGMENT_KIND, SEGMENT_MODULE } from "../crm/segment-proposals";
import { computeSegments } from "../crm/segments";
import { computeEconomics } from "../economics/unit-economics";
import type { ProposalRow } from "../proposals/service";
import type { Field } from "../core/field";
import { readCurrentField } from "../profile/field-store";
import { ensureSnapshot, readSnapshot } from "../profile/snapshot";
import { campaignOutcome } from "../trust/campaign-readback";
import { campaignKind, emailCampaignOutcome } from "../trust/email-readback";
import { audienceMetricFor, comparisonAge, loadPostSnapshots } from "../trust/post-readback";
import { executedOn } from "../trust/readback";
import { dailySeries, shiftDay } from "../trust/series";
import type {
  CampaignRaw,
  CrossCheck,
  PastEmailCampaign,
  PostRaw,
  SimInputs,
  SimKind,
} from "./model";
import { SIM, adsWindow } from "./model";
import type { SimulationRecord } from "./scenario";
import type { SimText } from "./words";
import { englishSimText, int, section } from "./words";

/** A sent campaign as the readback judged it. */
interface PastWithVerdict {
  row: ProposalRow;
  campaign: PastEmailCampaign;
  verdict: string;
}

/** The basis of a profile fact, or null when it holds no value. */
function factBasis(f: Field<unknown> | null): Basis | null {
  if (!f) return null;
  return basisOf({
    status: f.status,
    source_kind: f.source.kind,
    note: f.note,
    confidence: Number(f.confidence),
  });
}

const valueBearing = (f: Field<unknown> | null): boolean =>
  f !== null && (f.status === "answered" || f.status === "inferred") && f.value !== null;

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function asMoney(v: unknown): { amount_minor: number; currency: string } | null {
  const m = v as { amount_minor?: unknown; currency?: unknown } | null;
  return m && Number.isSafeInteger(m.amount_minor) && typeof m.currency === "string"
    ? { amount_minor: m.amount_minor as number, currency: m.currency }
    : null;
}

/**
 * Everything the simulator needs for one business, as of `now`. The
 * cross-check sentences are in `words` (L-4b): the route passes the
 * request's; the proposal path keeps the English default.
 */
export async function gatherInputs(
  profileId: string,
  now: Date = new Date(),
  words: SimText = englishSimText(),
): Promise<SimInputs> {
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id, currency: accounts.reporting_currency })
    .from(businessProfiles)
    .innerJoin(accounts, eq(accounts.id, businessProfiles.account_id))
    .where(eq(businessProfiles.id, profileId));
  if (!profile) throw new Error("no such business");
  const accountId = profile.account_id;
  const currency = profile.currency;
  const asOf = now.toISOString().slice(0, 10);
  const siteTo = shiftDay(asOf, -1);
  const siteFrom = shiftDay(siteTo, -(SIM.site_window_days - 1));

  /* margin — the economics engine's blended figure, and the owner's own */
  const snapshot = await readSnapshot((await ensureSnapshot(profileId)).id);
  const economics = computeEconomics(snapshot, currency);
  const statedMargin = await readCurrentField<unknown>(profileId, "costs.gross_margin");
  const statedPct = statedMargin?.status === "answered" ? asNumber(statedMargin.value) : null;

  /* the site: measured days, then the owner's own monthly figures */
  const [orders, sessions, revenue] = await Promise.all([
    dailySeries(profileId, "orders.daily", siteFrom, siteTo),
    dailySeries(profileId, "sessions.daily", siteFrom, siteTo),
    dailySeries(profileId, "revenue.daily", siteFrom, siteTo),
  ]);
  const siteDays: { sessions: number; orders: number }[] = [];
  const aovDays: number[] = [];
  const revenueUsable =
    revenue !== null && revenue.currencies.size === 1 && revenue.currency === currency;
  for (let d = siteFrom; d <= siteTo; d = shiftDay(d, 1)) {
    const o = orders?.values.get(d);
    const s = sessions?.values.get(d);
    if (o !== undefined && s !== undefined) siteDays.push({ sessions: s, orders: o });
    const r = revenueUsable ? revenue.values.get(d) : undefined;
    if (o !== undefined && o > 0 && r !== undefined) aovDays.push(Math.round(r / o));
  }
  const [statedOrders, statedSessions, statedRevenue] = await Promise.all([
    readCurrentField<unknown>(profileId, "revenue.order_count_monthly"),
    readCurrentField<unknown>(profileId, "presence.monthly_sessions"),
    readCurrentField<unknown>(profileId, "revenue.monthly_revenue"),
  ]);
  const ordersMonthly = valueBearing(statedOrders) ? asNumber(statedOrders!.value) : null;
  const sessionsMonthly = valueBearing(statedSessions) ? asNumber(statedSessions!.value) : null;
  const revenueMonthly = valueBearing(statedRevenue) ? asMoney(statedRevenue!.value) : null;
  const statedAov =
    revenueMonthly && revenueMonthly.currency === currency && ordersMonthly && ordersMonthly > 0
      ? Math.round(revenueMonthly.amount_minor / ordersMonthly)
      : null;

  /* email — the segments behind the consent gate, and past campaigns read back */
  const [posture, segmentReport, contacts] = await Promise.all([
    outboundPosture(profileId),
    computeSegments(accountId, now),
    listContacts(accountId),
  ]);
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const segments = (["lapsed", "vip"] as const).map((key) => {
    const s = segmentReport.segments.find((x) => x.key === key)!;
    const values = s.emailable_ids
      .map((id) => byId.get(id))
      .filter(
        (c) =>
          c !== undefined &&
          c.total_spent_minor !== null &&
          c.spent_currency === currency &&
          (c.orders_count ?? 0) > 0,
      )
      .map((c) => Math.round(c!.total_spent_minor! / c!.orders_count!));
    return {
      key,
      label: s.label,
      members: s.contact_ids.length,
      emailable: s.emailable_ids.length,
      order_values_minor: values,
    };
  });
  const emailRows = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        eq(proposals.module, SEGMENT_MODULE),
        inArray(proposals.status, ["approved", "executed"]),
      ),
    )
    .orderBy(desc(proposals.created_at));
  const emailPast: PastWithVerdict[] = [];
  for (const row of emailRows) {
    if ((row.action as { kind?: unknown }).kind !== SEGMENT_KIND) continue;
    const o = await emailCampaignOutcome(row);
    if (o.delivery.sent === 0) continue;
    emailPast.push({
      row,
      verdict: o.verdict,
      campaign: {
        kind: campaignKind(row.action),
        sent_on: o.sent_on,
        sent: o.delivery.sent,
        delivered: o.delivery.delivered,
        bounced: o.delivery.bounced,
        harmed: o.delivery.harmed,
        measured: o.recipients.measured,
        returned: o.recipients.returned,
      },
    });
  }

  /* ads — the per-campaign series and the stated ceiling */
  const metaMeasure = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.provider, "meta_ads"),
        eq(connections.purpose, "measure"),
      ),
    );
  const win = adsWindow(asOf);
  // The simulator's campaigns are Meta's (its asks go to Meta's campaigns, by ref).
  const series = (await loadCampaignSeries(accountId, win.from, win.to)).filter(
    (s) => platformOf(s) === "meta",
  );
  const campaigns: CampaignRaw[] = series.map((s) => ({
    ref: s.campaign_ref,
    name: s.campaign_name,
    currency: s.currency,
    days: s.days.map((d) => ({ ...d })),
  }));

  /* content — the previous posts at the same age, and visits from social */
  const content = await contentInputs(profileId, accountId, siteFrom, siteTo);

  /* the trust layer: did past predictions land inside their range? */
  const cross_check: Record<SimKind, CrossCheck> = {
    email: emailCrossCheck(emailPast, words),
    ads: await adsCrossCheck(profileId, accountId, now, words),
    content: await contentCrossCheck(profileId, words),
  };

  return {
    as_of: asOf,
    currency,
    margin: {
      computed_pct: economics.blended_margin_pct?.value ?? null,
      computed_formula: economics.blended_margin_pct?.formula ?? null,
      stated_pct: statedPct,
      stated_basis: statedPct === null ? null : factBasis(statedMargin),
    },
    aov: {
      measured_daily_minor: aovDays,
      stated_minor: statedAov,
      stated_basis: statedAov === null ? null : factBasis(statedRevenue),
    },
    email: {
      posture,
      contacts: contacts.length,
      segments,
      past: emailPast.map((p) => p.campaign),
    },
    ads: {
      connected: metaMeasure.length > 0,
      campaigns,
      ceiling: await monthlyAdCeiling(profileId),
    },
    content,
    site: {
      days: siteDays,
      stated_orders_monthly: ordersMonthly,
      stated_sessions_monthly: sessionsMonthly,
      stated_basis: ordersMonthly === null ? null : factBasis(statedOrders),
    },
    cross_check,
  };
}

async function contentInputs(
  profileId: string,
  accountId: string,
  from: string,
  to: string,
): Promise<SimInputs["content"]> {
  const conns = await db
    .select({
      id: connections.id,
      provider: connections.provider,
      purpose: connections.purpose,
      status: connections.status,
    })
    .from(connections)
    .where(eq(connections.account_id, accountId));
  const publishConnected = conns.some(
    (c) => c.provider === "meta_publish" && c.purpose === "execute" && c.status === "connected",
  );
  const ga4 = conns.filter((c) => c.provider === "ga4");

  const items = await db
    .select({
      platform: contentItems.platform,
      platform_post_id: contentItems.platform_post_id,
      published_at: contentItems.published_at,
    })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.profile_id, profileId),
        inArray(contentItems.status, ["published", "withdrawn"]),
        inArray(contentItems.platform, ["facebook", "instagram"]),
        isNotNull(contentItems.platform_post_id),
        isNotNull(contentItems.published_at),
      ),
    )
    .orderBy(desc(contentItems.published_at));
  const counts = { instagram: 0, facebook: 0 };
  for (const i of items) counts[i.platform as "instagram" | "facebook"]++;
  const platform =
    counts.instagram === 0 && counts.facebook === 0
      ? null
      : counts.instagram >= counts.facebook
        ? "instagram"
        : "facebook";

  const posts: PostRaw[] = [];
  let windowInteractions: number | null = null;
  if (platform) {
    const mine = items.filter((i) => i.platform === platform);
    const snapshots = await loadPostSnapshots(
      accountId,
      platform,
      mine.map((i) => i.platform_post_id as string),
    );
    const metric = audienceMetricFor(platform);
    for (const i of mine.slice(0, SIM.content_baseline_posts)) {
      const day = (i.published_at as string).slice(0, 10);
      const snaps = snapshots.get(i.platform_post_id as string);
      const { age } = comparisonAge(day, snaps);
      if (age === null) continue;
      const f = snaps?.get(shiftDay(day, age));
      if (!f) continue;
      posts.push({ reach: metric === "reach" ? f.reach : f.views, interactions: f.interactions });
    }
    // Interactions on the posts that went out in the site window, at their latest snapshot.
    const inWindow = mine.filter((i) => {
      const day = (i.published_at as string).slice(0, 10);
      return day >= from && day <= to;
    });
    if (inWindow.length > 0) {
      let sum = 0;
      let any = false;
      for (const i of inWindow) {
        const snaps = snapshots.get(i.platform_post_id as string);
        const latest = [...(snaps?.keys() ?? [])].sort().pop();
        const v = latest ? snaps?.get(latest)?.interactions : null;
        if (typeof v === "number") {
          sum += v;
          any = true;
        }
      }
      windowInteractions = any ? sum : null;
    }
  }

  let socialSessions: number | null = null;
  if (ga4.length > 0) {
    const rows = await db
      .select({
        value_num: metricObservations.value_num,
        dimensions: metricObservations.dimensions,
      })
      .from(metricObservations)
      .where(
        and(
          inArray(
            metricObservations.connection_id,
            ga4.map((c) => c.id),
          ),
          eq(metricObservations.metric_key, "sessions.daily"),
          gte(metricObservations.period_date, from),
          lte(metricObservations.period_date, to),
        ),
      );
    const social = rows.filter((r) => r.dimensions?.channel_ref === SIM.social_channel_ref);
    socialSessions =
      social.length > 0 ? social.reduce((s, r) => s + Number(r.value_num ?? 0), 0) : null;
  }

  const channels = await listChannels(profileId);
  return {
    platform,
    publish_connected: publishConnected,
    posts,
    social_channels: channels.filter((c) => c.type === "social_organic").length,
    per_week: CADENCE.social_organic?.per_week ?? 0,
    analytics_connected: ga4.length > 0,
    social_sessions: socialSessions,
    window_interactions: windowInteractions,
  };
}

/* ── the cross-checks: what the scorecard can say about similar past proposals ── */

const simulationOf = (row: ProposalRow): SimulationRecord | null => {
  const sim = (row.scenario as { simulation?: SimulationRecord } | null)?.simulation;
  return sim && sim.version === 1 ? sim : null;
};

const inside = (v: number, r: { low: number; high: number }) =>
  v >= r.low - 1e-9 && v <= r.high + 1e-9;

/** The kinds of past proposal a cross-check counts, by the noun the sentence names them with. */
export type CrossCheckNoun = "email campaigns" | "ad changes";

/** The catalogue's code for each noun: a lookup on a code constant, never a reading of the words. */
const NOUN_KIND: Record<CrossCheckNoun, "email" | "ads"> = {
  "email campaigns": "email",
  "ad changes": "ads",
};

/** Pure: the cross-check sentence from what was compared, in `w`'s words (English by default). */
export function crossCheckLine(
  args: {
    noun: CrossCheckNoun;
    /** Past proposals of the kind that carried a simulated range. */
    simulated: number;
    /** Of those, measured since. */
    checked: number;
    inside: number;
    /** Verdict counts of the kind from the readback, for the sentence's tail. */
    verdicts?: { helped: number; did_nothing: number; backfired: number } | null;
  },
  w: SimText = englishSimText(),
): CrossCheck {
  const t = section(w, "cross");
  const L = w.locale;
  const kind = NOUN_KIND[args.noun];
  const tail =
    args.verdicts && args.verdicts.helped + args.verdicts.did_nothing + args.verdicts.backfired > 0
      ? t("readback", {
          helped: int(args.verdicts.helped, L),
          nothing: int(args.verdicts.did_nothing, L),
          backfired: int(args.verdicts.backfired, L),
        })
      : null;
  const withTail = (line: string) => (tail ? `${line} ${tail}` : line);
  if (args.simulated === 0) {
    return { line: withTail(t("none", { kind })), checked: 0, inside: 0 };
  }
  if (args.checked === 0) {
    return {
      line: withTail(
        t("notReadBack", { kind, count: args.simulated, simulated: int(args.simulated, L) }),
      ),
      checked: 0,
      inside: 0,
    };
  }
  return {
    line: withTail(
      args.checked === 1
        ? t("lastOne", { kind, landed: args.inside === 1 ? "inside" : "outside" })
        : t("lastMany", {
            kind,
            checked: int(args.checked, L),
            count: args.inside,
            inside: int(args.inside, L),
          }),
    ),
    checked: args.checked,
    inside: args.inside,
  };
}

function emailCrossCheck(past: PastWithVerdict[], w: SimText): CrossCheck {
  const verdicts = { helped: 0, did_nothing: 0, backfired: 0 };
  for (const p of past) if (p.verdict in verdicts) verdicts[p.verdict as keyof typeof verdicts]++;
  const withSim = past.filter((p) => simulationOf(p.row)?.key_rate?.name === "bought_again_rate");
  const recent = withSim.slice(0, SIM.cross_check_last);
  const measured = recent.filter((p) => p.campaign.measured >= SIM.email_min_measured);
  const hits = measured.filter((p) =>
    inside(p.campaign.returned / p.campaign.measured, simulationOf(p.row)!.key_rate!.range),
  ).length;
  return crossCheckLine(
    {
      noun: "email campaigns",
      simulated: recent.length,
      checked: measured.length,
      inside: hits,
      verdicts,
    },
    w,
  );
}

async function adsCrossCheck(
  profileId: string,
  accountId: string,
  now: Date,
  w: SimText,
): Promise<CrossCheck> {
  const rows = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        eq(proposals.module, "ads"),
        eq(proposals.status, "executed"),
      ),
    )
    .orderBy(desc(proposals.created_at));
  const verdicts = { helped: 0, did_nothing: 0, backfired: 0 };
  let simulated = 0;
  let checked = 0;
  let hits = 0;
  for (const row of rows) {
    const detail = (row.action as { detail?: { campaign_ref?: unknown; campaign_name?: unknown } })
      .detail;
    const ref = typeof detail?.campaign_ref === "string" ? detail.campaign_ref : null;
    const day = await executedOn(row);
    if (!ref || !day) continue;
    const outcome = await campaignOutcome({
      accountId,
      campaignRef: ref,
      campaignName: typeof detail?.campaign_name === "string" ? detail.campaign_name : ref,
      changedOn: day,
      now,
    });
    if (outcome.verdict in verdicts) verdicts[outcome.verdict as keyof typeof verdicts]++;
    const sim = simulationOf(row);
    if (sim?.key_rate?.name !== "roas" || simulated >= SIM.cross_check_last) continue;
    // A pause stops the spend, so there is no return after it to compare.
    if ((sim.option as { change?: string }).change === "pause") continue;
    simulated++;
    const roas = outcome.after?.roas ?? null;
    if (outcome.verdict === "too_early" || outcome.verdict === "unmeasured" || roas === null)
      continue;
    checked++;
    if (inside(roas, sim.key_rate.range)) hits++;
  }
  return crossCheckLine({ noun: "ad changes", simulated, checked, inside: hits, verdicts }, w);
}

async function contentCrossCheck(profileId: string, w: SimText): Promise<CrossCheck> {
  const rows = await db
    .select({ scenario: proposals.scenario })
    .from(proposals)
    .where(and(eq(proposals.profile_id, profileId), eq(proposals.module, "content")));
  const simulated = rows.filter(
    (r) => (r.scenario as { simulation?: unknown } | null)?.simulation !== undefined,
  ).length;
  const t = section(w, "cross");
  return {
    line: simulated === 0 ? t("contentNone") : t("contentNotAdded"),
    checked: 0,
    inside: 0,
  };
}
