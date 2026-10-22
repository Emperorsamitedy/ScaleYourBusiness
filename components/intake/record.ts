// The intake's wording — pure, so it is testable without a DOM.
//
// Everything here re-words what the server already decided: area status
// comes from lib/intake/areas.ts, facts and their sources from the
// record (lib/intake/record-view.ts), the basis class from
// components/report/basis.ts. Money and figures print through
// components/sheet/num.ts. Nothing here reads a question's content to
// decide anything (rule 4).

import type {
  AreaBar,
  IntakeArea,
  IntakeQuestion,
  IntakeRecord,
  RecordFact,
} from "@/lib/intake/types";
import { minorUnitExponent } from "@/lib/core/money";
import { basisOf, gapWord } from "../report/basis";
import { keyWords } from "../report/figures";
import { moneyText, num } from "../sheet/num";

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

export const areaName = (section: string): string =>
  AREA_NAME[section] ?? section.replace(/_/g, " ");

export interface AreaWord {
  word: string;
  /** Tint for the word; the word carries the meaning. "live" is cobalt: the area being asked. */
  tone: "ok" | "drift" | "live" | null;
}

/** "01": a tile's channel number, from its 0-based place in the row. */
export const channelNo = (index: number): string => String(index + 1).padStart(2, "0");

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
  opts: { active?: boolean; channelOf?: (section: string) => string | null } = {},
): AreaWord {
  if (opts.active) return { word: "Measuring", tone: "live" };
  switch (area.status) {
    case "completed":
      return { word: "Done", tone: "ok" };
    case "blocked": {
      const ch = area.needs ? (opts.channelOf?.(area.needs) ?? null) : null;
      if (ch) return { word: `Needs CH ${ch}`, tone: "drift" };
      return { word: area.needs ? `Needs ${areaName(area.needs)}` : "Not open yet", tone: "drift" };
    }
    case "not_started":
      return { word: "Not started", tone: null };
    case "in_progress":
      return measuredOnly(area)
        ? { word: "Read only", tone: null }
        : { word: "In progress", tone: null };
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
export function connectorLegend(sources: IntakeRecord["sources"]): string {
  const names: string[] = [];
  for (const s of sources) {
    if (s.kind !== "connector") continue;
    const name = s.provider ?? "a connection";
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return "a connection";
  if (names.length <= 2) return names.join(" & ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

/** A tile can be chosen when its area has something to ask: open questions, or skips. */
export const areaAskable = (area: IntakeArea): boolean => area.open > 0 || area.skipped > 0;

/* ── facts ── */

const isMoney = (v: unknown): v is { amount_minor: number; currency: string } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { amount_minor?: unknown }).amount_minor === "number" &&
  typeof (v as { currency?: unknown }).currency === "string";

const cap = (s: string): string => (s === "" ? s : s.charAt(0).toUpperCase() + s.slice(1));

/** "Monthly revenue", "Mug · price", and for an unnamed entity "Channels · platform". */
export function factLabel(fact: RecordFact): string {
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
export function factValue(fact: RecordFact): { text: string; full: string; figure: boolean } {
  if (fact.status === "unknown") return { text: "not known", full: "not known", figure: false };
  if (fact.status === "skipped") return { text: "skipped", full: "skipped", figure: false };
  const v = fact.value;
  if (isMoney(v)) {
    const t = moneyText(v.amount_minor, v.currency);
    return { text: t, full: t, figure: true };
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const decimals = Number.isInteger(v) ? 0 : Math.min(2, String(v).split(".")[1]?.length ?? 0);
    const t = num(v, decimals);
    return { text: t, full: t, figure: true };
  }
  if (typeof v === "boolean")
    return { text: v ? "yes" : "no", full: v ? "yes" : "no", figure: false };
  const raw = fact.text ?? "";
  const full = /^[[{]/.test(raw) ? "on file" : raw;
  const text = full.length > VALUE_MAX ? `${full.slice(0, VALUE_MAX - 1).trimEnd()}…` : full;
  return { text, full, figure: false };
}

/** Where a fact came from, in the owner's words. */
export function sourceWord(fact: Pick<RecordFact, "source_kind" | "provider">): string {
  switch (fact.source_kind) {
    case "connector":
      return fact.provider ?? "connected account";
    case "owner_input":
    case "conversation":
      return "you";
    case "inferred":
      return "worked out";
    case "web_research":
      return "your pages";
    case "document":
      return "a document";
    case "system_default":
      return "default";
    default:
      return fact.source_kind.replace(/_/g, " ");
  }
}

/** The basis column: a named class from what produced the fact, or what the gap is. */
export function basisWord(fact: RecordFact): string {
  return basisOf(fact) ?? gapWord(fact.status);
}

/**
 * The provenance lines under the count: "31 read from Shopify · 16 from
 * you", then the gaps on record, each kind named apart (rule 5).
 */
export function provenanceLines(record: IntakeRecord): string[] {
  const merged = new Map<string, number>();
  for (const s of record.sources) {
    let words: string;
    switch (s.kind) {
      case "connector":
        words = `read from ${s.provider ?? "a connected account"}`;
        break;
      case "owner_input":
      case "conversation":
        words = "from you";
        break;
      case "inferred":
        words = "worked out";
        break;
      case "web_research":
        words = "read from your pages";
        break;
      case "document":
        words = "from documents";
        break;
      case "system_default":
        words = "defaults";
        break;
      default:
        words = `from ${s.kind.replace(/_/g, " ")}`;
    }
    merged.set(words, (merged.get(words) ?? 0) + s.count);
  }
  const lines: string[] = [];
  const first = [...merged.entries()].map(([words, n]) => `${num(n)} ${words}`).join(" · ");
  if (first) lines.push(first);
  const gaps: string[] = [];
  if (record.not_known > 0) gaps.push(`${num(record.not_known)} not known yet`);
  if (record.skipped > 0) gaps.push(`${num(record.skipped)} skipped for now`);
  if (gaps.length > 0) lines.push(gaps.join(" · "));
  return lines;
}

/** "1 fact on file" / "47 facts on file". */
export const factCountText = (n: number): string =>
  `${num(n)} ${n === 1 ? "fact" : "facts"} on file`;

/** A measurement already on record, as the inset's sentence. */
export function alreadyReadText(fact: RecordFact): { label: string; value: string } {
  return { label: factLabel(fact), value: factValue(fact).text };
}

/* ── money input ── */

/** The currency's mark and which side it sits, read from moneyText: "€" before, "HUF" after. */
export function currencyMark(currency: string): { mark: string; before: boolean } {
  const sample = moneyText(0, currency);
  const mark = sample.replace(/[\d.,\s−-]/g, "");
  return { mark, before: !/^\d/.test(sample) };
}

/* ── keys ── */

/**
 * Where a key submits, say so in words (no glyphs): the control type
 * decides the key, not the question's content.
 */
export function keyHint(type: IntakeQuestion["input_type"], isMac: boolean): string | null {
  switch (type) {
    case "long_text":
      return `${isMac ? "Cmd" : "Ctrl"} + Enter to record`;
    case "text":
    case "number":
    case "money":
    case "date":
    case "entity_list":
      return "Enter to record";
    case "single_select":
    case "boolean":
    case "multi_select":
      return "Keys 1–9 choose";
    default:
      return null;
  }
}

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
export function tapeStamp(raw: string, now: Date): string {
  const d = parseRecordedAt(raw);
  if (!d) return "";
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
export function tapeEntries(facts: readonly RecordFact[], now: Date): TapeEntry[] {
  return facts.map((f) => ({
    id: `${f.key}@${f.recorded_at}`,
    stamp: tapeStamp(f.recorded_at, now),
    label: factLabel(f),
    value: factValue(f).text,
    source: sourceWord(f),
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
): { major: number; currency: string; text: string } | null {
  const v = question.already_read?.value;
  if (!isMoney(v)) return null;
  return {
    major: v.amount_minor / 10 ** minorUnitExponent(v.currency),
    currency: v.currency,
    text: moneyText(v.amount_minor, v.currency),
  };
}

/* ── option tiles ── */

/** Columns for n option tiles: one row up to four, then rows of three or four. */
export function optionColumns(n: number): number {
  if (n <= 4) return Math.max(1, n);
  if (n % 4 === 0 || n > 9) return 4;
  return 3;
}
