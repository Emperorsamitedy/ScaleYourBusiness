// What-if pricing — idea 43, beside the campaign simulator (feature 36).
// The owner picks one product or service and up to four price changes,
// and sees side by side what each does to its monthly profit.
//
// Pure arithmetic, no model (CLAUDE.md cost rule). Two kinds of figure,
// kept apart on purpose:
//
//   the break-even   how many sales the change can lose (a rise) or must
//                    win (a cut) before the item's profit is where it is
//                    today. It rests only on the owner's own numbers —
//                    price, cost to deliver, volume — so it is the
//                    headline, and it assumes nothing about customers:
//                      rise: lose fewer than V × (P′ − P) ÷ (P′ − C)
//                      cut:  win more than  V × (P − P′) ÷ (P′ − C)
//   the outcomes     sales, revenue and profit a month under a stated band
//                    of customer response (pricing-bands.ts, ASSUMED,
//                    never a measurement), always a range:
//                      V′ = V × (1 − s × e),  e from the band's low to high
//                      profit change = V′ × (P′ − C) − V × (P − C)
//
// A missing input is MISSING with the question that asks it, never a
// guess. With no cost to deliver a rise's break-even is still a true
// floor — (P′ − P) ÷ P′ holds for any cost — and says so; profit waits for
// the cost. A booking business's service is read from its own bookings,
// and a cut can't win more bookings than the stated capacity has room for.
//
// Money is integer minor units with its currency (rule 1), rounded once
// where a rate meets money. One item is one currency; a cost in another
// currency is treated as missing, never converted. Read-only: nothing
// here writes a price or makes a proposal — checkout and prices are
// untouchable (rule 18), and this only simulates.
//
// L-4b (TASKS-LANGUAGES.md): every sentence here is a message in
// "simulateWords.pricing", every figure formatted in the reader's locale
// and passed in; each builder takes the words last, English by default,
// so English is exactly what this file printed before.

import type { Basis } from "../../components/report/basis";
import { moneyText, num } from "../../components/sheet/num";
import type { ArchetypeKey } from "../charts/profiles";
import { minorUnitExponent, ratioBp, scaleMinor } from "../core/money";
import type { AppLocale } from "../i18n/locales";
import { rangeOf } from "../i18n/range";
import { intlTag } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import type { Cell, Range } from "./model";
import { SIM, SimulateError, orderBases, range, roundRange } from "./model";
import type { ResponseBand } from "./pricing-bands";
import { RESPONSE_BANDS } from "./pricing-bands";
import type { SimText } from "./words";
import { englishSimText, int, pointsPct, section, wholePct } from "./words";

/** The pinned bounds — one place, boundary-tested (pricing.test.ts). */
export const PRICING = {
  /** A booking business's volume is its last 28 days, the simulator's horizon. */
  horizon_days: SIM.horizon_days,
  /** The steps the picker offers, as signed shares. */
  steps: [-0.2, -0.15, -0.1, -0.05, 0.05, 0.1, 0.15, 0.2] as readonly number[],
  /** What the screen opens on. */
  default_steps: [0.05, 0.1, -0.1] as readonly number[],
  /** A change smaller than this isn't a price change worth simulating. */
  min_change_share: 0.01,
  /** Past this the response bands are no fair guide, so it isn't simulated. */
  max_change_share: 0.3,
  /** The side by side compares this many changes at most. */
  max_changes: 4,
} as const;

/* ── the raw inputs, as lib/simulate/pricing-inputs.ts reads them ── */

export interface MoneyFact {
  amount_minor: number;
  currency: string;
  basis: Basis;
  /** Where it came from, in words. */
  source: string;
}

export interface CountFact {
  value: number;
  basis: Basis;
  source: string;
}

/** Where a missing input is asked: the question, or the screen that fills it. */
export interface Asks {
  price: string;
  unit_cost: string;
  volume: string;
  /** Booking businesses only. */
  capacity: string | null;
}

export interface PriceItemRaw {
  /** "offer:<id>" or "service:<name>:<currency>". */
  key: string;
  kind: "offer" | "service";
  name: string;
  /** The item's currency: its price's. */
  currency: string;
  price: MoneyFact | null;
  unit_cost: MoneyFact | null;
  /** Units a period: "a month" for an offer, the last 28 days for a booked service. */
  volume: CountFact | null;
  /** Booking businesses: the slots a period and how many are already taken. */
  capacity: { slots: number; taken: number; basis: Basis; source: string } | null;
  asks: Asks;
}

export interface PricingInputs {
  as_of: string;
  currency: string;
  archetype: ArchetypeKey;
  items: PriceItemRaw[];
  /** Per-order costs the owner told me about (cost items charged per order), shown, not counted. */
  per_order_costs: { label: string; amount_minor: number; currency: string }[];
}

/* ── the words ── */

/** The words a pricing sentence is built with: the "pricing" section and the locale. */
interface W {
  t: Tr;
  L: AppLocale;
}

const wordsOf = (w: SimText): W => ({ t: section(w, "pricing"), L: w.locale });

/* ── a change ── */

export type PriceChange = { kind: "share"; share: number } | { kind: "exact"; price_minor: number };

/** A stable id for a change. */
export function changeKey(c: PriceChange): string {
  return c.kind === "share" ? `share:${Math.round(c.share * 1000)}` : `exact:${c.price_minor}`;
}

/** Pure: the new price in integer minor units, rounded once. */
export function newPriceOf(price_minor: number, c: PriceChange): number {
  return c.kind === "exact" ? c.price_minor : price_minor + scaleMinor(price_minor, c.share);
}

/**
 * Pure: why a change can't be simulated against this price, or null.
 * The bounds apply to the change as it lands on the price, so an exact
 * price is held to the same limits as a step.
 */
export function changeError(
  price_minor: number,
  c: PriceChange,
  w: SimText = englishSimText(),
): string | null {
  const { t, L } = wordsOf(w);
  if (c.kind === "exact" && !(Number.isSafeInteger(c.price_minor) && c.price_minor > 0)) {
    return t("refuse.zero");
  }
  if (c.kind === "share" && !Number.isFinite(c.share)) return t("refuse.notAChange");
  const next = newPriceOf(price_minor, c);
  if (next <= 0) return t("refuse.zero");
  // The bounds compared in integers: |change| × 10 000 against basis points × price.
  const change = Math.abs(next - price_minor) * 10_000;
  const minBp = Math.round(PRICING.min_change_share * 10_000);
  const maxBp = Math.round(PRICING.max_change_share * 10_000);
  if (change < minBp * price_minor) {
    return t("refuse.tooSmall", { share: pctWords(PRICING.min_change_share, L) });
  }
  if (change > maxBp * price_minor) {
    return t("refuse.tooBig", { share: pctWords(PRICING.max_change_share, L) });
  }
  return null;
}

/* ── the results ── */

/** One input: a value with its basis and source, or a gap with where it's asked. */
export interface PriceInput {
  key: "price" | "unit_cost" | "volume" | "response" | "capacity";
  label: string;
  /** The label as it reads inside a sentence ("price now: …"), in the same words as `label`. */
  label_inline: string;
  /** What the screen prints in the value column; "-" when missing. */
  value: string;
  basis: Basis | null;
  source: string;
  /** Missing: what fills it, and the link to where it's asked. */
  needs: { what: string; href: string } | null;
}

export type BreakEven =
  | {
      status: "lose";
      /** The share of sales the rise can lose and still come out ahead (exclusive). */
      share: number;
      /** The same in units; null without a volume. */
      units: number | null;
      /** True when the cost is unknown: a floor that holds for any cost. */
      floor: boolean;
      words: string;
      formula: string;
      bases: Basis[];
    }
  | {
      status: "win";
      share: number;
      units: number | null;
      floor: boolean;
      /** Booking businesses with a stated capacity: the bookings the book has room for. */
      room: number | null;
      words: string;
      formula: string;
      bases: Basis[];
    }
  | { status: "never"; words: string; formula: string; bases: Basis[] }
  | { status: "missing"; words: string; needs: { what: string; href: string }[] };

export const PRICE_MEASURES = ["volume", "revenue", "profit", "worst"] as const;
export type PriceMeasure = (typeof PRICE_MEASURES)[number];

export const PRICE_MEASURE_LABEL: Record<PriceMeasure, string> = {
  volume: "Sales after the change",
  revenue: "Revenue change",
  profit: "Profit change",
  worst: "Worst case",
};

export const PRICE_MEASURE_UNIT: Record<PriceMeasure, "money" | "count"> = {
  volume: "count",
  revenue: "money",
  profit: "money",
  worst: "money",
};

export interface PriceResult {
  key: string;
  change: PriceChange;
  /** "+10%", "−10%", "€36 exact". */
  title: string;
  currency: string;
  old_price_minor: number;
  new_price_minor: number;
  /** The change as it lands on the price, signed. */
  share: number;
  inputs: PriceInput[];
  /** The projection's assumptions, labelled ASSUMED with their source. */
  assumptions: { statement: string; source: string }[];
  breakeven: BreakEven;
  measures: Record<PriceMeasure, Cell>;
  worst_words: string;
}

/* ── formatting ── */

/** A price at its own decimals ("€37.40"); a monthly figure in whole units, signed. */
const price = (minor: number, currency: string, locale: AppLocale = "en") =>
  moneyText(minor, currency, locale);
/** A share at fixed decimals: 0.123 → "12.3%"; in another language, its own. */
const pct = (x: number, locale: AppLocale = "en", d = 1) =>
  locale === "en"
    ? `${num(x * 100, d)}%`
    : new Intl.NumberFormat(intlTag(locale), {
        style: "percent",
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      }).format(x);
/** A share in words at the fewest decimals that say it: "10%", "12.5%". */
const pctWords = (x: number, locale: AppLocale = "en") => {
  const v = Math.round(x * 1000) / 10;
  const d = Number.isInteger(v) ? 0 : 1;
  return locale === "en" ? `${num(v, d)}%` : pct(v / 100, locale, d);
};
const signedPct = (x: number, locale: AppLocale = "en") =>
  `${x > 0 ? "+" : x < 0 ? "−" : ""}${pctWords(Math.abs(x), locale)}`;
const units = (x: number, locale: AppLocale = "en") =>
  Number.isInteger(x) ? num(x, 0, locale) : num(x, 1, locale);
/** A response-band figure, in percent points: 0.8 → "0.8%". */
const bandPct = (points: number, locale: AppLocale) => pointsPct(points, locale);

/** What one unit is called, by the kind of item. */
export function unitNoun(item: Pick<PriceItemRaw, "kind">, many = true): string {
  return item.kind === "service" ? (many ? "bookings" : "booking") : many ? "sales" : "sale";
}

/** The period a volume covers, in words. */
export function periodWords(item: Pick<PriceItemRaw, "kind">): string {
  return item.kind === "service" ? `every ${PRICING.horizon_days} days` : "a month";
}

/** Pure: a change's short title. */
export function changeTitle(
  old_minor: number,
  c: PriceChange,
  currency: string,
  w: SimText = englishSimText(),
): string {
  const { t, L } = wordsOf(w);
  const next = newPriceOf(old_minor, c);
  if (c.kind === "share") {
    return t("title.share", { change: signedPct(c.share, L), price: price(next, currency, L) });
  }
  const changeBp = ratioBp(next - old_minor, old_minor);
  return t("title.exact", {
    price: price(next, currency, L),
    change: signedPct(changeBp / 10_000, L), // a percentage shown as words, from exact basis points
  });
}

/* ── the inputs, with their gaps ── */

/** An input's label, and the same label as it reads inside a sentence. */
function labelled(t: Tr, key: string, values?: Record<string, string | number>) {
  return { label: t(`label.${key}`, values), label_inline: t(`inline.${key}`, values) };
}

function priceInput(item: PriceItemRaw, { t, L }: W): PriceInput {
  return item.price
    ? {
        key: "price",
        ...labelled(t, "price"),
        value: price(item.price.amount_minor, item.currency, L),
        basis: item.price.basis,
        source: item.price.source,
        needs: null,
      }
    : {
        key: "price",
        ...labelled(t, "price"),
        value: "-",
        basis: null,
        source: t("notKnown"),
        needs: { what: t("priceNeeds", { name: item.name }), href: item.asks.price },
      };
}

/** A cost in another currency is no cost to this item: it is never converted. */
function usableCost(item: PriceItemRaw): MoneyFact | null {
  const c = item.unit_cost;
  return c && c.currency.toUpperCase() === item.currency.toUpperCase() ? c : null;
}

function costInput(item: PriceItemRaw, { t, L }: W): PriceInput {
  const c = item.unit_cost;
  const ok = usableCost(item);
  if (ok) {
    return {
      key: "unit_cost",
      ...labelled(t, "cost"),
      value: price(ok.amount_minor, item.currency, L),
      basis: ok.basis,
      source: ok.source,
      needs: null,
    };
  }
  return {
    key: "unit_cost",
    ...labelled(t, "cost"),
    value: "-",
    basis: null,
    source: c
      ? t("costOtherCurrency", { costCurrency: c.currency, currency: item.currency })
      : t("notKnown"),
    needs: {
      what:
        item.kind === "service"
          ? t("costNeedsService", { name: item.name })
          : c
            ? t("costNeedsIn", { name: item.name, currency: item.currency })
            : t("costNeeds", { name: item.name }),
      href: item.asks.unit_cost,
    },
  };
}

function volumeInput(item: PriceItemRaw, { t, L }: W): PriceInput {
  const label = labelled(t, "volume", { kind: item.kind, days: int(PRICING.horizon_days, L) });
  return item.volume
    ? {
        key: "volume",
        ...label,
        value: units(item.volume.value, L),
        basis: item.volume.basis,
        source: item.volume.source,
        needs: null,
      }
    : {
        key: "volume",
        ...label,
        value: "-",
        basis: null,
        source: t("notKnown"),
        needs: {
          what:
            item.kind === "service"
              ? t("volumeNeedsService", { name: item.name })
              : t("volumeNeeds", { name: item.name }),
          href: item.asks.volume,
        },
      };
}

function responseInput(
  band: ResponseBand,
  archetype: ArchetypeKey,
  item: PriceItemRaw,
  { t, L }: W,
): PriceInput {
  return {
    key: "response",
    ...labelled(t, "response"),
    value: rangeOf(num(band.low, 1, L), num(band.high, 1, L), L),
    basis: "ASSUMED",
    source: t("responseSource", {
      one: wholePct(1, L),
      low: bandPct(band.low, L),
      high: bandPct(band.high, L),
      kind: item.kind,
      why: t(`band.${archetype}`),
    }),
    needs: null,
  };
}

function capacityInput(item: PriceItemRaw, { t, L }: W): PriceInput | null {
  if (item.kind !== "service") return null;
  const c = item.capacity;
  const label = labelled(t, "capacity", { days: int(PRICING.horizon_days, L) });
  if (c) {
    return {
      key: "capacity",
      ...label,
      value: units(Math.max(0, c.slots - c.taken), L),
      basis: c.basis,
      source: c.source,
      needs: null,
    };
  }
  return {
    key: "capacity",
    ...label,
    value: "-",
    basis: null,
    source: t("notKnown"),
    needs: item.asks.capacity ? { what: t("capacityNeeds"), href: item.asks.capacity } : null,
  };
}

/* ── the break-even ── */

/**
 * Pure: the break-even for one change — what it can lose or must win.
 * Rests only on price, cost and volume; never on the response band.
 */
export function breakEven(
  item: PriceItemRaw,
  new_price_minor: number,
  w: SimText = englishSimText(),
): BreakEven {
  const { t, L } = wordsOf(w);
  const kind = item.kind;
  const days = int(PRICING.horizon_days, L);
  const cur = item.currency;
  if (!item.price) {
    return {
      status: "missing",
      words: t("be.needPrice", { name: item.name }),
      needs: [{ what: t("priceNeeds", { name: item.name }), href: item.asks.price }],
    };
  }
  const P = item.price.amount_minor;
  const Pn = new_price_minor;
  const cost = usableCost(item);
  const V = item.volume?.value ?? null;
  const bases = orderBases([item.price.basis, cost?.basis ?? null, item.volume?.basis ?? null]);
  const rise = Pn > P;
  const changeArgs = { dir: rise ? "rise" : "cut", share: pctWords(Math.abs((Pn - P) / P), L) };
  /** "a 10% rise", inside a sentence; "A 10% rise", opening one. */
  const changeInline = t("be.change", changeArgs);
  const changeStart = t("be.changeStart", changeArgs);
  const costNeed = { what: t("be.costNeed"), href: item.asks.unit_cost };

  if (cost) {
    const C = cost.amount_minor;
    if (P - C <= 0) {
      return {
        status: "never",
        words: t("be.neverToday", { kind, price: price(P, cur, L), cost: price(C, cur, L) }),
        formula: t("be.unitFormula", {
          kind,
          price: price(P, cur, L),
          cost: price(C, cur, L),
          margin: price(P - C, cur, L),
        }),
        bases,
      };
    }
    if (Pn - C <= 0) {
      return {
        status: "never",
        words: t("be.neverNew", {
          kind,
          price: price(Pn, cur, L),
          cost: price(C, cur, L),
          change: changeInline,
        }),
        formula: t("be.unitFormula", {
          kind,
          price: price(Pn, cur, L),
          cost: price(C, cur, L),
          margin: price(Pn - C, cur, L),
        }),
        bases,
      };
    }
  }

  // With no cost, C = 0 is the cautious end for a rise (and the least a cut must win).
  const C = cost?.amount_minor ?? 0;
  const share = Math.abs(Pn - P) / (Pn - C);
  const t_ = V === null ? null : V * share;
  const shareArgs = {
    high: price(Math.max(P, Pn), cur, L),
    low: price(Math.min(P, Pn), cur, L),
    next: price(Pn, cur, L),
    share: pct(share, L),
  };
  const shareFormula = cost
    ? t("be.shareFormula", { ...shareArgs, cost: price(C, cur, L) })
    : t("be.shareFormulaNoCost", shareArgs);
  const formula =
    t_ === null
      ? shareFormula
      : t("be.formulaOf", {
          formula: shareFormula,
          volume: units(V!, L),
          kind,
          units: num(t_, 1, L),
        });

  if (rise) {
    // "Fewer than N": losing N − 1 or fewer stays strictly ahead.
    const n = t_ === null ? null : Math.max(1, Math.ceil(t_ - 1e-9));
    const args = {
      kind,
      days,
      share: pct(share, L),
      count: n === null ? "" : num(n, 0, L),
      volume: V === null ? "" : units(V, L),
    };
    return {
      status: "lose",
      share,
      units: t_,
      floor: cost === null,
      words: cost
        ? t(n === null ? "be.loseShare" : "be.loseCount", { ...args, change: changeStart })
        : t(n === null ? "be.loseShareAnyCost" : "be.loseCountAnyCost", {
            ...args,
            change: changeInline,
          }),
      formula,
      bases,
    };
  }

  if (!cost) {
    return {
      status: "missing",
      words:
        t_ === null
          ? t("be.needCostShare", { kind, change: changeInline, share: pct(share, L) })
          : t("be.needCostCount", {
              kind,
              change: changeInline,
              count: num(Math.floor(t_ + 1e-9) + 1, 0, L),
              share: pct(share, L),
            }),
      needs: [costNeed],
    };
  }
  // "More than N": winning N + 1 or more comes out strictly ahead.
  const n = t_ === null ? null : Math.floor(t_ + 1e-9);
  const room = item.capacity ? Math.max(0, item.capacity.slots - item.capacity.taken) : null;
  const roomWords =
    room !== null && t_ !== null && t_ >= room
      ? t("be.noRoom", { room: num(room, 0, L), days })
      : null;
  const winWords =
    n === null
      ? t("be.winShare", { kind, change: changeStart, share: pct(share, L) })
      : t("be.winCount", {
          kind,
          days,
          change: changeStart,
          count: num(n, 0, L),
          volume: units(V!, L),
          share: pct(share, L),
        });
  return {
    status: "win",
    share,
    units: t_,
    floor: false,
    room,
    words: roomWords ? `${winWords} ${roomWords}` : winWords,
    formula,
    bases,
  };
}

/* ── the outcomes under the band ── */

/**
 * Pure: the volume after the change, across the band — ordered, never
 * below zero, and for a booking business never past the room in the book.
 */
export function volumeAfter(
  V: number,
  share: number,
  band: ResponseBand,
  room: number | null,
): { range: Range; capped: boolean } {
  const a = V * (1 - share * band.low);
  const b = V * (1 - share * band.high);
  let r = range(Math.max(0, a), Math.max(0, b));
  let capped = false;
  if (room !== null && r.high > V + room) {
    capped = true;
    r = { low: Math.min(r.low, V + room), high: V + room };
  }
  return { range: r, capped };
}

const missingCell = (needs: string[]): Cell => ({ status: "missing", needs });

/**
 * Pure: one change against one item, in `w`'s words (English by default).
 * Throws a SimulateError on a change out of bounds.
 */
export function simulatePrice(
  item: PriceItemRaw,
  change: PriceChange,
  archetype: ArchetypeKey,
  w: SimText = englishSimText(),
): PriceResult {
  const words = wordsOf(w);
  const { t, L } = words;
  if (!item.price) {
    throw new SimulateError(t("noPrice", { name: item.name }));
  }
  const err = changeError(item.price.amount_minor, change, w);
  if (err) throw new SimulateError(err);
  const cur = item.currency;
  const P = item.price.amount_minor;
  const Pn = newPriceOf(P, change);
  const s = (Pn - P) / P;
  const band = RESPONSE_BANDS[archetype];
  const cost = usableCost(item);
  const V = item.volume?.value ?? null;
  const kind = item.kind;
  const days = int(PRICING.horizon_days, L);
  const room = item.capacity ? Math.max(0, item.capacity.slots - item.capacity.taken) : null;

  const inputs: PriceInput[] = [
    priceInput(item, words),
    costInput(item, words),
    volumeInput(item, words),
  ];
  const cap = capacityInput(item, words);
  if (cap) inputs.push(cap);
  inputs.push(responseInput(band, archetype, item, words));

  const needs = (keys: PriceInput["key"][]) =>
    inputs
      .filter((i) => keys.includes(i.key) && i.needs !== null && i.value === "-")
      .map((i) => t("needLine", { label: i.label_inline, needs: i.needs!.what }));

  const factBases = orderBases([item.price.basis, item.volume?.basis ?? null]);
  const allBases = orderBases([
    item.price.basis,
    cost?.basis ?? null,
    item.volume?.basis ?? null,
    "ASSUMED",
  ]);

  const measures: Record<PriceMeasure, Cell> = {
    volume: missingCell(needs(["volume"])),
    revenue: missingCell(needs(["volume"])),
    profit: missingCell(needs(["volume", "unit_cost"])),
    worst: missingCell(needs(["volume", "unit_cost"])),
  };
  let worstWords = t("worstUnknown");

  if (V !== null) {
    const after = volumeAfter(V, s, band, room);
    const vr = after.range;
    const bandTerm = rangeOf(num(band.low, 1, L), num(band.high, 1, L), L);
    measures.volume = {
      status: "range",
      range: { low: Math.round(vr.low), high: Math.round(vr.high) },
      bases: orderBases([...factBases, "ASSUMED"]),
      formula: t("formula.volume", {
        volume: units(V, L),
        kind,
        one: num(1, 0, L),
        sign: s > 0 ? "−" : "+",
        share: pct(Math.abs(s), L),
        band: bandTerm,
        held: after.capped ? "yes" : "no",
        room: room === null ? "" : num(room, 0, L),
      }),
      exact: false,
    };
    const between = {
      low: units(Math.round(vr.low), L),
      high: units(Math.round(vr.high), L),
      volume: units(V, L),
      next: price(Pn, cur, L),
      price: price(P, cur, L),
    };
    const rev = roundRange(range(vr.low * Pn - V * P, vr.high * Pn - V * P));
    measures.revenue = {
      status: "range",
      range: rev,
      bases: orderBases([...factBases, "ASSUMED"]),
      formula: t("formula.revenue", { ...between, kind }),
      exact: false,
    };
    if (cost) {
      const C = cost.amount_minor;
      const today = V * (P - C);
      const at = (v: number) => v * (Pn - C) - today;
      const profit = roundRange(range(at(vr.low), at(vr.high)));
      measures.profit = {
        status: "range",
        range: profit,
        bases: allBases,
        formula: t("formula.profit", { ...between, cost: price(C, cur, L) }),
        exact: false,
      };
      // The worst end of the band: fewest sales while each one still earns, most when it loses.
      const worstV = Pn - C >= 0 ? vr.low : vr.high;
      const end = s > 0 === (worstV === vr.low) ? "strong" : "gentle";
      const worst = Math.round(at(worstV));
      measures.worst = {
        status: "range",
        range: { low: worst, high: worst },
        bases: allBases,
        formula: t("formula.worst", {
          ...between,
          units: units(Math.round(worstV), L),
          cost: price(C, cur, L),
        }),
        exact: true,
      };
      const moved = Math.abs(worstV - V) / V;
      worstWords = t("worstWords", {
        end,
        kind,
        days,
        dir: worstV < V ? "fall" : "rise",
        share: pct(moved, L),
        units: units(Math.round(worstV), L),
        name: item.name,
        amount: signedMoney(worst, cur, L),
      });
    }
  }

  const assumptions = [{ statement: t("assumeBand"), source: t("bandSource") }];
  if (item.kind === "service" && item.capacity === null && s < 0) {
    assumptions.push({ statement: t("assumeFits"), source: t("assumeFitsSource") });
  }

  return {
    key: changeKey(change),
    change,
    title: changeTitle(P, change, cur, w),
    currency: cur,
    old_price_minor: P,
    new_price_minor: Pn,
    share: s,
    inputs,
    assumptions,
    breakeven: breakEven(item, Pn, w),
    measures,
    worst_words: worstWords,
  };
}

/** Money in whole major units with its sign: "+€417", "−€742". */
export function signedMoney(minor: number, currency: string, locale: AppLocale = "en"): string {
  const exp = minorUnitExponent(currency);
  const whole = Math.round(minor / 10 ** exp);
  const body = moneyText(Math.abs(whole) * 10 ** exp, currency, locale);
  return whole > 0 ? `+${body}` : whole < 0 ? `−${body}` : body;
}

export interface PriceComparison {
  item: PriceItemRaw;
  results: PriceResult[];
  /** The changes that couldn't be simulated, with why. */
  refused: { change: PriceChange; why: string }[];
}

/** Pure: up to four changes for one item, side by side, cheapest first. Duplicates collapse. */
export function comparePrices(
  item: PriceItemRaw,
  changes: readonly PriceChange[],
  archetype: ArchetypeKey,
  w: SimText = englishSimText(),
): PriceComparison {
  if (changes.length > PRICING.max_changes) {
    throw new SimulateError(
      `pick up to ${PRICING.max_changes} price changes to compare: ${changes.length} given`,
    );
  }
  const { t } = wordsOf(w);
  const results: PriceResult[] = [];
  const refused: PriceComparison["refused"] = [];
  const seen = new Set<number>();
  for (const c of changes) {
    if (!item.price) {
      refused.push({ change: c, why: t("noPrice", { name: item.name }) });
      continue;
    }
    const err = changeError(item.price.amount_minor, c, w);
    if (err) {
      refused.push({ change: c, why: err });
      continue;
    }
    const next = newPriceOf(item.price.amount_minor, c);
    if (seen.has(next)) continue;
    seen.add(next);
    results.push(simulatePrice(item, c, archetype, w));
  }
  // Cheapest first, so the columns read as a price scale.
  results.sort((a, b) => a.new_price_minor - b.new_price_minor);
  return { item, results, refused };
}

/** Pure: the screen's headline for an item — the first rise's break-even, or the first change's. */
export function pricingHeadline(cmp: PriceComparison, w: SimText = englishSimText()): string {
  const { t } = wordsOf(w);
  const first =
    cmp.results.find((r) => r.share > 0 && r.breakeven.status === "lose") ?? cmp.results[0];
  if (!first) {
    return cmp.item.price
      ? t("headPick", { name: cmp.item.name })
      : t("headNoPrice", { name: cmp.item.name });
  }
  return first.breakeven.words;
}
