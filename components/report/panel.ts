// The diagnostic panel's model — pure, so every rule it applies is unit
// tested (components/report/panel.test.ts). The owner's report design
// (2026-10-17) is a results table: measure, result, prior, reference
// range · act-now line, flag, money a month, basis, and a WHY → that
// opens the derivation sheet.
//
// What the data supports, and nothing more:
//   - a RESULT only where the economics computed one (rule 6: each
//     carries derived_from + formula); a measure the code refused to
//     compute is still a row — "NOT COMPUTED", with the refusal's reason
//     and the missing inputs in its derivation sheet;
//   - a PRIOR only where an earlier report computed the same measure;
//   - NO reference range and no act-now line: neither the report nor the
//     owner's goals carry one for these measures, and an invented band
//     would be a claim the code cannot back. The column prints "—";
//   - NO money-a-month per measure: nothing in the economics prices a
//     measure's gap, so that column prints "—" too;
//   - a flag only from arithmetic the economics did: a margin below zero
//     is ACT NOW; a computed margin that differs from the one the owner
//     gave says so.

import type { Basis } from "./basis";
import { basisOfKey, newerKind, sourceLabel, successorKind } from "./basis";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type { FlagWord, ForecastRange } from "./figures";
import { fmtDay, forecastRange, keyWords, refigure, refigureNumber } from "./figures";
import type { MoneyLike, Severity } from "./figures";
import { moneyText, num } from "../sheet/num";
import type { EconPart } from "../../lib/economics/words";
import { econText } from "../../lib/economics/words";
import type {
  BreakEven,
  Computed,
  Economics,
  FactInfo,
  FactMap,
  Finding,
  History,
  Rec,
  Refusal,
} from "./types";

export interface Figure {
  text: string;
  unit: string;
}

export interface MeasureRow {
  id: string;
  name: string;
  result: Figure | null;
  prior: Figure | null;
  /** DERIVED for every computed figure; null when the measure was not computed. */
  basis: Basis | null;
  flag: FlagWord | null;
  /** The derivation behind the result (rule 6). */
  computed: Computed<unknown> | null;
  refusal: Refusal | null;
  /** The formula, in the owner's words. */
  words: string;
}

interface MeasureDef {
  id: string;
  name: string;
  words: string;
  /** refusals[].what the economics uses for this measure. */
  refusal?: string;
  get: (eco: Economics) => Computed<unknown> | null | undefined;
  fig: (value: unknown, w: PanelWords) => Figure;
}

/**
 * L-3a: the panel's words and figures in the reader's language — the
 * "report" catalogue and the locale the figures print in. English by
 * default, so every English line is what it was.
 */
export interface PanelWords {
  tr: Tr;
  locale: AppLocale;
  /**
   * L-4a: a translator over "econWords", for the economics' own refusals
   * and formulas (lib/economics/words). English prints them as stored.
   */
  econ?: Tr;
}

/** L-4a: the economics' stored words in the panel's language. */
const econ = (text: string, part: EconPart, w: PanelWords): string =>
  w.econ ? econText(text, part, { tr: w.econ, locale: w.locale }) : text;

/** A refusal and a derivation with their stored words read in the panel's language. */
const localRefusal = (r: Refusal, w: PanelWords): Refusal =>
  w.locale === "en" ? r : { ...r, what: econ(r.what, "what", w), why: econ(r.why, "why", w) };
const localComputed = <T>(c: Computed<T>, w: PanelWords): Computed<T> =>
  w.locale === "en" ? c : { ...c, formula: econ(c.formula, "formula", w) };
const ENGLISH = (): PanelWords => ({ tr: englishTr("report"), locale: "en" });

const money = (v: unknown, w: PanelWords, unit = ""): Figure => {
  const m = v as MoneyLike;
  return { text: moneyText(m.amount_minor, m.currency, w.locale), unit };
};
const pct = (v: unknown, w: PanelWords): Figure => ({
  text: num(v as number, 1, w.locale),
  unit: "%",
});

/** The business-wide measures, in the panel's fixed order. */
export const MEASURES: readonly MeasureDef[] = [
  {
    id: "blended_margin",
    name: "Blended margin",
    words:
      "What each sale leaves after what it costs you to deliver, as a share of its price, averaged across your offers, weighted by how many of each you sell.",
    refusal: "offer margins",
    get: (e) => e.blended_margin_pct,
    fig: pct,
  },
  {
    id: "average_order_value",
    name: "Average order value",
    words:
      "Your monthly revenue divided by the number of sales (orders, bookings or visits) in the month.",
    refusal: "average order value",
    get: (e) => e.average_order_value,
    fig: (v, w) => money(v, w),
  },
  {
    id: "cost_per_acquisition",
    name: "Cost to acquire a customer",
    words:
      "What you spend on ads in a month, divided by the sales that came from customers buying for the first time.",
    refusal: "cost per acquisition",
    get: (e) => e.cost_per_acquisition,
    fig: (v, w) => money(v, w),
  },
  {
    id: "return_on_ad_spend",
    name: "Return on ad spend",
    words:
      "All your monthly revenue divided by all your monthly ad spend, blended, not attributed to any one ad.",
    refusal: "return on ad spend",
    get: (e) => e.return_on_ad_spend,
    fig: (v, w) => ({ text: num(v as number, 2, w.locale), unit: "×" }),
  },
  {
    id: "fixed_costs",
    name: "Fixed costs",
    words: "Every fixed cost you gave, turned into a monthly amount by its cadence and added up.",
    get: (e) => e.fixed_costs_monthly,
    fig: (v, w) => money(v, w, w.tr("unit.perMonth")),
  },
  {
    id: "break_even",
    name: "Break-even volume",
    words:
      "Your fixed costs divided by what each sale contributes after its own cost: the number of sales a month that pays for everything.",
    refusal: "break-even",
    get: (e) => e.break_even,
    fig: (v, w) => ({
      text: num((v as BreakEven).units_per_month, 0, w.locale),
      unit: w.tr("unit.perMonth"),
    }),
  },
];

const OFFER_WORDS = "The price, minus what it costs you to deliver one, as a share of the price.";

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The panel's rows: every measure computed or refused, then one per offer.
 * A refusal's own reason (r.what, r.why) is the economics' English
 * sentence, L-4 of TASKS-LANGUAGES.md; the measure's name and its formula
 * in words are the catalogue's.
 */
export function panelRows(
  eco: Economics,
  prior: Economics | null = null,
  w: PanelWords = ENGLISH(),
): MeasureRow[] {
  const refusals = eco.refusals ?? [];
  const used = new Set<string>();
  const rows: MeasureRow[] = [];

  for (const m of MEASURES) {
    const c = m.get(eco) ?? null;
    const refusal = m.refusal ? (refusals.find((r) => r.what === m.refusal) ?? null) : null;
    if (refusal) used.add(refusal.what);
    if (c === null && refusal === null) continue;
    const p = prior ? (m.get(prior) ?? null) : null;
    rows.push({
      id: m.id,
      name: w.tr(`measure.${m.id}.name`),
      result: c ? m.fig(c.value, w) : null,
      prior: p ? m.fig(p.value, w) : null,
      basis: c ? "DERIVED" : null,
      flag: c ? measureFlag(m.id, c, eco, w.tr) : notComputed(w.tr),
      computed: c ? localComputed(c, w) : null,
      refusal: c || !refusal ? null : localRefusal(refusal, w),
      words: w.tr(`measure.${m.id}.words`),
    });
  }

  for (const r of refusals) {
    if (used.has(r.what) || r.what === "offer margins") continue;
    const local = localRefusal(r, w);
    rows.push({
      id: `refused:${r.what}`,
      name: sentence(local.what),
      result: null,
      prior: null,
      basis: null,
      flag: notComputed(w.tr),
      computed: null,
      refusal: local,
      words: local.why,
    });
  }

  for (const o of eco.offers) {
    const c = o.margin_pct;
    const p = prior?.offers.find((x) => x.offer_id === o.offer_id)?.margin_pct ?? null;
    rows.push({
      id: `offer:${o.offer_id}`,
      name: w.tr("measure.offer.name", { name: o.name }),
      result: c ? pct(c.value, w) : null,
      prior: p ? pct(p.value, w) : null,
      basis: c ? "DERIVED" : null,
      flag: c ? (c.value < 0 ? belowCost(w.tr) : null) : notComputed(w.tr),
      computed: c ? localComputed(c, w) : null,
      refusal: c
        ? null
        : {
            what: `margin of ${o.name}`,
            why: w.tr("measure.offer.refusal"),
            missing: [`offers.${o.offer_id}.cost_to_deliver`],
          },
      words: w.tr("measure.offer.words"),
    });
  }
  return rows;
}

/** The English the catalogue's offer row holds (messages/en.json report.measure.offer). */
export const OFFER_ROW = {
  words: OFFER_WORDS,
  refusal:
    "no cost to deliver is recorded for this offer, so there is nothing to take from its price",
};

const notComputed = (tr: Tr): FlagWord => ({ word: tr("flag.notComputed"), tone: "low" });
const belowCost = (tr: Tr): FlagWord => ({ word: tr("flag.belowCost"), tone: "alarm" });

function measureFlag(id: string, c: Computed<unknown>, eco: Economics, tr: Tr): FlagWord | null {
  if (id !== "blended_margin") return null;
  if ((c.value as number) < 0) return belowCost(tr);
  const svc = eco.stated_vs_computed_margin;
  if (svc && Math.abs(svc.delta_pts) >= 1) return { word: tr("flag.differs"), tone: "drift" };
  return null;
}

/* ── the head line under the headline: findings by severity ── */

export interface Tally {
  severity: Severity;
  n: number;
  word: string;
  tone: FlagWord["tone"];
}

const SEVERITY_WORDS: readonly { s: Severity; tone: FlagWord["tone"] }[] = [
  { s: "critical", tone: "alarm" },
  { s: "high", tone: "drift" },
  { s: "medium", tone: "low" },
  { s: "low", tone: "low" },
];

/** "2 act now · 3 high · 1 low" — only the severities that occur, most urgent first. */
export function severityTally(findings: readonly Finding[], tr: Tr = ENGLISH().tr): Tally[] {
  return SEVERITY_WORDS.map(({ s, tone }) => ({
    severity: s,
    n: findings.filter((f) => f.severity === s).length,
    word: tr(`tally.${s}`),
    tone,
  })).filter((t) => t.n > 0);
}

/* ── the headline: the first recommendation the arithmetic gives a range ── */

export interface Headline {
  range: ForecastRange;
  index: number;
  title: string;
}

/**
 * The v1 spec §6.2: a money figure leads only at Diagnosis Grade A or B. At
 * C or D the headline is never a money range, whatever the language; the
 * panel says what was computed instead, and the gaps say what to connect.
 */
export function headline(
  recs: readonly Rec[],
  grade: "A" | "B" | "C" | "D" = "D",
): Headline | null {
  if (grade !== "A" && grade !== "B") return null;
  for (const [index, r] of recs.entries()) {
    const range = forecastRange(
      r.scenario.downside_case,
      r.scenario.upside_case,
      r.scenario.base_case,
    );
    if (range) return { range, index, title: r.title };
  }
  return null;
}

/* ── the derivation sheet: inputs and history ── */

/** Words for one derivation input: a profile key, or a connector series. */
export function inputWords(key: string, map: FactMap, tr: Tr = ENGLISH().tr): string {
  // L-3a: the fact's own label in the reader's language, when the server named it.
  const label = map[key]?.label;
  if (label) return label;
  if (key.startsWith("connector:")) {
    const [, provider = "", series = ""] = key.split(":");
    return `${provider} ${series.replace(/[._]/g, " ")}`.trim();
  }
  // A refusal names inputs by pattern: "offers.<id>.price", "costs.<fixed cost items>".
  const each = /^([a-z_]+?)s?\.<id>\.(.+)$/.exec(key);
  if (each) return `${keyWords(`x.${each[2]}`)} of each ${(each[1] ?? "").replace(/_/g, " ")}`;
  const named = /^[a-z_]+\.<([^>]+)>$/.exec(key);
  if (named) return named[1] ?? key;
  // An offer's own field ("offers.<uuid>.price"); "offers.physical.…" is a
  // field of the business, named like any other.
  const offer =
    /^offers\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(.+)$/.exec(key);
  if (offer) {
    const name = map[`offers.${offer[1]}.name`]?.value;
    return `${name ?? tr("input.offer")} · ${keyWords(`x.${offer[2]}`)}`;
  }
  return keyWords(key);
}

/** A fact map value in the reader's language: an option's label, or money and numbers re-figured. */
export function valueText(f: FactInfo, locale: AppLocale = "en"): string | null {
  if (f.value === null) return null;
  return f.value_words ?? refigureNumber(f.value, locale);
}

export interface InputLine {
  key: string;
  name: string;
  value: string | null;
  basis: Basis | null;
  /** "you told me · 4.2" — source kind in words and what it names. */
  source: string;
}

/** The inputs of a derivation, deduplicated, in the order the formula used them. */
export function inputLines(
  keys: readonly string[],
  map: FactMap,
  w: PanelWords = ENGLISH(),
  sheetTr: Tr = englishTr("sheet"),
): InputLine[] {
  const out: InputLine[] = [];
  for (const key of new Set(keys)) {
    const f = map[key];
    const connector = key.startsWith("connector:");
    out.push({
      key,
      name: sentence(inputWords(key, map, w.tr)),
      value: f ? valueText(f, w.locale) : null,
      basis: basisOfKey(key, map),
      source: connector
        ? w.tr("input.measuredConnected")
        : f
          ? [sourceLabel(f.source_kind, sheetTr), f.source_detail].filter(Boolean).join(" · ")
          : NOT_RECORDED,
    });
  }
  return out;
}

/** InputLine.source for an input the snapshot doesn't hold — a marker the screen words. */
export const NOT_RECORDED = "not recorded";

export interface HistoryEntry {
  date: string;
  text: string;
  /** The newest line — ink just laid down, set on the marker. */
  fresh: boolean;
}

/**
 * The derivation sheet's history, newest first: the figure as this report
 * computed it, the prior report's figure, then every superseded value of
 * every input (rule 3 — superseded, never erased).
 */
export function historyLines(args: {
  row: MeasureRow;
  issuedAt: string;
  priorAt: string | null;
  keys: readonly string[];
  history: History;
  map: FactMap;
  now?: Date;
  words?: PanelWords;
}): HistoryEntry[] {
  const { row, issuedAt, priorAt, keys, history, map, now } = args;
  const w = args.words ?? ENGLISH();
  const lines: { at: string; text: string }[] = [];
  if (row.result) {
    lines.push({ at: issuedAt, text: w.tr("history.computed", { figure: fig(row.result) }) });
  } else if (row.refusal) {
    lines.push({ at: issuedAt, text: w.tr("history.notComputed", { why: row.refusal.why }) });
  }
  if (row.prior && priorAt) {
    lines.push({ at: priorAt, text: w.tr("history.was", { figure: fig(row.prior) }) });
  }
  for (const key of new Set(keys)) {
    const list = history[key] ?? [];
    list.forEach((h, i) => {
      const was = h.value !== null ? refigure(h.value, w.locale) : w.tr("history.notKnown");
      const kind = newerKind(successorKind(list, i, map[key]?.source_kind));
      lines.push({
        at: h.superseded_at,
        text: w.tr("history.superseded", {
          name: sentence(inputWords(key, map, w.tr)),
          was,
          kind,
        }),
      });
    });
  }
  lines.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return lines.map((l, i) => ({
    date: fmtDay(l.at, now, w.locale),
    text: l.text,
    fresh: i === 0,
  }));
}

export const fig = (f: Figure): string => (f.unit === "" ? f.text : `${f.text} ${f.unit}`);
