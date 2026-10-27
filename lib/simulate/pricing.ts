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

import type { Basis } from "../../components/report/basis";
import { moneyText, num } from "../../components/sheet/num";
import type { ArchetypeKey } from "../charts/profiles";
import { minorUnitExponent } from "../core/money";
import type { Cell, Range } from "./model";
import { SIM, SimulateError, orderBases, range, roundRange } from "./model";
import type { ResponseBand } from "./pricing-bands";
import { BAND_SOURCE, RESPONSE_BANDS } from "./pricing-bands";

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

/* ── a change ── */

export type PriceChange = { kind: "share"; share: number } | { kind: "exact"; price_minor: number };

/** A stable id for a change. */
export function changeKey(c: PriceChange): string {
  return c.kind === "share" ? `share:${Math.round(c.share * 1000)}` : `exact:${c.price_minor}`;
}

/** Pure: the new price in integer minor units, rounded once. */
export function newPriceOf(price_minor: number, c: PriceChange): number {
  return c.kind === "exact" ? c.price_minor : Math.round(price_minor * (1 + c.share));
}

/**
 * Pure: why a change can't be simulated against this price, or null.
 * The bounds apply to the change as it lands on the price, so an exact
 * price is held to the same limits as a step.
 */
export function changeError(price_minor: number, c: PriceChange): string | null {
  if (c.kind === "exact" && !(Number.isSafeInteger(c.price_minor) && c.price_minor > 0)) {
    return "a new price has to be above zero";
  }
  if (c.kind === "share" && !Number.isFinite(c.share)) return "that isn't a price change";
  const next = newPriceOf(price_minor, c);
  if (next <= 0) return "a new price has to be above zero";
  const s = (next - price_minor) / price_minor;
  if (Math.abs(s) < PRICING.min_change_share - 1e-9) {
    return `that's less than a ${PRICING.min_change_share * 100}% change — too small to simulate`;
  }
  if (Math.abs(s) > PRICING.max_change_share + 1e-9) {
    return `I simulate changes up to ${PRICING.max_change_share * 100}% either way; past that the response band is no fair guide`;
  }
  return null;
}

/* ── the results ── */

/** One input: a value with its basis and source, or a gap with where it's asked. */
export interface PriceInput {
  key: "price" | "unit_cost" | "volume" | "response" | "capacity";
  label: string;
  /** What the screen prints in the value column; "—" when missing. */
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
const price = (minor: number, currency: string) => moneyText(minor, currency);
const pct = (x: number, d = 1) => `${num(x * 100, d)}%`;
/** A share in words at the fewest decimals that say it: "10%", "12.5%". */
const pctWords = (x: number) => {
  const v = Math.round(x * 1000) / 10;
  return `${num(v, Number.isInteger(v) ? 0 : 1)}%`;
};
const signedPct = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${pctWords(Math.abs(x))}`;
const units = (x: number) => (Number.isInteger(x) ? num(x, 0) : num(x, 1));

/** What one unit is called, by the kind of item. */
export function unitNoun(item: Pick<PriceItemRaw, "kind">, many = true): string {
  return item.kind === "service" ? (many ? "bookings" : "booking") : many ? "sales" : "sale";
}

/** The period a volume covers, in words. */
export function periodWords(item: Pick<PriceItemRaw, "kind">): string {
  return item.kind === "service" ? `every ${PRICING.horizon_days} days` : "a month";
}

/** Pure: a change's short title. */
export function changeTitle(old_minor: number, c: PriceChange, currency: string): string {
  const next = newPriceOf(old_minor, c);
  if (c.kind === "share") return `${signedPct(c.share)} → ${price(next, currency)}`;
  return `${price(next, currency)} (${signedPct((next - old_minor) / old_minor)})`;
}

/* ── the inputs, with their gaps ── */

function priceInput(item: PriceItemRaw): PriceInput {
  return item.price
    ? {
        key: "price",
        label: "Price now",
        value: price(item.price.amount_minor, item.currency),
        basis: item.price.basis,
        source: item.price.source,
        needs: null,
      }
    : {
        key: "price",
        label: "Price now",
        value: "—",
        basis: null,
        source: "not known",
        needs: { what: `the price of ${item.name}`, href: item.asks.price },
      };
}

/** A cost in another currency is no cost to this item: it is never converted. */
function usableCost(item: PriceItemRaw): MoneyFact | null {
  const c = item.unit_cost;
  return c && c.currency.toUpperCase() === item.currency.toUpperCase() ? c : null;
}

function costInput(item: PriceItemRaw): PriceInput {
  const c = item.unit_cost;
  const ok = usableCost(item);
  if (ok) {
    return {
      key: "unit_cost",
      label: "Cost to deliver one",
      value: price(ok.amount_minor, item.currency),
      basis: ok.basis,
      source: ok.source,
      needs: null,
    };
  }
  return {
    key: "unit_cost",
    label: "Cost to deliver one",
    value: "—",
    basis: null,
    source: c
      ? `recorded in ${c.currency}, the price is in ${item.currency} — I don't convert between currencies`
      : "not known",
    needs: {
      what:
        item.kind === "service"
          ? `what one ${item.name} costs you to deliver — list "${item.name}" among what you sell, with its cost, and I'll match it to your bookings`
          : `what one ${item.name} costs you to deliver${c ? ` in ${item.currency}` : ""}`,
      href: item.asks.unit_cost,
    },
  };
}

function volumeInput(item: PriceItemRaw): PriceInput {
  const label = `${item.kind === "service" ? "Bookings" : "Sales"} ${periodWords(item)}`;
  return item.volume
    ? {
        key: "volume",
        label,
        value: units(item.volume.value),
        basis: item.volume.basis,
        source: item.volume.source,
        needs: null,
      }
    : {
        key: "volume",
        label,
        value: "—",
        basis: null,
        source: "not known",
        needs: {
          what:
            item.kind === "service"
              ? `your bookings with ${item.name}, imported or connected`
              : `roughly how many ${item.name} you sell a month`,
          href: item.asks.volume,
        },
      };
}

function responseInput(band: ResponseBand, noun: string): PriceInput {
  return {
    key: "response",
    label: "How customers answer the price",
    value: `${num(band.low, 1)} – ${num(band.high, 1)}`,
    basis: "ASSUMED",
    source: `for each 1% on the price, ${num(band.low, 1)}% to ${num(band.high, 1)}% of ${noun} move the other way — ${band.why}`,
    needs: null,
  };
}

function capacityInput(item: PriceItemRaw): PriceInput | null {
  if (item.kind !== "service") return null;
  const c = item.capacity;
  if (c) {
    return {
      key: "capacity",
      label: `Room in the book, ${PRICING.horizon_days} days`,
      value: units(Math.max(0, c.slots - c.taken)),
      basis: c.basis,
      source: c.source,
      needs: null,
    };
  }
  return {
    key: "capacity",
    label: `Room in the book, ${PRICING.horizon_days} days`,
    value: "—",
    basis: null,
    source: "not known",
    needs: item.asks.capacity
      ? {
          what: "how many appointments you can take a week — then a cut is held to the room you have",
          href: item.asks.capacity,
        }
      : null,
  };
}

/* ── the break-even ── */

/**
 * Pure: the break-even for one change — what it can lose or must win.
 * Rests only on price, cost and volume; never on the response band.
 */
export function breakEven(item: PriceItemRaw, new_price_minor: number): BreakEven {
  const noun = unitNoun(item);
  const cur = item.currency;
  if (!item.price) {
    return {
      status: "missing",
      words: `I need the price of ${item.name} first.`,
      needs: [{ what: `the price of ${item.name}`, href: item.asks.price }],
    };
  }
  const P = item.price.amount_minor;
  const Pn = new_price_minor;
  const cost = usableCost(item);
  const V = item.volume?.value ?? null;
  const ofYours =
    V === null ? `of your ${noun}` : `of your ~${units(V)} ${noun} ${periodWords(item)}`;
  const bases = orderBases([item.price.basis, cost?.basis ?? null, item.volume?.basis ?? null]);
  const rise = Pn > P;
  const changeWords = `a ${pctWords(Math.abs((Pn - P) / P))} ${rise ? "rise" : "cut"}`;
  const costNeed = {
    what: `what one costs you to deliver`,
    href: item.asks.unit_cost,
  };

  if (cost) {
    const C = cost.amount_minor;
    if (P - C <= 0) {
      return {
        status: "never",
        words: `At today's ${price(P, cur)} each ${unitNoun(item, false)} already costs you ${price(C, cur)} to deliver, so there is no profit on it today to break even against — look at the cost before the price.`,
        formula: `${price(P, cur)} − ${price(C, cur)} = ${price(P - C, cur)} a ${unitNoun(item, false)}`,
        bases,
      };
    }
    if (Pn - C <= 0) {
      return {
        status: "never",
        words: `At ${price(Pn, cur)} each ${unitNoun(item, false)} would cost you ${price(C, cur)} to deliver — every extra one loses money, so no amount of extra ${noun} makes ${changeWords} pay.`,
        formula: `${price(Pn, cur)} − ${price(C, cur)} = ${price(Pn - C, cur)} a ${unitNoun(item, false)}`,
        bases,
      };
    }
  }

  // With no cost, C = 0 is the cautious end for a rise (and the least a cut must win).
  const C = cost?.amount_minor ?? 0;
  const share = Math.abs(Pn - P) / (Pn - C);
  const t = V === null ? null : V * share;
  const shareFormula = cost
    ? `(${price(Math.max(P, Pn), cur)} − ${price(Math.min(P, Pn), cur)}) ÷ (${price(Pn, cur)} − ${price(C, cur)}) = ${pct(share)}`
    : `(${price(Math.max(P, Pn), cur)} − ${price(Math.min(P, Pn), cur)}) ÷ ${price(Pn, cur)} = ${pct(share)} — with no cost to deliver counted`;
  const formula =
    t === null ? shareFormula : `${shareFormula} of ${units(V!)} ${noun} = ${num(t, 1)}`;

  if (rise) {
    // "Fewer than N": losing N − 1 or fewer stays strictly ahead.
    const n = t === null ? null : Math.max(1, Math.ceil(t - 1e-9));
    const body =
      n === null
        ? `fewer than ${pct(share)} of your ${noun}`
        : `fewer than ${num(n, 0)} ${ofYours} (${pct(share)})`;
    return {
      status: "lose",
      share,
      units: t,
      floor: cost === null,
      words: cost
        ? `${sentence(changeWords)} pays as long as you lose ${body}.`
        : `Whatever each one costs you, ${changeWords} pays as long as you lose ${body}.`,
      formula,
      bases,
    };
  }

  if (!cost) {
    return {
      status: "missing",
      words: `To say how many more ${noun} ${changeWords} needs, I need what one costs you to deliver. With no cost counted it needs at least ${t === null ? pct(share) : `${num(Math.floor(t + 1e-9) + 1, 0)} more (${pct(share)})`} — the true figure is higher.`,
      needs: [costNeed],
    };
  }
  // "More than N": winning N + 1 or more comes out strictly ahead.
  const n = t === null ? null : Math.floor(t + 1e-9);
  const room = item.capacity ? Math.max(0, item.capacity.slots - item.capacity.taken) : null;
  const roomWords =
    room !== null && t !== null && t >= room
      ? ` Your book has room for ${num(room, 0)} more in ${PRICING.horizon_days} days, so it can't pay from extra bookings alone.`
      : "";
  return {
    status: "win",
    share,
    units: t,
    floor: false,
    room,
    words:
      n === null
        ? `${sentence(changeWords)} pays only if you win more than ${pct(share)} more ${noun}.${roomWords}`
        : `${sentence(changeWords)} pays only if you win more than ${num(n, 0)} extra ${noun} on your ~${units(V!)} ${periodWords(item)} (+${pct(share)}).${roomWords}`,
    formula,
    bases,
  };
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

/** Pure: one change against one item. Throws a SimulateError on a change out of bounds. */
export function simulatePrice(
  item: PriceItemRaw,
  change: PriceChange,
  archetype: ArchetypeKey,
): PriceResult {
  if (!item.price) {
    throw new SimulateError(`${item.name} has no price on your profile yet`);
  }
  const err = changeError(item.price.amount_minor, change);
  if (err) throw new SimulateError(err);
  const cur = item.currency;
  const P = item.price.amount_minor;
  const Pn = newPriceOf(P, change);
  const s = (Pn - P) / P;
  const band = RESPONSE_BANDS[archetype];
  const cost = usableCost(item);
  const V = item.volume?.value ?? null;
  const noun = unitNoun(item);
  const room = item.capacity ? Math.max(0, item.capacity.slots - item.capacity.taken) : null;

  const inputs: PriceInput[] = [priceInput(item), costInput(item), volumeInput(item)];
  const cap = capacityInput(item);
  if (cap) inputs.push(cap);
  inputs.push(responseInput(band, noun));

  const needs = (keys: PriceInput["key"][]) =>
    inputs
      .filter((i) => keys.includes(i.key) && i.needs !== null && i.value === "—")
      .map((i) => `${i.label.toLowerCase()}: ${i.needs!.what}`);

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
  let worstWords = "I can't size the worst case without the inputs above.";

  if (V !== null) {
    const after = volumeAfter(V, s, band, room);
    const vr = after.range;
    const bandTerm = `${num(band.low, 1)} – ${num(band.high, 1)}`;
    measures.volume = {
      status: "range",
      range: { low: Math.round(vr.low), high: Math.round(vr.high) },
      bases: orderBases([...factBases, "ASSUMED"]),
      formula: `${units(V)} ${noun} × (1 ${s > 0 ? "−" : "+"} ${pct(Math.abs(s))} × ${bandTerm})${after.capped ? `, held to the ${num(room!, 0)} more your book has room for` : ""}`,
      exact: false,
    };
    const rev = roundRange(range(vr.low * Pn - V * P, vr.high * Pn - V * P));
    measures.revenue = {
      status: "range",
      range: rev,
      bases: orderBases([...factBases, "ASSUMED"]),
      formula: `${units(Math.round(vr.low))} – ${units(Math.round(vr.high))} ${noun} × ${price(Pn, cur)} − ${units(V)} × ${price(P, cur)}`,
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
        formula: `${units(Math.round(vr.low))} – ${units(Math.round(vr.high))} × (${price(Pn, cur)} − ${price(C, cur)}) − ${units(V)} × (${price(P, cur)} − ${price(C, cur)})`,
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
        formula: `${units(Math.round(worstV))} × (${price(Pn, cur)} − ${price(C, cur)}) − ${units(V)} × (${price(P, cur)} − ${price(C, cur)})`,
        exact: true,
      };
      const moved = Math.abs(worstV - V) / V;
      worstWords = `Customers answer at the ${end} end of the band: ${noun} ${worstV < V ? "fall" : "rise"} ${pct(moved)} to about ${units(Math.round(worstV))}, and profit on ${item.name} moves ${signedMoney(worst, cur)} ${periodWords(item)}.`;
    }
  }

  const assumptions = [
    {
      statement:
        "Customers answer this change as the band says, for a rise or a cut alike, and nothing else changes in the meantime.",
      source: BAND_SOURCE,
    },
  ];
  if (item.kind === "service" && item.capacity === null && s < 0) {
    assumptions.push({
      statement: "Extra bookings fit in the book.",
      source:
        "you haven't told me your weekly capacity, so I can't hold the gain to the room you have",
    });
  }

  return {
    key: changeKey(change),
    change,
    title: changeTitle(P, change, cur),
    currency: cur,
    old_price_minor: P,
    new_price_minor: Pn,
    share: s,
    inputs,
    assumptions,
    breakeven: breakEven(item, Pn),
    measures,
    worst_words: worstWords,
  };
}

/** Money in whole major units with its sign: "+€417", "−€742". */
export function signedMoney(minor: number, currency: string): string {
  const exp = minorUnitExponent(currency);
  const whole = Math.round(minor / 10 ** exp);
  const body = moneyText(Math.abs(whole) * 10 ** exp, currency);
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
): PriceComparison {
  if (changes.length > PRICING.max_changes) {
    throw new SimulateError(
      `pick up to ${PRICING.max_changes} price changes to compare — ${changes.length} given`,
    );
  }
  const results: PriceResult[] = [];
  const refused: PriceComparison["refused"] = [];
  const seen = new Set<number>();
  for (const c of changes) {
    if (!item.price) {
      refused.push({ change: c, why: `${item.name} has no price on your profile yet` });
      continue;
    }
    const err = changeError(item.price.amount_minor, c);
    if (err) {
      refused.push({ change: c, why: err });
      continue;
    }
    const next = newPriceOf(item.price.amount_minor, c);
    if (seen.has(next)) continue;
    seen.add(next);
    results.push(simulatePrice(item, c, archetype));
  }
  // Cheapest first, so the columns read as a price scale.
  results.sort((a, b) => a.new_price_minor - b.new_price_minor);
  return { item, results, refused };
}

/** Pure: the screen's headline for an item — the first rise's break-even, or the first change's. */
export function pricingHeadline(cmp: PriceComparison): string {
  const first =
    cmp.results.find((r) => r.share > 0 && r.breakeven.status === "lose") ?? cmp.results[0];
  if (!first) {
    return cmp.item.price
      ? `Pick a price change for ${cmp.item.name} to see what it can lose and still pay.`
      : `${cmp.item.name} has no price on your profile yet.`;
  }
  return first.breakeven.words;
}
