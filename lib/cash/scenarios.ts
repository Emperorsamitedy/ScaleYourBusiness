// Cash scenarios, side by side — Phase 5 Session B (P5-09). Pure.
//
// In the campaign simulator's pattern (lib/simulate): a handful of "what
// if"s, each run through the SAME 13-week forecast as the plain one, each a
// low–high range, set side by side with the plain forecast. Four kinds:
//
//   slow month   sales x% lower for four weeks from week n (both ends)
//   big order    +amount in week n, paid in full that week; its per-sale
//                costs go out the same week, at the forecast's own share
//   hire         +amount a month from week n, on each 1st like any
//                monthly cost
//   price        a change from what-if pricing (lib/simulate/pricing): its
//                monthly profit change, low to high under the stated
//                customer-response band, spread over the weeks from now
//
// The default sizes come from the business's own numbers — a typical week
// of its sales as the big order, its largest stated salary as the hire,
// what-if pricing's first step on its first priced offer — and the owner
// can change every one. A scenario without the figure it needs says what
// would fill it rather than inventing one. Nothing here acts on any of it:
// a scenario is arithmetic for the owner to read (rule 26).
//
// L-4b: each scenario's title, change, assumptions and why come from the
// "cashWords" catalogue through optional words, English by default. What
// what-if pricing hands over (its change title, its band's source) is
// lib/simulate's own wording, carried as given.

import type { Range } from "./model";
import type { Adjust, CashInputs, CashReady, Need } from "./model";
import { CASH, firsts, forecastCash, wholeMoney } from "./model";
import type { Words } from "./words";
import { cashEnglish, wholePct } from "./words";
import { shortDate } from "../charts/model";
import { enumCode } from "../core/enum-value";
import { minorUnitExponent } from "../core/money";
import type { PriceItemRaw, PriceResult } from "../simulate/pricing";
import { PRICING } from "../simulate/pricing";
import { BAND_SOURCE } from "../simulate/pricing-bands";
import type { SimText } from "../simulate/words";
import { CASH_ASK } from "./keys";
import type { TightWeek } from "./warnings";
import { tightWeek } from "./warnings";

/** The pinned bounds — one place, boundary-tested (scenarios.test.ts). */
export const SCENARIO = {
  /** A slow month is four weeks. */
  slow_weeks: 4,
  /** What the screen opens on, and the bounds an owner's figure is held to. */
  slow_share: 0.2,
  min_slow_share: 0.05,
  max_slow_share: 0.6,
  /** The big order opens on week 5 (index 4). */
  order_week: 4,
  /** Owner-entered amounts are held under this many major units. */
  max_major: 10_000_000,
} as const;

export const SCENARIO_KINDS = ["slow_month", "big_order", "hire", "price"] as const;
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

/** What what-if pricing hands over: a price change's profit effect a week, as a range. */
export interface PriceEffect {
  /** "+5% → €35.70 on Speckled mug". */
  title: string;
  /** Profit change a week, low to high, integer minor units. */
  weekly: Range;
  currency: string;
  /** Where it came from, in words: the band's source. */
  source: string;
}

/**
 * Pure: what-if pricing's result as a weekly profit effect. An offer's
 * figures are a month (× 12 ÷ 52 a week); a booked service's are its last
 * 28 days (÷ 4). No profit range (no cost, no volume): nothing to run.
 */
export function priceEffect(
  r: PriceResult,
  item: Pick<PriceItemRaw, "kind" | "name">,
  words: Words = cashEnglish(),
  /** What-if pricing's own words, for its band's source; English (BAND_SOURCE) without. */
  sim?: SimText,
): PriceEffect | null {
  const p = r.measures.profit;
  if (p.status !== "range") return null;
  const perWeek = item.kind === "service" ? 7 / PRICING.horizon_days : 12 / 52;
  return {
    title: words.tr("scenario.price.effect", { change: r.title, name: item.name }),
    weekly: { low: Math.round(p.range.low * perWeek), high: Math.round(p.range.high * perWeek) },
    currency: r.currency,
    source: sim ? sim.tr("pricing.bandSource") : BAND_SOURCE,
  };
}

export type Scenario =
  | { kind: "slow_month"; share: number; start_week: number }
  | { kind: "big_order"; amount_minor: number; week: number }
  | { kind: "hire"; monthly_minor: number; from_week: number }
  | { kind: "price"; effect: PriceEffect };

export interface ScenarioResult {
  kind: ScenarioKind;
  title: string;
  /** What changes, in one line. */
  change: string;
  forecast: CashReady;
  lowest: CashReady["lowest"];
  end: Range;
  /** End of week 13 against the plain forecast's. */
  vs_plain: Range;
  tight: TightWeek | null;
  /** What this scenario assumes on top of the forecast's own. */
  assumptions: string[];
}

export type ScenarioCell =
  | { status: "ready"; result: ScenarioResult }
  | { status: "missing"; kind: ScenarioKind; title: string; why: string; needs: Need[] };

/** The week a scenario starts in, as the catalogue's `when` select and its day. */
const weekArgs = (f: CashReady, k: number, words: Words) => ({
  when: k === 0 ? "now" : "later",
  day: shortDate(f.weeks[k]!.start, words.locale),
});
const clampWeek = (k: number) =>
  Math.max(0, Math.min(CASH.horizon_weeks - 1, Math.floor(Number.isFinite(k) ? k : 0)));

/** Pure: the adjustment one scenario makes to the forecast. */
export function adjustFor(s: Scenario, plain: CashReady): Adjust {
  const n = CASH.horizon_weeks;
  switch (s.kind) {
    case "slow_month": {
      const from = clampWeek(s.start_week);
      return {
        sales_factor: Array.from({ length: n }, (_, k) =>
          k >= from && k < from + SCENARIO.slow_weeks ? 1 - s.share : 1,
        ),
      };
    }
    case "big_order": {
      const k = clampWeek(s.week);
      const extra_in = new Array<number>(n).fill(0);
      const extra_out = new Array<number>(n).fill(0);
      extra_in[k] = s.amount_minor;
      extra_out[k] = Math.round(s.amount_minor * plain.variable.ratio);
      return { extra_in, extra_out };
    }
    case "hire": {
      const from = plain.weeks[clampWeek(s.from_week)]!.start;
      const extra_out = new Array<number>(n).fill(0);
      for (const day of firsts(from, (n - clampWeek(s.from_week)) * 7)) {
        const k = plain.weeks.findIndex((w) => day >= w.start && day <= w.end);
        if (k >= 0) extra_out[k]! += s.monthly_minor;
      }
      return { extra_out };
    }
    case "price":
      return { extra_net: Array.from({ length: n }, () => ({ ...s.effect.weekly })) };
  }
}

function describe(
  s: Scenario,
  plain: CashReady,
  words: Words,
): { title: string; change: string; assumptions: string[] } {
  const { tr, locale } = words;
  const cur = plain.currency;
  const whole = (minor: number) => wholeMoney(minor, cur, locale);
  switch (s.kind) {
    case "slow_month": {
      const share = wholePct(s.share, locale);
      return {
        title: tr("scenario.slow.title", { share }),
        change: tr("scenario.slow.change", {
          share,
          weeks: SCENARIO.slow_weeks,
          ...weekArgs(plain, clampWeek(s.start_week), words),
        }),
        assumptions: [tr("scenario.slow.assumption")],
      };
    }
    case "big_order":
      return {
        title: tr("scenario.order.title", { amount: whole(s.amount_minor) }),
        change: tr("scenario.order.change", {
          amount: whole(s.amount_minor),
          ...weekArgs(plain, clampWeek(s.week), words),
        }),
        assumptions: [tr("scenario.order.assumption")],
      };
    case "hire":
      return {
        title: tr("scenario.hire.title", { amount: whole(s.monthly_minor) }),
        change: tr("scenario.hire.change", {
          amount: whole(s.monthly_minor),
          first: 1,
          ...weekArgs(plain, clampWeek(s.from_week), words),
        }),
        assumptions: [tr("scenario.hire.assumption", { weeks: CASH.horizon_weeks })],
      };
    case "price":
      return {
        title: tr("scenario.price.title", { change: s.effect.title }),
        change: tr("scenario.price.change", {
          low: signed(s.effect.weekly.low, cur, words),
          high: signed(s.effect.weekly.high, cur, words),
        }),
        assumptions: [tr("scenario.price.assumption", { source: s.effect.source })],
      };
  }
}

function signed(minor: number, cur: string, words: Words): string {
  const w = wholeMoney(minor, cur, words.locale);
  return minor > 0 ? `+${w}` : w;
}

/** Pure: one scenario through the forecast, against the plain one. */
export function runScenario(
  inputs: CashInputs,
  plain: CashReady,
  s: Scenario,
  words: Words = cashEnglish(),
): ScenarioResult {
  const f = forecastCash(inputs, adjustFor(s, plain), words);
  if (f.status !== "ready") throw new Error("a scenario runs only on a forecast that is ready");
  const d = describe(s, plain, words);
  return {
    kind: s.kind,
    title: d.title,
    change: d.change,
    forecast: f,
    lowest: f.lowest,
    end: f.end,
    vs_plain: { low: f.end.low - plain.end.low, high: f.end.high - plain.end.high },
    tight: tightWeek(f, words),
    assumptions: d.assumptions,
  };
}

/** The scenario figures the owner set (or the screen's defaults), already bounded. */
export interface ScenarioChoice {
  slow_share: number;
  slow_week: number;
  order_minor: number | null;
  order_week: number;
  hire_minor: number | null;
  hire_week: number;
}

/** Pure: the default sizes, from the business's own numbers. */
export function defaultChoice(inputs: CashInputs, plain: CashReady): ScenarioChoice {
  const unit = 10 ** minorUnitExponent(plain.currency);
  // A typical week of sales, rounded to a hundred major units.
  const week = plain.pattern.median_week;
  const order = week > 0 ? Math.max(1, Math.round(week / (100 * unit))) * 100 * unit : null;
  // The largest monthly salary the owner stated, in the cash's currency.
  const salaries = inputs.costs
    .filter(
      (c) =>
        enumCode(c.category) === "salaries" &&
        enumCode(c.cadence) === "monthly" &&
        c.amount !== null &&
        c.amount.currency === plain.currency,
    )
    .map((c) => c.amount!.amount_minor);
  return {
    slow_share: SCENARIO.slow_share,
    slow_week: 0,
    order_minor: order,
    order_week: SCENARIO.order_week,
    hire_minor: salaries.length > 0 ? Math.max(...salaries) : null,
    hire_week: 0,
  };
}

/** Pure: an owner's figures from the query string, held to the bounds; anything else is the default. */
export function parseChoice(
  q: Readonly<Record<string, string | undefined>>,
  defaults: ScenarioChoice,
  currencyExponent: number,
): ScenarioChoice {
  const intIn = (v: string | undefined, lo: number, hi: number): number | null => {
    if (v === undefined || v.trim() === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
  };
  const major = (v: string | undefined): number | null => {
    if (v === undefined || v.trim() === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > SCENARIO.max_major) return null;
    return Math.round(n * 10 ** currencyExponent);
  };
  const share = intIn(q.slow, SCENARIO.min_slow_share * 100, SCENARIO.max_slow_share * 100);
  const last = CASH.horizon_weeks - 1;
  return {
    slow_share: share === null ? defaults.slow_share : share / 100,
    slow_week: intIn(q.slow_week, 0, last) ?? defaults.slow_week,
    order_minor: major(q.order) ?? defaults.order_minor,
    order_week: intIn(q.order_week, 0, last) ?? defaults.order_week,
    hire_minor: major(q.hire) ?? defaults.hire_minor,
    hire_week: intIn(q.hire_week, 0, last) ?? defaults.hire_week,
  };
}

/**
 * Pure: the four scenarios side by side. A missing figure is a missing
 * cell with what fills it — the hire with no salary stated, the price
 * change with nothing priced — never a made-up number.
 */
export function compareScenarios(
  inputs: CashInputs,
  plain: CashReady,
  choice: ScenarioChoice,
  price: PriceEffect | null,
  words: Words = cashEnglish(),
): ScenarioCell[] {
  const { tr } = words;
  const cells: ScenarioCell[] = [];
  const run = (s: Scenario): ScenarioCell => ({
    status: "ready",
    result: runScenario(inputs, plain, s, words),
  });
  cells.push(run({ kind: "slow_month", share: choice.slow_share, start_week: choice.slow_week }));
  cells.push(
    choice.order_minor !== null
      ? run({ kind: "big_order", amount_minor: choice.order_minor, week: choice.order_week })
      : {
          status: "missing",
          kind: "big_order",
          title: tr("scenario.order.titleMissing"),
          why: tr("scenario.order.why"),
          needs: [],
        },
  );
  cells.push(
    choice.hire_minor !== null
      ? run({ kind: "hire", monthly_minor: choice.hire_minor, from_week: choice.hire_week })
      : {
          status: "missing",
          kind: "hire",
          title: tr("scenario.hire.titleMissing"),
          why: tr("scenario.hire.why"),
          needs: [{ what: tr("scenario.hire.need"), href: CASH_ASK.costs }],
        },
  );
  cells.push(
    price !== null && price.currency === plain.currency
      ? run({ kind: "price", effect: price })
      : {
          status: "missing",
          kind: "price",
          title: tr("scenario.price.titleMissing"),
          why:
            price !== null
              ? tr("scenario.price.whyCurrency", { pricing: price.currency, cash: plain.currency })
              : tr("scenario.price.whyNothing"),
          needs: [{ what: tr("scenario.price.need"), href: CASH_ASK.offers }],
        },
  );
  return cells;
}
