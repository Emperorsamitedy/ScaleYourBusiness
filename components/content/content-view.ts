// Pure read-model for the content screen (the owner's instrument design,
// 2026-10-17): the per-channel strips, each row's state word, and the
// headline — all counted from the queue the API returns. No targets are
// invented: a strip's "planned" is what is actually in the queue for
// that channel, and "posted" is what actually published.
//
// L-3c (TASKS-LANGUAGES.md): the words are the "content" catalogue through
// an optional translator, English by default from messages/en.json, so
// English says exactly what it always said; figures in the reader's
// locale. A server sentence (last_error, a performance's arithmetic) and a
// draft's own words are passed through as they are.

import { format } from "../../lib/core/money";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import { num } from "../sheet/num";

const EN = (): Tr => englishTr("content");

export type ContentStatus =
  "drafted" | "queued" | "publishing" | "published" | "failed" | "withdrawn";

export interface QueueItem {
  id: string;
  kind: "post" | "email" | "shot_list" | "video";
  channel_label: string;
  scheduled_for: string | null;
  status: ContentStatus;
  publish_proposal_id: string | null;
  published_at: string | null;
  /** The owner's sentence: why it failed, why it's waiting, or that Meta didn't confirm it. */
  last_error?: string | null;
}

export interface ChannelStrip {
  channel: string;
  planned: number;
  posted: number;
  first: string | null;
  last: string | null;
  /** Unposted items dated before today. */
  overdue: number;
  /** The next unposted date, today or later. */
  next: string | null;
  state: "behind" | "on_pace" | "done";
}

const LIVE: ReadonlySet<ContentStatus> = new Set(["drafted", "queued", "publishing", "failed"]);

/** One strip per channel, in the order channels first appear in the queue. */
export function channelStrips(items: readonly QueueItem[], today: string): ChannelStrip[] {
  const by = new Map<string, QueueItem[]>();
  for (const item of items) {
    if (item.status === "withdrawn") continue;
    by.set(item.channel_label, [...(by.get(item.channel_label) ?? []), item]);
  }
  return [...by.entries()].map(([channel, list]) => {
    const dates = list.map((i) => i.scheduled_for).filter((d): d is string => d !== null);
    dates.sort();
    const unposted = list.filter((i) => LIVE.has(i.status));
    const overdue = unposted.filter((i) => i.scheduled_for !== null && i.scheduled_for < today);
    const upcoming = unposted
      .map((i) => i.scheduled_for)
      .filter((d): d is string => d !== null && d >= today)
      .sort();
    const posted = list.filter((i) => i.status === "published").length;
    return {
      channel,
      planned: list.length,
      posted,
      first: dates[0] ?? null,
      last: dates[dates.length - 1] ?? null,
      overdue: overdue.length,
      next: upcoming[0] ?? null,
      state: overdue.length > 0 ? "behind" : unposted.length === 0 ? "done" : "on_pace",
    };
  });
}

export type Tone = "live" | "ok" | "low" | "drift" | "alarm";

/** The state word a row wears, and the tone that tints it. */
export function stateWord(
  item: QueueItem,
  dayWord: (iso: string) => string,
  tr: Tr = EN(),
): {
  word: string;
  tone: Tone;
} {
  switch (item.status) {
    case "drafted":
      return item.publish_proposal_id !== null
        ? { word: tr("state.inQueue"), tone: "live" }
        : { word: tr("state.drafted"), tone: "low" };
    case "queued":
      return {
        word: item.scheduled_for
          ? tr("state.scheduledOn", { day: dayWord(item.scheduled_for) })
          : tr("state.scheduled"),
        tone: "ok",
      };
    case "publishing":
      // P3-21d: a run that lost Meta's answer leaves it here with a sentence — never re-sent.
      return item.last_error
        ? { word: tr("state.unconfirmed"), tone: "drift" }
        : { word: tr("state.publishing"), tone: "live" };
    case "published":
      return {
        word: item.published_at
          ? tr("state.postedOn", { day: dayWord(item.published_at.slice(0, 10)) })
          : tr("state.posted"),
        tone: "ok",
      };
    case "failed":
      return { word: tr("state.failed"), tone: "alarm" };
    case "withdrawn":
      return { word: tr("state.withdrawn"), tone: "low" };
  }
}

/**
 * The page's one sentence, from the queue as it stands. English spells a
 * small count as a word ("One needs your yes"); the catalogue's plurals
 * carry that, so each language words its own counts.
 */
export function contentHeadline(
  args: {
    items: readonly QueueItem[];
    producible: number;
    blocked: number;
    nextDate: string | null;
  },
  tr: Tr = EN(),
): string {
  const { items, producible, blocked, nextDate } = args;
  const drafts = items.filter((i) => i.status === "drafted");
  const inQueue = drafts.filter((i) => i.publish_proposal_id !== null).length;
  if (items.length === 0) {
    return producible > 0
      ? tr("headline.nothingReady", { count: producible })
      : tr("headline.nothing");
  }
  if (drafts.length === 0) {
    const scheduled = items.filter((i) => i.status === "queued").length;
    const posted = items.filter((i) => i.status === "published").length;
    return tr("headline.scheduledPosted", { scheduled, posted });
  }
  const first = tr("headline.drafts", { count: drafts.length });
  if (inQueue > 0) return tr("headline.needsYes", { first, count: inQueue });
  if (producible > 0) return tr("headline.moreToDraft", { first, count: producible });
  if (blocked >= drafts.length) return tr("headline.noneCanPost", { first });
  if (nextDate) return tr("headline.nextDue", { first, date: nextDate });
  return first;
}

const PLATFORM_WORD: Readonly<Record<string, string>> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
};

/** The platform's own name for a stored platform value ("instagram" → "Instagram"). */
export function platformWord(platform: string | null, tr: Tr = EN()): string {
  return platform ? (PLATFORM_WORD[platform] ?? platform) : tr("platform.unknown");
}

/**
 * P3-21e: the one line under an item that says where it stands on its way
 * out — published where, waiting why, or that publishing is switched off
 * (the Session D real-write gate). Null when the row's state word is enough.
 */
export function publishLine(
  item: QueueItem & { platform: string | null },
  realWrites: boolean,
  tr: Tr = EN(),
): string | null {
  const platform = platformWord(item.platform, tr);
  switch (item.status) {
    case "queued":
      if (item.last_error) return item.last_error;
      return realWrites ? tr("publish.approvedOn") : tr("publish.approvedOff");
    case "publishing":
      return item.last_error ?? tr("publish.goingOut", { platform });
    case "published":
      return tr("publish.live", { platform });
    case "withdrawn":
      return tr("publish.withdrawn", { platform });
    default:
      return null;
  }
}

/** A short, real handle for an item: the first four hex digits of its id. */
export function shortId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

/** P3-23b: what /content needs of a published item's measured outcome (lib/trust/post-readback). */
export interface PerformanceLike {
  verdict: "helped" | "did_nothing" | "backfired" | "too_early" | "unmeasured";
  audience_metric: "reach" | "views" | null;
  age_days: number | null;
  figures: { views: number | null; reach: number | null; interactions: number | null } | null;
  arithmetic: string;
}

const VERDICT_TONE: Readonly<Record<PerformanceLike["verdict"], Tone>> = {
  helped: "ok",
  did_nothing: "low",
  backfired: "alarm",
  too_early: "low",
  unmeasured: "low",
};

/** English groups with a space here ("1 240"); other languages group their own way. */
const grouped = (n: number, locale: AppLocale) =>
  locale === "en" ? n.toLocaleString("en-GB").replace(/,/g, " ") : num(n, 0, locale);

/**
 * P3-23b: the measured line under a published item — its own figures on
 * the day it is judged, the verdict word, and the arithmetic behind it.
 * Null when nothing has been measured yet (the verdict says why).
 */
export function performanceLine(
  p: PerformanceLike | undefined,
  tr: Tr = EN(),
  locale: AppLocale = "en",
): {
  figures: string | null;
  word: string;
  tone: Tone;
  arithmetic: string;
} | null {
  if (!p) return null;
  const f = p.figures;
  const parts: string[] = [];
  if (f) {
    if (f.reach !== null) parts.push(tr("perf.reach", { n: grouped(f.reach, locale) }));
    if (f.views !== null) parts.push(tr("perf.views", { n: grouped(f.views, locale) }));
    if (f.interactions !== null) {
      parts.push(tr("perf.interactions", { n: grouped(f.interactions, locale) }));
    }
  }
  const figures =
    parts.length > 0 && p.age_days !== null
      ? [tr("perf.day", { day: num(p.age_days, 0, locale) }), ...parts].join(" · ")
      : null;
  return {
    figures,
    word: tr(`verdict.${p.verdict}`),
    tone: VERDICT_TONE[p.verdict],
    arithmetic: p.arithmetic,
  };
}

/* ── P3-54: "Run this as an ad" ── */

/** What /content needs of an item's ad (lib/ads/adcreate, adItemStates). */
export interface AdStateLike {
  reason: string | null;
  proposal: { id: string; status: string } | null;
  build: { id: string; status: string; last_error: string | null } | null;
  go_live: { id: string; status: string } | null;
}

export interface AdLine {
  /** The state word, boxed, or null when the item has no ad yet. */
  word: string | null;
  tone: Tone;
  /** One sentence: where the ad stands, or what the button will do. */
  text: string;
  /** The one action offered: make the proposal, decide in the queue, or propose going live. */
  action: "run_ad" | "queue" | "go_live" | null;
}

const DECIDED_ELSEWHERE: ReadonlySet<string> = new Set([
  "rejected",
  "expired",
  "changes_requested",
]);

/**
 * P3-54, pure: the line under an item about its ad. Never offers to run an
 * item as an ad twice; never says "live" unless the go-live ran. Null when
 * the item can't be an ad and has no ad history.
 */
export function adLine(
  ad: AdStateLike | undefined,
  realWrites: boolean,
  tr: Tr = EN(),
): AdLine | null {
  if (!ad) return null;
  const { proposal, build, go_live } = ad;
  if (build) {
    if (build.status === "built") {
      if (go_live?.status === "executed") {
        return { word: tr("ad.word.live"), tone: "ok", text: tr("ad.text.live"), action: null };
      }
      if (go_live && (go_live.status === "pending" || go_live.status === "blocked")) {
        return {
          word: tr("ad.word.paused"),
          tone: "live",
          text:
            go_live.status === "blocked"
              ? tr("ad.text.pausedBlocked")
              : tr("ad.text.pausedPending"),
          action: go_live.status === "pending" ? "queue" : null,
        };
      }
      if (go_live?.status === "approved") {
        return {
          word: tr("ad.word.paused"),
          tone: "ok",
          text: realWrites ? tr("ad.text.goLiveApprovedOn") : tr("ad.text.goLiveApprovedOff"),
          action: null,
        };
      }
      return {
        word: tr("ad.word.paused"),
        tone: "low",
        text: tr("ad.text.paused"),
        action: "go_live",
      };
    }
    if (build.status === "building") {
      return {
        word: tr("ad.word.inProgress"),
        tone: "live",
        text: tr("ad.text.building"),
        action: null,
      };
    }
    return {
      word: build.status === "uncertain" ? tr("ad.word.unconfirmed") : tr("ad.word.failed"),
      tone: build.status === "uncertain" ? "drift" : "alarm",
      text: build.last_error ?? tr("ad.text.buildStopped"),
      action: null,
    };
  }
  if (proposal && !DECIDED_ELSEWHERE.has(proposal.status)) {
    if (proposal.status === "blocked") {
      return {
        word: tr("ad.word.heldBack"),
        tone: "low",
        text: tr("ad.text.heldBack"),
        action: null,
      };
    }
    if (proposal.status === "approved") {
      return {
        word: tr("ad.word.approved"),
        tone: "ok",
        text: realWrites ? tr("ad.text.approvedOn") : tr("ad.text.approvedOff"),
        action: null,
      };
    }
    return {
      word: tr("ad.word.proposed"),
      tone: "live",
      text: tr("ad.text.proposed"),
      action: "queue",
    };
  }
  if (ad.reason !== null) return null;
  return { word: null, tone: "low", text: tr("ad.text.offer"), action: "run_ad" };
}

/* ── P3-52/53: footage and the AI fallback ── */

export interface MoneyLike {
  amount_minor: number;
  currency: string;
}

/** "€0.04" from integer minor units — the money module's own formatting, never a float in transit. */
export function formatMinor(m: MoneyLike, locale: AppLocale = "en"): string {
  return format(m, locale === "en" ? "en" : intlTag(locale));
}

export interface MediaState {
  upload_mode: "blob" | "direct" | "off";
  limits: { clip_bytes: number; clips_per_item: number; on_screen: number; caption: number };
  footage: Record<
    string,
    {
      clips: { id: string; label: string; bytes: number | null; status: string }[];
      render: {
        id: string;
        status: "queued" | "rendering" | "rendered" | "failed";
        note: string | null;
        result_item_id: string | null;
        attempts: number;
      } | null;
    }
  >;
  generation: {
    /** P6-03: `candidates` > 1 means video is a set made from profile facts (no typed direction). */
    setup: { available: boolean; reason: string | null; candidates?: number };
    items: Record<
      string,
      {
        refusal: string | null;
        estimates: { image: MoneyLike | null; video: MoneyLike | null };
        latest: {
          status: string;
          media: string;
          cost: MoneyLike | null;
          error: string | null;
          result_item_id: string | null;
        } | null;
        approved_proposal_id: string | null;
        pending_proposal_id: string | null;
      }
    >;
  };
  /** Approved generated items whose footage arrived — they won't be published. */
  superseded: string[];
}

/**
 * What an item's media is, in the owner's words, from its provenance —
 * "your footage", "AI-generated image" — so a generated picture is never
 * shown as if it were filmed.
 */
export function mediaWord(provenance: unknown, tr: Tr = EN()): string {
  const origin = (provenance as { media?: { origin?: unknown } } | null)?.media?.origin;
  if (origin === "generated_image") return tr("origin.generatedImage");
  if (origin === "generated_video") return tr("origin.generatedVideo");
  return tr("origin.footage");
}
