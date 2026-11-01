// "My track record" — idea 54 (I-54.4). Pure: rows in, words out. The
// /history page reads the rows on the server (./load) and hands the screen
// this view, already in words.
//
// The headline counts only forecasts that were graded right or wrong:
// inside, above or below. "Can't tell" is named beside it and counted
// apart, never as right. Under three graded forecasts it says it is too
// soon to judge. A miss is listed in the same words and type as a hit,
// with how far off it was in the forecast's own units (the grade's note).

import { wholeMoney } from "../cash/model";
import { shortDate } from "../charts/model";
import { parseInstant } from "../watch/watch-view";
import { addDays } from "../seasons/forecast";
import type { ForecastKind } from "./claims";
import type { Verdict } from "./grade";
import { GRADE, isDue } from "./grade";

/** Graded forecasts needed before the headline judges anything. */
export const TRACK_MIN_GRADED = 3;

/** Review 2026-10-30: the newest this many are listed; the counts cover every one. */
export const TRACK_LISTED = 50;

/**
 * Every forecast of the business, counted by kind and grade (verdict null:
 * not graded yet), so the headline never needs every row in the page.
 */
export interface TrackTally {
  kind: string;
  verdict: string | null;
  n: number;
}

/** The columns the view reads, as Postgres returns them. */
export interface TrackRow {
  id: string;
  kind: string;
  made_at: string;
  recorded_at: string;
  subject: string;
  subject_ref: unknown;
  unit: string;
  window_start: string;
  window_end: string;
  low_minor: number | null;
  high_minor: number | null;
  currency: string | null;
  low_num: string | null;
  high_num: string | null;
  low_date: string | null;
  high_date: string | null;
  claim: string;
  basis: string;
  graded_at: string | null;
  verdict: string | null;
  actual_note: string | null;
}

export type TrackWord = Verdict | "waiting";

export interface TrackEntry {
  id: string;
  kind: ForecastKind;
  /** "Stock run-out" / "Week against last year". */
  kind_label: string;
  made_at: string;
  /** "Said on 26 Oct 2026". */
  said_on: string;
  /** The range in its own units: "€3,700–€4,500", "1 Nov to 3 Nov 2026". */
  range: string;
  claim: string;
  basis: string;
  word: TrackWord;
  /** What happened, or why it isn't graded yet. */
  happened: string;
  /** Set when the row was written to the record well after the day it is dated. */
  backdated: string | null;
}

export interface TrackKindLine {
  kind: ForecastKind;
  label: string;
  graded: number;
  inside: number;
  cant_tell: number;
  waiting: number;
  sentence: string;
}

export interface TrackView {
  headline: string;
  too_soon: boolean;
  /** Inside, above and below: the forecasts that were right or wrong. */
  graded: number;
  inside: number;
  above: number;
  below: number;
  cant_tell: number;
  waiting: number;
  kinds: TrackKindLine[];
  /** Newest first, at most TRACK_LISTED. */
  entries: TrackEntry[];
  /** Review 2026-10-30: forecasts counted above but not listed, and the line saying so. */
  older: number;
  older_line: string | null;
}

const KIND_LABEL: Record<ForecastKind, { one: string; many: string }> = {
  stock_out: { one: "Stock run-out", many: "Stock run-out dates" },
  season_week: { one: "Week against last year", many: "Weeks against last year" },
  cash_close: { one: "Cash at a week's end", many: "Cash at weeks' ends" },
};

const isKind = (k: string): k is ForecastKind =>
  k === "stock_out" || k === "season_week" || k === "cash_close";
const isVerdict = (v: string | null): v is Verdict =>
  v === "inside" || v === "above" || v === "below" || v === "cant_tell";

/** "26 Oct 2026", from a date or a Postgres timestamp. */
function dayWords(at: string): string {
  const day = at.length === 10 ? at : new Date(parseInstant(at)).toISOString().slice(0, 10);
  return `${shortDate(day)} ${day.slice(0, 4)}`;
}

const instant = parseInstant;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The range in the forecast's own units. */
export function rangeWords(r: TrackRow): string {
  if (r.unit === "money" && r.low_minor !== null && r.high_minor !== null && r.currency) {
    const lo = wholeMoney(r.low_minor, r.currency);
    const hi = wholeMoney(r.high_minor, r.currency);
    return lo === hi ? `about ${lo}` : `${lo}–${hi}`;
  }
  if (r.unit === "count" && r.low_num !== null && r.high_num !== null) {
    const lo = Math.round(Number(r.low_num));
    const hi = Math.round(Number(r.high_num));
    return lo === hi ? `about ${lo} ${r.subject}` : `${lo}–${hi} ${r.subject}`;
  }
  if (r.unit === "date" && r.low_date && r.high_date) {
    return r.low_date === r.high_date
      ? `on ${dayWords(r.low_date)}`
      : `${shortDate(r.low_date)} to ${dayWords(r.high_date)}`;
  }
  return "—";
}

function waitingWords(r: TrackRow, today: string): string {
  const source = (r.subject_ref as { source?: unknown } | null)?.source;
  if (r.window_end >= today) {
    return `Not graded yet: its window closes on ${dayWords(r.window_end)}, and I grade it on the first weekly check after.`;
  }
  // Review 2026-10-30: just closed is not yet due, which is no wait for figures.
  if (!isDue(r.window_end, today)) {
    return `Not graded yet: I'll check it on the first weekly check after ${dayWords(addDays(r.window_end, GRADE.after_days))}.`;
  }
  return `Not graded yet: waiting for ${typeof source === "string" ? `${source}'s` : "the measured"} figures for those days.`;
}

/** One forecast as the screen lists it. */
export function trackEntry(r: TrackRow, today: string): TrackEntry | null {
  if (!isKind(r.kind)) return null;
  const graded = r.graded_at !== null && isVerdict(r.verdict);
  // The app records a forecast the moment it shows it; only the demo seed
  // writes one dated days earlier, and the screen says so.
  const late = instant(r.recorded_at) - instant(r.made_at) > 86_400_000;
  return {
    id: r.id,
    kind: r.kind,
    kind_label: KIND_LABEL[r.kind].one,
    made_at: r.made_at,
    said_on: `Said on ${dayWords(r.made_at)}`,
    range: rangeWords(r),
    claim: r.claim,
    basis: r.basis,
    word: graded ? (r.verdict as Verdict) : "waiting",
    happened: graded ? (r.actual_note ?? "") : waitingWords(r, today),
    backdated: late
      ? `Written to the record on ${dayWords(r.recorded_at)}, after the day it is dated: a demo example. A real account's forecasts are recorded the moment they are shown.`
      : null,
  };
}

/**
 * The whole record: the headline and the kinds over every forecast (from
 * `tally` when given, else from `rows`), and the rows given listed newest first.
 */
export function trackView(
  rows: readonly TrackRow[],
  today: string,
  tally?: readonly TrackTally[],
): TrackView {
  // Newest said first; forecasts said together, in the order of their windows.
  const entries = [...rows]
    .sort(
      (a, b) =>
        instant(b.made_at) - instant(a.made_at) ||
        (a.window_end < b.window_end ? -1 : a.window_end > b.window_end ? 1 : 0),
    )
    .map((r) => trackEntry(r, today))
    .filter((e): e is TrackEntry => e !== null);
  // Review 2026-10-30: counted over the tally, which covers rows not listed.
  const counted: { kind: ForecastKind; word: TrackWord; n: number }[] = (
    tally ??
    rows.map((r) => ({
      kind: r.kind,
      verdict: r.graded_at !== null ? r.verdict : null,
      n: 1,
    }))
  )
    .filter((t): t is TrackTally & { kind: ForecastKind } => isKind(t.kind))
    .map((t) => ({ kind: t.kind, word: isVerdict(t.verdict) ? t.verdict : "waiting", n: t.n }));
  const count = (list: readonly { word: TrackWord; n: number }[], w: TrackWord) =>
    list.filter((e) => e.word === w).reduce((s, e) => s + e.n, 0);
  const total = counted.reduce((s, e) => s + e.n, 0);
  const inside = count(counted, "inside");
  const above = count(counted, "above");
  const below = count(counted, "below");
  const cantTell = count(counted, "cant_tell");
  const waiting = count(counted, "waiting");
  const graded = inside + above + below;
  const tooSoon = graded < TRACK_MIN_GRADED;

  const couldnt =
    cantTell > 0
      ? ` I couldn't tell on ${cantTell}: the measured figures weren't there, or something I didn't forecast got in the way. ${cantTell === 1 ? "It isn't" : "They aren't"} counted either way.`
      : "";
  const headline =
    total === 0
      ? "No forecasts on record yet. When I give one, it goes here with its range, and once its time has passed, what happened."
      : tooSoon
        ? `Too soon to judge my forecasts: ${graded === 0 ? "none" : graded} graded so far, ${plural(waiting, "forecast", "forecasts")} waiting for ${waiting === 1 ? "its" : "their"} time to pass.${couldnt}`
        : `${inside} of my last ${graded} forecasts landed inside the range I gave; ${graded - inside} missed.${couldnt}`;

  const kinds: TrackKindLine[] = [];
  for (const kind of Object.keys(KIND_LABEL) as ForecastKind[]) {
    const list = counted.filter((e) => e.kind === kind);
    if (list.length === 0) continue;
    const k = {
      graded: count(list, "inside") + count(list, "above") + count(list, "below"),
      inside: count(list, "inside"),
      cant_tell: count(list, "cant_tell"),
      waiting: count(list, "waiting"),
    };
    const parts = [
      k.graded > 0 ? `${k.inside} of ${k.graded} inside` : "none graded yet",
      ...(k.cant_tell > 0 ? [`${k.cant_tell} couldn't tell`] : []),
      ...(k.waiting > 0 ? [`${k.waiting} waiting`] : []),
    ];
    kinds.push({
      kind,
      label: KIND_LABEL[kind].many,
      ...k,
      sentence: `${KIND_LABEL[kind].many}: ${parts.join(", ")}.`,
    });
  }

  return {
    headline,
    too_soon: tooSoon,
    graded,
    inside,
    above,
    below,
    cant_tell: cantTell,
    waiting,
    kinds,
    entries,
    older: Math.max(0, total - entries.length),
    older_line:
      total > entries.length
        ? `${plural(total - entries.length, "older forecast isn't", "older forecasts aren't")} listed here; the counts above include ${total - entries.length === 1 ? "it" : "them"}.`
        : null,
  };
}
