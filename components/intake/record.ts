// The intake's wording — pure, so it is testable without a DOM.
//
// Everything here re-words what the server already decided: area status
// comes from lib/intake/areas.ts, facts and their sources from the
// record (lib/intake/record-view.ts), the basis class from
// components/report/basis.ts. Money and figures print through
// components/sheet/num.ts. Nothing here reads a question's content to
// decide anything (rule 4).
//
// L-2: every word comes from the "intake" catalogue (messages/*.json)
// through a translator, English by default (./words EN_TR), and every
// figure through the locale's own formatting.

import type {
  AreaBar,
  IntakeArea,
  IntakeQuestion,
  IntakeRecord,
  RecordFact,
} from "@/lib/intake/types";
import { toDecimalString } from "@/lib/core/money";
import { basisOf, gapWord } from "../report/basis";
import { keyWords } from "../report/figures";
import { moneyText, num } from "../sheet/num";
import type { AppLocale } from "@/lib/i18n/locales";
import { dayMonthYear } from "@/lib/i18n/format";
import type { Tr } from "./words";
import { EN_TR } from "./words";

/* ── areas ── */

/** Owner-facing names for the fourteen profile sections — the one map. */
export const AREA_NAME: Readonly<Record<string, string>> = {
  identity: "Business basics",
  presence: "Premises & website",
  offers: "What you sell",
  revenue: "Sales & revenue",
  costs: "Running costs",
  customers: "Customers",
  channels: "Sales channels",
  marketing: "Marketing",
  operations: "Operations & delivery",
  tooling: "Tools & software",
  legal: "Legal & tax",
  competitors: "Competitors",
  goals: "Your targets",
  assets: "Files & documents",
};

export const areaName = (section: string, tr: Tr = EN_TR): string =>
  AREA_NAME[section] !== undefined ? tr(`area.${section}`) : section.replace(/_/g, " ");

export interface AreaWord {
  word: string;
  /** Tint for the word; the word carries the meaning. "live" is cobalt: the area being asked. */
  tone: "ok" | "drift" | "live" | null;
}

/** "01": a tile's channel number, from its 0-based place in the row. */
export const channelNo = (index: number): string => String(index + 1);

/** Bars that hold a response — the owner's, a measurement, a derivation, an explicit unknown. */
const RESPONDED_BARS = new Set<AreaBar>(["owner", "measured", "derived", "unknown"]);

/** True when the area has responses and every one of them was read from a connection. */
export function measuredOnly(area: Pick<IntakeArea, "bars">): boolean {
  const responded = area.bars.filter((b) => RESPONDED_BARS.has(b));
  return responded.length > 0 && responded.every((b) => b === "measured");
}

/**
 * The tile's mono status word, re-worded from what the server computed.
 * The area being asked is MEASURING; a blocked area names the channel it
 * needs; a finished area is DONE; an unfinished one whose every response
 * came from a connection is READ ONLY.
 */
export function areaStatusWord(
  area: IntakeArea,
  opts: { active?: boolean; channelOf?: (section: string) => string | null; tr?: Tr } = {},
): AreaWord {
  const tr = opts.tr ?? EN_TR;
  if (opts.active) return { word: tr("status.measuring"), tone: "live" };
  switch (area.status) {
    case "completed":
      return { word: tr("status.done"), tone: "ok" };
    case "blocked": {
      const ch = area.needs ? (opts.channelOf?.(area.needs) ?? null) : null;
      if (ch) return { word: tr("status.needsChannel", { channel: ch }), tone: "drift" };
      return {
        word: area.needs
          ? tr("status.needsArea", { area: areaName(area.needs, tr) })
          : tr("status.notOpen"),
        tone: "drift",
      };
    }
    case "not_started":
      return { word: tr("status.notStarted"), tone: null };
    case "in_progress":
      return measuredOnly(area)
        ? { word: tr("status.readOnly"), tone: null }
        : { word: tr("status.inProgress"), tone: null };
  }
}

/**
 * Columns for the channel bank: one row for up to ten areas, past that
 * two balanced rows — so a tile never gets too narrow for its name.
 */
export const tileColumns = (n: number): number => (n <= 10 ? Math.max(1, n) : Math.ceil(n / 2));

/** Whole percent of the area's applicable questions holding a response (an unknown counts). */
export function areaPercent(area: Pick<IntakeArea, "answered" | "open" | "skipped">): number {
  const total = area.answered + area.open + area.skipped;
  return total === 0 ? 0 : Math.round((area.answered / total) * 100);
}

/** Questions still to ask in an area: its open ones (the current one among them) and its skips. */
export const leftInArea = (area: Pick<IntakeArea, "open" | "skipped">): number =>
  area.open + area.skipped;

/**
 * Seconds one question takes, on average, for the "about M min" line. A
 * planning constant, not a measurement — which is why the screen says
 * "about".
 */
export const SECONDS_PER_QUESTION = 45;

/** Whole minutes for n questions left, rounded up; at least 1 while any are left. */
export const minutesFor = (n: number): number =>
  n <= 0 ? 0 : Math.max(1, Math.ceil((n * SECONDS_PER_QUESTION) / 60));

/**
 * The legend's connector name: the providers measurements came from, most
 * facts first — one or two named, more counted. "a connection" when the
 * record holds no measurement.
 */
export function connectorLegend(sources: IntakeRecord["sources"], tr: Tr = EN_TR): string {
  const names: string[] = [];
  for (const s of sources) {
    if (s.kind !== "connector") continue;
    const name = s.provider ?? tr("provenance.aConnection");
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return tr("provenance.aConnection");
  if (names.length <= 2) return names.join(" & ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

/** A tile can be chosen when its area has something to ask: open questions, or skips. */
export const areaAskable = (area: IntakeArea): boolean => area.open > 0 || area.skipped > 0;

/**
 * The folded bank's one line: the channel being asked (null when none
 * is), and how many areas are done out of all of them.
 */
export function bankSummary(
  areas: readonly IntakeArea[],
  active: string | null,
  tr: Tr = EN_TR,
): { current: { ch: string; name: string; pct: number } | null; done: number; total: number } {
  const i = active ? areas.findIndex((a) => a.section === active) : -1;
  const at = areas[i];
  return {
    current: at ? { ch: channelNo(i), name: areaName(at.section, tr), pct: areaPercent(at) } : null,
    done: areas.filter((a) => a.status === "completed").length,
    total: areas.length,
  };
}

/* ── facts ── */

const isMoney = (v: unknown): v is { amount_minor: number; currency: string } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { amount_minor?: unknown }).amount_minor === "number" &&
  typeof (v as { currency?: unknown }).currency === "string";

const cap = (s: string): string => (s === "" ? s : s.charAt(0).toUpperCase() + s.slice(1));

/**
 * "Monthly revenue", "Mug · price", and for an unnamed entity "Channels · platform".
 * In another language the server names the fact from the bank's overlay
 * (lib/bank/fact-words, RecordFact.label); English keeps the key's words.
 */
export function factLabel(fact: RecordFact): string {
  if (fact.label) return fact.label;
  if (fact.entity) return `${fact.entity} · ${keyWords(fact.field, false)}`;
  const isEntityFact = fact.field !== fact.key;
  const short = keyWords(fact.key, !isEntityFact);
  // A lone word ("type", "status") says nothing without its section.
  return cap(/^\w+$/.test(short) ? keyWords(fact.key, false) : short);
}

/** Longest value text the record column prints before it truncates. */
export const VALUE_MAX = 44;

/**
 * The value cell. Money prints through moneyText, numbers through num;
 * a gap prints what it is (rule 5); anything else is the fact sheet's
 * own text. A structured value with no plain reading says so instead of
 * dumping JSON.
 */
export function factValue(
  fact: RecordFact,
  tr: Tr = EN_TR,
  locale: AppLocale = "en",
): { text: string; full: string; figure: boolean } {
  if (fact.status === "unknown") {
    const w = tr("fact.notKnown");
    return { text: w, full: w, figure: false };
  }
  if (fact.status === "skipped") {
    const w = tr("fact.skipped");
    return { text: w, full: w, figure: false };
  }
  const v = fact.value;
  if (isMoney(v)) {
    const t = moneyText(v.amount_minor, v.currency, locale);
    return { text: t, full: t, figure: true };
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const decimals = Number.isInteger(v) ? 0 : Math.min(2, String(v).split(".")[1]?.length ?? 0);
    const t = num(v, decimals, locale);
    return { text: t, full: t, figure: true };
  }
  if (typeof v === "boolean") {
    const w = tr(v ? "fact.yes" : "fact.no");
    return { text: w, full: w, figure: false };
  }
  // An entity list's marker reads as a count ("3 on file"), in the person's words.
  const ids =
    typeof v === "object" && v !== null ? (v as { entity_ids?: unknown }).entity_ids : null;
  if (Array.isArray(ids)) {
    const w = tr("fact.entityCount", { count: ids.length });
    return { text: w, full: w, figure: false };
  }
  // A date in the person's own writing ("1 Mar 2019").
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const w = dayMonthYear(v, locale);
    return { text: w, full: w, figure: true };
  }
  // A code's option label, from the bank's overlay (RecordFact.value_words).
  const raw = fact.value_words ?? fact.text ?? "";
  const full = /^[[{]/.test(raw) ? tr("fact.onFile") : raw;
  const text = full.length > VALUE_MAX ? `${full.slice(0, VALUE_MAX - 1).trimEnd()}…` : full;
  return { text, full, figure: false };
}

/** Where a fact came from, in the owner's words. */
export function sourceWord(
  fact: Pick<RecordFact, "source_kind" | "provider">,
  tr: Tr = EN_TR,
): string {
  switch (fact.source_kind) {
    case "connector":
      return fact.provider ?? tr("source.connected");
    case "owner_input":
    case "conversation":
      return tr("source.you");
    case "inferred":
      return tr("source.workedOut");
    case "web_research":
      return tr("source.pages");
    case "document":
      return tr("source.document");
    case "system_default":
      return tr("source.default");
    default:
      return fact.source_kind.replace(/_/g, " ");
  }
}

/** Gap statuses the catalogue words; anything else prints as gapWord does. */
const GAP_KEYS = new Set(["unknown", "skipped", "unasked", "not_applicable"]);

/** The basis column: a named class from what produced the fact, or what the gap is. */
export function basisWord(fact: RecordFact, tr: Tr = EN_TR): string {
  const basis = basisOf(fact);
  if (basis) return tr(`basis.${basis}`);
  return GAP_KEYS.has(fact.status) ? tr(`basis.${fact.status}`) : gapWord(fact.status);
}

/**
 * The provenance lines under the count: "31 read from Shopify · 16 from
 * you", then the gaps on record, each kind named apart (rule 5).
 */
export function provenanceLines(record: IntakeRecord, tr: Tr = EN_TR): string[] {
  // Merged by message and its words, so two sources that read alike count once.
  const merged = new Map<string, { key: string; values: Record<string, string>; n: number }>();
  for (const s of record.sources) {
    let key: string;
    let values: Record<string, string> = {};
    switch (s.kind) {
      case "connector":
        key = "provenance.readFrom";
        values = { provider: s.provider ?? tr("provenance.aConnectedAccount") };
        break;
      case "owner_input":
      case "conversation":
        key = "provenance.fromYou";
        break;
      case "inferred":
        key = "provenance.workedOut";
        break;
      case "web_research":
        key = "provenance.readPages";
        break;
      case "document":
        key = "provenance.documents";
        break;
      case "system_default":
        key = "provenance.defaults";
        break;
      default:
        key = "provenance.other";
        values = { kind: s.kind.replace(/_/g, " ") };
    }
    const id = `${key}\u0000${JSON.stringify(values)}`;
    const at = merged.get(id);
    if (at) at.n += s.count;
    else merged.set(id, { key, values, n: s.count });
  }
  const lines: string[] = [];
  const first = [...merged.values()].map((m) => tr(m.key, { ...m.values, count: m.n })).join(" · ");
  if (first) lines.push(first);
  const gaps: string[] = [];
  if (record.not_known > 0) gaps.push(tr("provenance.notKnown", { count: record.not_known }));
  if (record.skipped > 0) gaps.push(tr("provenance.skipped", { count: record.skipped }));
  if (gaps.length > 0) lines.push(gaps.join(" · "));
  return lines;
}

/** "1 fact on file" / "47 facts on file". */
export const factCountText = (n: number, tr: Tr = EN_TR): string =>
  tr("provenance.factsOnFile", { count: n });

/** A measurement already on record, as the inset's sentence. */
export function alreadyReadText(
  fact: RecordFact,
  tr: Tr = EN_TR,
  locale: AppLocale = "en",
): { label: string; value: string } {
  return { label: factLabel(fact), value: factValue(fact, tr, locale).text };
}

/* ── money input ── */

/** The currency's mark and which side it sits, read from moneyText: "€" before, "HUF" after. */
export function currencyMark(
  currency: string,
  locale: AppLocale = "en",
): { mark: string; before: boolean } {
  const sample = moneyText(0, currency, locale);
  const mark = sample.replace(/[\d.,\s\u00a0\u202f−-]/g, "");
  return { mark, before: !/^\d/.test(sample) };
}

/* ── keys ── */

/**
 * Number keys 1–9 pick a row, but never while the owner is typing: the
 * digit belongs to the field then. Pure over the event target's shape.
 */
export function numberKeyIndex(
  key: string,
  target: { tagName?: string; isContentEditable?: boolean } | null,
  modifiers: { ctrl: boolean; meta: boolean; alt: boolean },
): number | null {
  if (modifiers.ctrl || modifiers.meta || modifiers.alt) return null;
  if (!/^[1-9]$/.test(key)) return null;
  const tag = (target?.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
    return null;
  }
  return Number(key) - 1;
}

/* ── going back ── */

/** Source kinds that mean the owner gave the fact — the only ones going back can reopen. */
const OWNER_SOURCES = new Set(["owner_input", "conversation"]);

/**
 * The question "← Q …" returns to: the newest answer (or explicit unknown)
 * the owner gave through a question other than the current one. Going
 * back runs through the reopen path, which needs a response to reopen —
 * so a skip, a measurement or a derivation is never offered. Null when
 * there is none.
 */
export function previousQuestion(
  facts: readonly RecordFact[],
  currentId: string | null,
): string | null {
  const hit = facts.find(
    (f) =>
      f.question_id !== null &&
      f.question_id !== currentId &&
      (f.status === "answered" || f.status === "unknown") &&
      OWNER_SOURCES.has(f.source_kind),
  );
  return hit?.question_id ?? null;
}

/* ── the tape ── */

/**
 * A recorded_at as Postgres prints it ("2026-10-17 21:00:49.983+00") or
 * as ISO, to a Date. Null when unreadable.
 */
export function parseRecordedAt(raw: string): Date | null {
  let t = raw.trim().replace(" ", "T");
  if (/[+-]\d{2}$/.test(t)) t = `${t}:00`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14:01" for a fact recorded today (the browser's clock), "16 Oct" for an earlier day. */
export function tapeStamp(raw: string, now: Date, locale: AppLocale = "en"): string {
  const d = parseRecordedAt(raw);
  if (!d) return "";
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (locale !== "en") {
    // The locale's own short day-and-month ("16. Okt.", "10月16日"), on the browser's clock.
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(d);
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ""}`;
}

export interface TapeEntry {
  id: string;
  stamp: string;
  label: string;
  value: string;
  source: string;
}

/** The tape: the listed facts, newest first, as "HH:MM label = value · source". */
export function tapeEntries(
  facts: readonly RecordFact[],
  now: Date,
  tr: Tr = EN_TR,
  locale: AppLocale = "en",
): TapeEntry[] {
  return facts.map((f) => ({
    id: `${f.key}@${f.recorded_at}`,
    stamp: tapeStamp(f.recorded_at, now, locale),
    label: factLabel(f),
    value: factValue(f, tr, locale).text,
    source: sourceWord(f, tr),
  }));
}

/* ── report readiness ── */

/** How many of `cells` squares a 0..1 readiness fills: proportional, rounded, clamped. */
export function readinessCells(fraction: number, cells = 25): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(cells, Math.max(0, Math.round(fraction * cells)));
}

/* ── the dial ── */

/**
 * A point on a semicircle dial for a 0–100 value: 0 at the left end, 100
 * at the right, over the top. Values off the scale pin to its ends.
 */
export function dialPoint(
  pct: number,
  cx: number,
  cy: number,
  r: number,
): { x: number; y: number } {
  const p = Math.min(100, Math.max(0, Number.isFinite(pct) ? pct : 0));
  const angle = Math.PI * (1 - p / 100);
  return { x: cx + r * Math.cos(angle), y: cy - r * Math.sin(angle) };
}

/* ── the money ruler ── */

/** Nice steps for the ruler's labelled ticks, within one power of ten. */
const NICE_STEPS = [1, 2, 2.5, 3, 5];

export interface RulerScale {
  max: number;
  step: number;
  /** The six labelled ticks, 0 … max, in major units. */
  labels: number[];
  /** The reference's place along the axis, 0..1. */
  at: number;
}

/**
 * A ruler axis around a reference (major units): five nice steps from
 * zero, wide enough that the reference sits at most 5/8 of the way along.
 * Null for a non-positive or unreadable reference.
 */
export function rulerScale(reference: number): RulerScale | null {
  if (!Number.isFinite(reference) || reference <= 0) return null;
  const raw = (reference * 1.6) / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = (NICE_STEPS.find((n) => n * pow >= raw - 1e-9) ?? 10) * pow;
  const max = step * 5;
  return {
    max,
    step,
    labels: [0, 1, 2, 3, 4, 5].map((i) => Math.round(i * step * 1e6) / 1e6),
    at: reference / max,
  };
}

/** The measured reference for a money question: its already-read value, when that is money. */
export function moneyReference(
  question: Pick<IntakeQuestion, "already_read">,
  locale: AppLocale = "en",
): { major: number; currency: string; text: string } | null {
  const v = question.already_read?.value;
  if (!isMoney(v)) return null;
  return {
    // The ruler's scale, read from the exact decimal string — never a divided float.
    major: Number(toDecimalString(v)),
    currency: v.currency,
    text: moneyText(v.amount_minor, v.currency, locale),
  };
}

/* ── option tiles ── */

/** Columns for n option tiles: one row up to four, then rows of three or four. */
export function optionColumns(n: number): number {
  if (n <= 4) return Math.max(1, n);
  if (n % 4 === 0 || n > 9) return 4;
  return 3;
}
