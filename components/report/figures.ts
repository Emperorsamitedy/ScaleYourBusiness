// The report's and fact sheet's figure helpers — pure, no locale guessing,
// built on components/sheet/num.ts so every figure follows ux-spec §2's
// number grammar: one decimal count per column, a true minus, a space
// between number and unit, and forecasts as ranges.

import { minorUnitExponent } from "../../lib/core/money";
import { moneyFig, moneyText, num } from "../sheet/num";

export interface MoneyLike {
  amount_minor: number;
  currency: string;
}

export const isMoneyLike = (v: unknown): v is MoneyLike =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { amount_minor?: unknown }).amount_minor === "number" &&
  typeof (v as { currency?: unknown }).currency === "string";

/**
 * The one decimal count a money column uses: whole units when every
 * amount in it is whole, otherwise the largest currency exponent present.
 * A column never mixes "290" and "12.50".
 */
export function columnDecimals(amounts: readonly (MoneyLike | null | undefined)[]): number {
  let decimals = 0;
  for (const m of amounts) {
    if (!m) continue;
    const exp = minorUnitExponent(m.currency);
    if (exp > 0 && m.amount_minor % 10 ** exp !== 0) decimals = Math.max(decimals, exp);
  }
  return decimals;
}

/** A plain number column's decimals: 0 when every value is whole, else `fallback`. */
export function numberDecimals(
  values: readonly (number | null | undefined)[],
  fallback = 1,
): number {
  return values.every((v) => v === null || v === undefined || Number.isInteger(v)) ? 0 : fallback;
}

/** Money with a sign, for a change: "+340", "−120", "0". */
export function signedMoney(m: MoneyLike, decimals = 0): string {
  const body = moneyFig(m.amount_minor, m.currency, decimals);
  return m.amount_minor > 0 && Number(body.replace(/[^\d.]/g, "")) !== 0 ? `+${body}` : body;
}

export interface ForecastCase {
  case: string;
  profit_delta_monthly?: MoneyLike | null;
}

export interface ForecastRange {
  low: MoneyLike;
  high: MoneyLike;
  currency: string;
}

/**
 * The headline of a scenario: low – high monthly profit change across the
 * cases. Only when the downside AND the upside both carry a figure in one
 * currency — otherwise null, and the page shows the statements alone
 * rather than a single point dressed as a forecast. The base case is
 * folded in so a base outside the two can never sit outside the range.
 */
export function forecastRange(
  downside: ForecastCase,
  upside: ForecastCase,
  base?: ForecastCase,
): ForecastRange | null {
  const d = downside.profit_delta_monthly ?? null;
  const u = upside.profit_delta_monthly ?? null;
  if (!d || !u || d.currency !== u.currency) return null;
  const all = [d, u];
  const b = base?.profit_delta_monthly ?? null;
  if (b && b.currency === d.currency) all.push(b);
  const amounts = all.map((m) => m.amount_minor);
  return {
    low: { amount_minor: Math.min(...amounts), currency: d.currency },
    high: { amount_minor: Math.max(...amounts), currency: d.currency },
    currency: d.currency,
  };
}

/** "−120 – +340" at one decimal count for both ends. */
export function rangeText(r: ForecastRange): string {
  const decimals = columnDecimals([r.low, r.high]);
  return `${signedMoney(r.low, decimals)} – ${signedMoney(r.high, decimals)}`;
}

/* ── re-figuring money the server already turned into text ── */

// The fact sheet and the report's fact map carry values humanised by
// repr() in lib/profile/factsheet.ts: "1 234.5 EUR" — en-US grouping
// swapped to spaces, decimals dropped when zero, and a private exponent
// table (HUF/EUR/USD/GBP 2, JPY 0, everything else 2). Re-reading that
// text with the same table recovers the exact integer minor units, which
// then print through num.ts with the currency's true exponent — so a
// 3-decimal currency that repr() divided by 100 also comes out right.
const REPR_EXPONENT: Record<string, number> = { HUF: 2, EUR: 2, USD: 2, GBP: 2, JPY: 0 };
const REPR_MONEY = /^(-?)(\d{1,3}(?: \d{3})*)(?:\.(\d+))? ([A-Z]{3})$/;

/** The integer minor units behind a repr()'d money string, or null when it isn't one. */
export function parseReprMoney(text: string): MoneyLike | null {
  const m = REPR_MONEY.exec(text.trim());
  if (!m) return null;
  const [, sign = "", int = "", frac = "", currency = ""] = m;
  const exp = REPR_EXPONENT[currency] ?? 2;
  if (frac.length > exp) return null;
  const minor = Number(int.replace(/ /g, "") + frac.padEnd(exp, "0"));
  if (!Number.isSafeInteger(minor)) return null;
  return { amount_minor: sign === "-" ? -minor : minor, currency };
}

/** A server-humanised value with any money re-printed by the number grammar. */
export function refigure(text: string): string {
  const m = parseReprMoney(text);
  return m ? moneyText(m.amount_minor, m.currency) : text;
}

/** True when a humanised value is a figure (money or a bare number) and belongs in mono. */
export function isFigureText(text: string): boolean {
  return parseReprMoney(text) !== null || /^-?\d+(\.\d+)?$/.test(text.trim());
}

/** A bare numeric string re-printed with grouping: "12000" → "12 000". */
export function refigureNumber(text: string): string {
  const t = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return refigure(text);
  const decimals = t.includes(".") ? (t.split(".")[1] ?? "").length : 0;
  return num(Number(t), decimals);
}

/* ── dates: always with the year, never locale-guessed ── */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "17 Oct 2026" from an ISO date or timestamp (UTC calendar date); the input when unparseable. */
export function fmtDate(iso: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/* ── worded severity ── */

export type Severity = "critical" | "high" | "medium" | "low";
export interface FlagWord {
  word: string;
  /** The sheet.css tint class: the word carries meaning, this only tints it. */
  tone: "alarm" | "drift" | "low";
}

export function severityFlag(s: Severity): FlagWord {
  switch (s) {
    case "critical":
      return { word: "ACT NOW", tone: "alarm" };
    case "high":
      return { word: "HIGH", tone: "drift" };
    case "medium":
      return { word: "MEDIUM", tone: "low" };
    case "low":
      return { word: "LOW", tone: "low" };
  }
}

/* ── field keys as words ── */

const UUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/* Keys whose literal words mislead — the bank's phrasing, shortened. */
const KEY_LABEL: Record<string, string> = { volume_period: "sold per month" };

/** "offers.<uuid>.cost_to_deliver" → "cost to deliver"; "revenue.monthly_revenue" → "monthly revenue". */
export function keyWords(key: string, dropSection = true): string {
  const segs = key.split(".").filter((seg) => !UUID_SEG.test(seg));
  const use = dropSection && segs.length > 1 ? segs.slice(1) : segs;
  return use.map((seg) => KEY_LABEL[seg] ?? seg.replace(/_/g, " ")).join(" · ");
}
