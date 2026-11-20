// Connections — the words the patch panel prints, pure so they are tested
// (the owner's Connections design, 2026-10-17). Every line is read off the
// API: what a source gives is the scope registry's own "why" (SCOPE_GUIDE),
// trimmed to its subject; the headline counts connections that are actually
// reading, and it says so the moment anything can write (P3-20h).
//
// L-3d: the headline's words are the "connections" catalogue and the
// last-read time is the reader's writing; English, the default, is what
// these always printed.

import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";

export interface GuideLine {
  why: string;
}

/** "Your orders, which is where…" → "your orders"; joined for the row. */
export function gives(guide: readonly GuideLine[]): string {
  const parts: string[] = [];
  for (const g of guide) {
    const head = (g.why.split(/[,.]/)[0] ?? "").trim();
    if (head === "") continue;
    const word = parts.length === 0 ? head : head.charAt(0).toLowerCase() + head.slice(1);
    if (!parts.some((p) => p.toLowerCase() === word.toLowerCase())) parts.push(word);
  }
  return parts.join(", ");
}

export interface CountedConnection {
  status: "connected" | "paused" | "failed" | "disconnected";
}

export interface WriteConnection extends CountedConnection {
  label: string;
  provider?: string;
}

/**
 * I-45a: write consents SYB holds only to READ — Google's one Business
 * Profile scope can write, but the provider has no operations. Said as what
 * it is, never as "can write — only what you approve", which promises writes.
 */
export const READ_ONLY_WRITE_CONSENTS: readonly string[] = ["google_business_reviews"];

/** Sentences side by side: a space, except in Chinese. */
export function joinSentences(parts: readonly string[], locale: AppLocale = "en"): string {
  return parts.filter((p) => p !== "").join(locale === "zh-Hans" ? "" : " ");
}

/** A label list: "A and B" in English, as the screen always said; the language's own list elsewhere. */
export function labelList(labels: readonly string[], locale: AppLocale = "en"): string {
  if (locale === "en") return labels.join(" and ");
  return new Intl.ListFormat(intlTag(locale), { type: "conjunction" }).format(labels);
}

/** The screen's one line: what reads, and whether anything can write. */
export function headline(
  reads: readonly CountedConnection[],
  /** null when the write side couldn't be read — then the line doesn't guess. */
  writes: readonly WriteConnection[] | null,
  tr: Tr = englishTr("connections"),
  locale: AppLocale = "en",
): string {
  const reading = reads.filter((c) => c.status === "connected").length;
  const stalled = reads.filter((c) => c.status === "failed" || c.status === "paused").length;
  const readPart =
    reading > 0
      ? tr("headline.reading", { count: reading })
      : stalled > 0
        ? tr("headline.stalled")
        : tr("headline.none");
  // Any write consent still on record counts, working or not: the token is held.
  if (writes === null) return joinSentences([readPart, tr("headline.writesUnknown")], locale);
  const held = writes.filter((c) => c.status !== "disconnected");
  const readOnly = held.filter((c) => READ_ONLY_WRITE_CONSENTS.includes(c.provider ?? ""));
  const writing = held.filter((c) => !READ_ONLY_WRITE_CONSENTS.includes(c.provider ?? ""));
  const names = (cs: readonly WriteConnection[]) =>
    labelList(
      cs.map((c) => c.label),
      locale,
    );
  const parts: string[] = [readPart];
  if (writing.length > 0) {
    parts.push(tr("headline.canWrite", { labels: names(writing) }));
  } else if (readOnly.length === 0) {
    parts.push(tr("headline.nothingWritten"));
  }
  if (readOnly.length > 0) {
    parts.push(tr("headline.readOnly", { labels: names(readOnly) }));
  }
  return joinSentences(parts, locale);
}

/** The screen's three parts (L6): what is read, the owner's own files, what may be changed. */
export type CnTab = "read" | "files" | "write";
export const CN_TABS: readonly CnTab[] = ["read", "files", "write"];

/** The keys a sign-in for a write permission comes back with (each section reads its own). */
const WRITE_RETURNS: readonly string[] = ["meta", "google", "gads", "tiktok", "tiktokads"];

/**
 * Pure: the part an address opens on, or null for the first. `?tab=` names
 * one; a sign-in that returns for a write permission opens that part, so its
 * result is in front of the person who just did it.
 */
export function tabFromSearch(search: string): CnTab | null {
  const q = new URLSearchParams(search);
  const asked = q.get("tab");
  if (asked === "read" || asked === "files" || asked === "write") return asked;
  return WRITE_RETURNS.some((k) => q.has(k)) ? "write" : null;
}

/** Pure: how many sources are being read, and how many permissions to change are held. */
export function tabCounts(
  reads: readonly CountedConnection[],
  writes: readonly WriteConnection[] | null,
): { read: number; write: number } {
  return {
    read: reads.filter((c) => c.status === "connected").length,
    // The headline's own rule: a permission held only to read is not one to change.
    write: (writes ?? []).filter(
      (c) => c.status !== "disconnected" && !READ_ONLY_WRITE_CONSENTS.includes(c.provider ?? ""),
    ).length,
  };
}

/** Postgres prints "2026-10-17 15:20:35.26+00"; make it ISO before parsing. */
export function parseTs(s: string): number {
  const iso = s
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d\d)$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.parse(s) : ms;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14:00" today, "9 Oct" before, "-" never — in the reader's writing outside English. */
export function lastRead(iso: string | null, now: number, locale: AppLocale = "en"): string {
  if (iso === null) return "-";
  const ms = parseTs(iso);
  if (Number.isNaN(ms)) return "-";
  const d = new Date(ms);
  const today = new Date(now).toDateString() === d.toDateString();
  if (locale !== "en") {
    return d.toLocaleString(
      intlTag(locale),
      today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" },
    );
  }
  if (today) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ""}`;
}
