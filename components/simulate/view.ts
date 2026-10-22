// Pure helpers for the campaign simulator screen (feature 36). Everything
// the screen shows that is wording or arithmetic lives here, so it is
// testable without a browser: the cell words, the headline, the default
// picks and the whisker chart's geometry.

import type {
  Catalog,
  Cell,
  OptionResult,
  SimInputs,
  SimOption,
  Unit,
} from "../../lib/simulate/model";
import { SIM, optionKey, simulateOption, valueText } from "../../lib/simulate/model";

export interface CellView {
  /** The figure in mono, or a dash. */
  figure: string;
  /** The basis words of what it rests on, or the flag word. */
  basis: string;
  /** A worded flag for a gap; null for a figure. */
  flag: "MISSING" | "NOT READ" | null;
  /** The arithmetic, or what would fill the gap, or why it isn't read. */
  detail: string;
}

/** Pure: one table cell in words. A gap is never printed as a number. */
export function cellView(cell: Cell, unit: Unit, currency: string): CellView {
  if (cell.status === "range") {
    return {
      figure: valueText(cell.range, unit, currency, cell.exact),
      basis: cell.bases.length > 0 ? cell.bases.join(" · ") : cell.exact ? "SET BY THE OPTION" : "",
      flag: null,
      detail: cell.formula,
    };
  }
  if (cell.status === "missing") {
    return { figure: "—", basis: "", flag: "MISSING", detail: `needs ${cell.needs.join("; ")}` };
  }
  return { figure: "—", basis: "", flag: "NOT READ", detail: cell.why };
}

/** Every option the catalog offers, at the default share for a budget change. */
export function allOptions(c: Catalog, share = DEFAULT_SHARE): SimOption[] {
  const out: SimOption[] = c.email.map((e) => ({ kind: "email", segment: e.key }));
  for (const k of c.campaigns) {
    out.push({ kind: "ads", change: "raise", campaign_ref: k.ref, share });
    out.push({ kind: "ads", change: "lower", campaign_ref: k.ref, share });
    out.push({ kind: "ads", change: "pause", campaign_ref: k.ref });
  }
  out.push({ kind: "content" });
  return out;
}

/** The budget change the screen starts at — P3-22a's own raise. */
export const DEFAULT_SHARE = 0.2;

/** The shares the picker offers: 5% steps inside the pinned bounds. */
export function shareSteps(): number[] {
  const out: number[] = [];
  for (let p = SIM.ads_min_change_share * 100; p <= SIM.ads_max_change_share * 100 + 1e-9; p += 5) {
    out.push(Math.round(p) / 100);
  }
  return out;
}

const priced = (r: OptionResult) => r.measures.revenue.status === "range";

/** Pure: the screen's one display line, from the real numbers. */
export function headline(c: Catalog, x: SimInputs): string {
  const results = allOptions(c).map((o) => simulateOption(o, x));
  const n = results.filter(priced).length;
  if (n === 0) {
    return `None of your ${results.length} campaign options can be priced from your own numbers yet — each one shows what it's missing.`;
  }
  return `${n} of your ${results.length} campaign options can be priced from your own numbers.`;
}

/** Pure: the first picks — two options that can be priced, of different kinds where possible. */
export function defaultPicks(c: Catalog, x: SimInputs): SimOption[] {
  const all = allOptions(c);
  const results = all.map((o) => simulateOption(o, x));
  const ok = all.filter((_, i) => priced(results[i]!));
  const picks: SimOption[] = [];
  for (const o of ok) {
    if (picks.length === 2) break;
    if (picks.every((p) => p.kind !== o.kind)) picks.push(o);
  }
  for (const o of [...ok, ...all]) {
    if (picks.length === SIM.min_options) break;
    if (!picks.some((p) => optionKey(p) === optionKey(o))) picks.push(o);
  }
  return picks;
}

/** Pure: add or remove an option, holding the side by side to its maximum. */
export function togglePick(picks: readonly SimOption[], o: SimOption): SimOption[] {
  const key = optionKey(o);
  if (picks.some((p) => optionKey(p) === key)) return picks.filter((p) => optionKey(p) !== key);
  if (picks.length >= SIM.max_options) return [...picks];
  return [...picks, o];
}

/* ── the whisker chart: expected profit, low to high, with the worst case ── */

export interface Whisker {
  key: string;
  label: string;
  /** Percent positions on the shared axis; null when profit wasn't worked out. */
  low: number | null;
  high: number | null;
  worst: number | null;
  text: string;
}

export interface WhiskerChart {
  zero: number;
  ticks: { at: number; label: string }[];
  rows: Whisker[];
  currency: string | null;
}

function step(span: number): number {
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

/**
 * Pure: one whisker per option on one axis that always includes zero (an
 * effect is read against "nothing changes"). Only one currency can share an
 * axis (rule 1): with two, the chart is left out.
 */
export function whiskerChart(results: readonly OptionResult[]): WhiskerChart | null {
  const currencies = new Set(results.map((r) => r.currency.toUpperCase()));
  if (currencies.size !== 1) return null;
  const currency = results[0]?.currency ?? null;
  const values: number[] = [0];
  for (const r of results) {
    const p = r.measures.profit;
    const w = r.measures.worst;
    if (p.status === "range") values.push(p.range.low, p.range.high);
    if (w.status === "range") values.push(w.range.low);
  }
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 100;
    max += 100;
  }
  const s = step(max - min);
  min = Math.floor(min / s) * s;
  max = Math.ceil(max / s) * s;
  const at = (v: number) => ((v - min) / (max - min)) * 100;
  const ticks: { at: number; label: string }[] = [];
  for (let v = min; v <= max + 1e-9; v += s) {
    ticks.push({
      at: at(v),
      label: valueText({ low: v, high: v }, "money", currency ?? "EUR", true),
    });
  }
  return {
    zero: at(0),
    ticks,
    currency,
    rows: results.map((r) => {
      const p = r.measures.profit;
      const w = r.measures.worst;
      return {
        key: r.key,
        label: r.title,
        low: p.status === "range" ? at(p.range.low) : null,
        high: p.status === "range" ? at(p.range.high) : null,
        worst: w.status === "range" && p.status === "range" ? at(w.range.low) : null,
        text:
          p.status === "range"
            ? `${valueText(p.range, "money", r.currency)}${w.status === "range" ? `, worst ${valueText(w.range, "money", r.currency, true)}` : ""}`
            : "not worked out",
      };
    }),
  };
}

/** The kind's label, for a card's mono kicker. */
export const KIND_LABEL: Record<SimOption["kind"], string> = {
  email: "Email",
  ads: "Meta ads",
  content: "Content",
};
