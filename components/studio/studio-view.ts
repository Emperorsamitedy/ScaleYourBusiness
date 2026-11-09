// The creative studio's words, pure — counted from what the API returned,
// never invented. Tested in studio-view.test.ts.
//
// L-3c (TASKS-LANGUAGES.md): the words are the "studio" catalogue through
// an optional translator, English by default from messages/en.json, so
// English says exactly what it always said; dates and counts in the
// reader's locale. An ad's page name, hook and offer are content, shown
// as they are.

import { dayMonth } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type { NicheView } from "../../lib/research/niche";
import { num } from "../sheet/num";

const EN = (): Tr => englishTr("studio");

export type StudioNiche = Pick<NicheView, "set_up" | "blocked" | "last_read" | "groups">;

/**
 * The screen's one display line: its main fact, from real data.
 * `businessWord` is English's noun ("salon"); another language says "your business".
 */
export function studioHeadline(
  niche: StudioNiche,
  briefs: number,
  businessWord: string,
  tr: Tr = EN(),
  locale: AppLocale = "en",
): string {
  const top = niche.groups[0];
  if (!top || !niche.last_read) {
    if (!niche.set_up) return tr("headline.notSetUp");
    if (niche.blocked) return tr("headline.blocked");
  }
  if (!niche.last_read || !top) {
    if (briefs > 0) return tr("headline.briefsNotRead", { count: briefs });
    return locale === "en"
      ? tr("headline.notRead", { noun: businessWord })
      : tr("headline.notReadBusiness");
  }
  return tr("headline.longest", {
    page: top.page_name,
    format: top.format === "video" ? "video" : "ad",
    days: top.running_days,
  });
}

/** "142 days · LIVE" / "8 days · STOPPED". `word` is the state; its words are `running.live`/`running.stopped`. */
export function runningWords(
  g: { running_days: number; active: boolean },
  tr: Tr = EN(),
): {
  days: string;
  word: "LIVE" | "STOPPED";
} {
  return {
    days: tr("running.days", { count: g.running_days }),
    word: g.active ? "LIVE" : "STOPPED",
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "26 Oct", in UTC so server and browser agree. */
export function dayText(iso: string, locale: AppLocale = "en"): string {
  const d = new Date(iso);
  if (locale !== "en") return dayMonth(d.toISOString().slice(0, 10), locale);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "26 Oct, 14:05 UTC" — when a fresh read becomes allowed. */
export function timeText(iso: string, locale: AppLocale = "en"): string {
  const d = new Date(iso);
  if (locale !== "en") {
    return new Intl.DateTimeFormat(intlTag(locale), {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    }).format(d);
  }
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dayText(iso)}, ${hh}:${mm} UTC`;
}

/** A country code as the reader says it: English keeps the code ("IE"), as it always has. */
export function countryText(code: string, locale: AppLocale = "en"): string {
  if (locale === "en") return code;
  try {
    return new Intl.DisplayNames([intlTag(locale)], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A count in the reader's figures (the studio's allowance and request counts). */
export function countText(n: number, locale: AppLocale = "en"): string {
  return locale === "en" ? String(n) : num(n, 0, locale);
}

/** Terms as the owner types them: comma-separated, trimmed, at most two. */
export function parseTerms(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 2);
}

/** What a citation's kind is called on screen (English; the catalogue's `source.<kind>`). */
export const SOURCE_WORD: Readonly<Record<string, string>> = {
  fact: "YOUR FACT",
  finding: "DIAGNOSIS",
  voice: "YOUR WORDS",
  post: "YOUR POST",
  competitor: "COMPETITOR",
  ad: "NICHE AD",
};

/** A citation's kind in the reader's language; an unknown kind shows as its code. */
export function sourceWord(kind: string, tr: Tr = EN()): string {
  return kind in SOURCE_WORD ? tr(`source.${kind}`) : kind;
}

/** What an ad's format is called on screen (English; the catalogue's `format.<code>`). */
export const FORMAT_WORD: Readonly<Record<string, string>> = {
  video: "VIDEO",
  image: "IMAGE",
  multi: "CARDS / VERSIONS",
};

/** An ad's format in the reader's language; an unknown format shows as its code. */
export function formatWord(format: string, tr: Tr = EN()): string {
  return format in FORMAT_WORD ? tr(`format.${format}`) : format;
}

/** The outcome of a research click, in a sentence. `why` is the server's own words. */
export function researchNotice(
  r: { status: string; why: string | null; fresh: boolean },
  tr: Tr = EN(),
): string {
  if (r.status === "read") {
    return r.fresh ? tr("notice.readNow") : tr("notice.stillFresh");
  }
  return r.why ?? tr("error.generic");
}

/* ── P6-03: AI video, three candidates per brief ── */

/** What the studio is told about AI video's setup (lib/content/generation GenerationSetupView). */
export interface StudioVideoSetup {
  available: boolean;
  reason: string | null;
  state: "ready" | "off" | "needs_key" | "unavailable";
}

/**
 * The line that says why AI video can't run here, or null when it can. A
 * missing key names exactly what the owner must set; another reason is the
 * server's own sentence.
 */
export function videoSetupLine(setup: StudioVideoSetup, tr: Tr = EN()): string | null {
  if (setup.available) return null;
  if (setup.state === "needs_key") return tr("video.noKey");
  if (setup.state === "off") return tr("video.off");
  return tr("video.unavailable", { reason: setup.reason ?? tr("error.generic") });
}

/** The candidate states the screen has words for (the catalogue's `video.state.<code>`). */
export const CANDIDATE_STATES = ["generating", "ready", "failed", "chosen", "not_chosen"] as const;

/** A candidate's state in the reader's language; an unknown state shows as its code. */
export function candidateStateWord(status: string, tr: Tr = EN()): string {
  return (CANDIDATE_STATES as readonly string[]).includes(status)
    ? tr(`video.state.${status}`)
    : status;
}

/** Pure: may this candidate be picked? Only a ready one with its file, while its set has no pick. */
export function canPick(
  set: { chosen_id: string | null },
  candidate: { status: string; url: string | null },
): boolean {
  return set.chosen_id === null && candidate.status === "ready" && candidate.url !== null;
}

/**
 * P6-03 (the owner's decision of 2026-11-09): a set is submitted and
 * collected in the background. While one is being made the studio asks
 * the server to collect every `every_ms`, at most `max_polls` times (an
 * hour), then says it is still being made and stops asking.
 */
export const VIDEO_POLL = { every_ms: 15_000, max_polls: 240 } as const;

/** Pure: is any set still being made? */
export function anyMaking(sets: readonly { status: string }[]): boolean {
  return sets.some((s) => s.status === "generating");
}

/** Pure: a set's progress — how many of its candidates have arrived. */
export function setProgress(set: { ready: number; candidates: readonly unknown[] }): {
  ready: number;
  total: number;
} {
  return { ready: set.ready, total: set.candidates.length };
}

/** Pure: the rows that belong to one brief, in the order the server sent them. */
export function forBrief<T extends { brief_id: string | null }>(
  rows: readonly T[],
  briefId: string,
): T[] {
  return rows.filter((r) => r.brief_id === briefId);
}
