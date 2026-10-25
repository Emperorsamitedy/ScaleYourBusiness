// Opportunity cost — the money left on the table, priced honestly. Pure:
// no database, no clock, no model (CLAUDE.md: arithmetic is never
// inference). The loader (./load) reads the inputs; this file only adds
// and multiplies, and says how.
//
// Every component carries:
//   · its basis word (components/report/basis.ts) — DERIVED for what is
//     worked out from measured series, ESTIMATED for the proposals' own
//     forecasts, OBSERVED for a stock figure read from the store;
//   · derived_from and a formula with the real numbers in it (rule 6);
//   · a RANGE, low ≤ high, in integer minor units with one currency
//     (rule 1). Where nothing estimated enters, low = high and the screen
//     prints one figure; the number grammar's ranges are for estimates.
//
// A component whose input the business doesn't have is ABSENT, with a
// sentence saying what would fill it. Nothing falls back to an industry
// number, and two currencies are never added.
//
// The components and how each is priced:
//
//   revenue_dips        days in a run of 2+ that the anomaly detector's
//                       own baseline calls beyond the usual range, downward:
//                       high = expected − actual, low = expected − one
//                       usual variation − actual. Whatever that day's
//                       no-shows, late cancellations and empty slots
//                       already explain is taken off, so nothing is
//                       counted twice.
//   no_shows            no-shows × the measured average booking price,
//   late_cancellations  late cancellations × the same; the price is a
//                       range: the lowest to the highest weekly average
//                       over the window.
//   empty_capacity      ONLY with a capacity the owner gave: per week,
//                       (capacity × measured days ÷ 7 − appointments still
//                       held when their time came) × the same price range.
//   losing_ads          per campaign with return on ad spend below 1 over
//                       the last 14 days (the pause rule's window): spend −
//                       the purchase value Meta attributes to it. Meta's
//                       attribution, named.
//   slow_stock          cash tied up in the slow items (lib/stock/assess):
//                       a STOCK, not a flow — never added to a month.
//   on_the_table        the waiting proposals' base case to upside case,
//                       per month: a FORECAST, shown ahead of today.

import type { Basis } from "../../components/report/basis";
import { moneyText, num } from "../../components/sheet/num";
import { MAD_K, RUN_DAYS, evaluateDay, shiftDay } from "../anomaly/baseline";
import { weekStart } from "../care/chart-view";
import { minorUnitExponent } from "../core/money";

export const OPPORTUNITY = {
  /** The window every flow is priced over, ending on the series' latest measured day. */
  window_days: 90,
  /** "A month" on the screen: thirty days. */
  month_days: 30,
  /** A week's average booking price counts toward the price range only past this many completed. */
  min_week_completed: 5,
  /** ROAS strictly below this over the window: the campaign is losing (lib/ads's pause line). */
  losing_roas_below: 1.0,
  /**
   * Ads are read over the pause rule's own window (lib/ads ADS.pause_window_days,
   * pinned equal by a test): a campaign that went bad three weeks ago is losing
   * now, even if a quarter's average still looks fine.
   */
  ads_window_days: 14,
} as const;

export const COMPONENT_KEYS = [
  "revenue_dips",
  "no_shows",
  "late_cancellations",
  "empty_capacity",
  "losing_ads",
  "slow_stock",
  "on_the_table",
] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

/** flow: lost per month, added to the headline. stock: a balance. forecast: ahead of today. */
export type ComponentKind = "flow" | "stock" | "forecast";

export const COMPONENT_KIND: Readonly<Record<ComponentKey, ComponentKind>> = {
  revenue_dips: "flow",
  no_shows: "flow",
  late_cancellations: "flow",
  empty_capacity: "flow",
  losing_ads: "flow",
  slow_stock: "stock",
  on_the_table: "forecast",
};

/** The owner's words for each component — headline ("mostly no-shows") and table. */
export const COMPONENT_LABEL: Readonly<Record<ComponentKey, string>> = {
  revenue_dips: "Revenue dips",
  no_shows: "No-shows",
  late_cancellations: "Late cancellations",
  empty_capacity: "Empty slots",
  losing_ads: "Ads that lose money",
  slow_stock: "Cash in slow stock",
  on_the_table: "On the table",
};

/** Lower-case, for "mostly …". */
export const COMPONENT_NOUN: Readonly<Record<ComponentKey, string>> = {
  revenue_dips: "revenue dips",
  no_shows: "no-shows",
  late_cancellations: "late cancellations",
  empty_capacity: "empty slots",
  losing_ads: "ads that lose money",
  slow_stock: "slow stock",
  on_the_table: "waiting proposals",
};

export interface MoneyRange {
  low_minor: number;
  high_minor: number;
  currency: string;
}

export interface Window {
  from: string;
  to: string;
}

export interface DaySlip {
  date: string;
  low_minor: number;
  high_minor: number;
}

interface ComponentBase {
  key: ComponentKey;
  label: string;
  kind: ComponentKind;
}

export interface PricedComponent extends ComponentBase {
  status: "priced";
  basis: Basis;
  /** What the basis rests on, in words, when it isn't the whole story ("from a capacity you STATED"). */
  basis_note: string | null;
  /** The days it was priced over and the divisor of "a month". */
  window: { from: string; to: string; days: number };
  total: MoneyRange;
  /** Per 30 days; null for a stock, which is a balance, not a rate. */
  monthly: MoneyRange | null;
  /** Rule 6: the series and facts it was worked out from. */
  derived_from: string[];
  /** The arithmetic, with the numbers in it. */
  formula: string;
  /** Per day, for the revenue line; empty when the component is not drawn on it. */
  daily: DaySlip[];
  /** Anything the reader needs beside the arithmetic (a left-out currency). */
  note: string | null;
}

export interface AbsentComponent extends ComponentBase {
  status: "absent";
  /** What would fill it, in the owner's terms. */
  reason: string;
}

export type OpportunityComponent = PricedComponent | AbsentComponent;

/* ── helpers ── */

const fig = (minor: number, currency: string) => moneyText(Math.round(minor), currency);

/** "€1,180–€1,950", or one figure when the ends meet. */
export function rangeText(r: { low_minor: number; high_minor: number; currency: string }): string {
  return r.low_minor === r.high_minor
    ? fig(r.low_minor, r.currency)
    : `${fig(r.low_minor, r.currency)}–${fig(r.high_minor, r.currency)}`;
}

export function daysInclusive(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

/** The window ending on `to`, OPPORTUNITY.window_days long. */
export function windowEnding(to: string, days: number = OPPORTUNITY.window_days): Window {
  return { from: shiftDay(to, -(days - 1)), to };
}

/** Per 30 days, from a total over `days` measured days. Integers in, integers out. */
export function perMonth(total_minor: number, days: number): number {
  return days > 0 ? Math.round((total_minor * OPPORTUNITY.month_days) / days) : 0;
}

function ordered(low: number, high: number): [number, number] {
  return low <= high ? [low, high] : [high, low];
}

function priced(args: {
  key: ComponentKey;
  basis: Basis;
  basis_note?: string | null;
  window: { from: string; to: string; days: number };
  low_minor: number;
  high_minor: number;
  currency: string;
  derived_from: string[];
  formula: string;
  daily?: DaySlip[];
  note?: string | null;
}): PricedComponent {
  const [low, high] = ordered(Math.round(args.low_minor), Math.round(args.high_minor));
  const kind = COMPONENT_KIND[args.key];
  return {
    key: args.key,
    label: COMPONENT_LABEL[args.key],
    kind,
    status: "priced",
    basis: args.basis,
    basis_note: args.basis_note ?? null,
    window: args.window,
    total: { low_minor: low, high_minor: high, currency: args.currency },
    monthly:
      kind === "stock"
        ? null
        : kind === "forecast"
          ? { low_minor: low, high_minor: high, currency: args.currency }
          : {
              low_minor: perMonth(low, args.window.days),
              high_minor: perMonth(high, args.window.days),
              currency: args.currency,
            },
    derived_from: args.derived_from,
    formula: args.formula,
    daily: args.daily ?? [],
    note: args.note ?? null,
  };
}

export function absent(key: ComponentKey, reason: string): AbsentComponent {
  return { key, label: COMPONENT_LABEL[key], kind: COMPONENT_KIND[key], status: "absent", reason };
}

/* ── bookings: the price an appointment is worth ── */

export interface BookingDay {
  date: string;
  completed: number;
  no_show: number;
  /** Null when the source doesn't separate late cancellations (Square). */
  late: number | null;
  /** The listed price of that day's completed appointments; null when the source has no prices. */
  revenue_minor: number | null;
}

export interface BookingsInput {
  /** Owner-facing name: "your bookings export", "Square". */
  source: string;
  /** The series id prefix for derived_from ("connector:bookings_import"). */
  series: string;
  /** The prices' currency; null when the source has no prices. */
  currency: string | null;
  late_separated: boolean;
  days: readonly BookingDay[];
}

export type PriceRange =
  | {
      status: "ok";
      low_minor: number;
      high_minor: number;
      mean_minor: number;
      currency: string;
      weeks: number;
      arithmetic: string;
    }
  | { status: "absent"; reason: string };

const inWindow = (date: string, w: Window) => date >= w.from && date <= w.to;

/**
 * The measured average booking price over the window, as a range: the
 * lowest to the highest weekly average (weeks with at least
 * OPPORTUNITY.min_week_completed completed appointments), never narrower
 * than the window's own mean.
 */
export function bookingPriceRange(b: BookingsInput, w: Window): PriceRange {
  if (b.currency === null) {
    return {
      status: "absent",
      reason: `${b.source} has no prices — add the price column to the export and I'll price what was missed`,
    };
  }
  const days = b.days.filter((d) => inWindow(d.date, w) && d.revenue_minor !== null);
  const completed = days.reduce((n, d) => n + d.completed, 0);
  const revenue = days.reduce((n, d) => n + (d.revenue_minor ?? 0), 0);
  if (completed === 0 || revenue <= 0) {
    return {
      status: "absent",
      reason: `no priced, completed appointments between ${w.from} and ${w.to}, so I can't say what one is worth`,
    };
  }
  const mean = Math.round(revenue / completed);
  const weeks = new Map<string, { c: number; r: number }>();
  for (const d of days) {
    const k = weekStart(d.date);
    const acc = weeks.get(k) ?? { c: 0, r: 0 };
    acc.c += d.completed;
    acc.r += d.revenue_minor ?? 0;
    weeks.set(k, acc);
  }
  const averages = [...weeks.values()]
    .filter((x) => x.c >= OPPORTUNITY.min_week_completed)
    .map((x) => Math.round(x.r / x.c));
  const low = Math.min(mean, ...averages);
  const high = Math.max(mean, ...averages);
  return {
    status: "ok",
    low_minor: low,
    high_minor: high,
    mean_minor: mean,
    currency: b.currency,
    weeks: averages.length,
    arithmetic:
      `average price ${fig(mean, b.currency)} (${fig(revenue, b.currency)} ÷ ${num(completed)} completed)` +
      (averages.length > 1 && low !== high
        ? `, between ${fig(low, b.currency)} and ${fig(high, b.currency)} week to week over ${averages.length} weeks`
        : ""),
  };
}

const NO_BOOKINGS =
  "import your bookings export (or connect Square) and I'll count what was missed";

function countPriced(
  key: "no_shows" | "late_cancellations",
  b: BookingsInput | null,
  w: Window,
): OpportunityComponent {
  if (b === null || b.days.length === 0) return absent(key, NO_BOOKINGS);
  if (key === "late_cancellations" && !b.late_separated) {
    return absent(
      key,
      `${b.source} doesn't separate late cancellations from no-shows, so they are priced with the no-shows`,
    );
  }
  const price = bookingPriceRange(b, w);
  if (price.status === "absent") return absent(key, price.reason);
  const days = b.days.filter((d) => inWindow(d.date, w));
  const daily: DaySlip[] = [];
  let count = 0;
  for (const d of days) {
    const n = key === "no_shows" ? d.no_show : (d.late ?? 0);
    if (n <= 0) continue;
    count += n;
    daily.push({ date: d.date, low_minor: n * price.low_minor, high_minor: n * price.high_minor });
  }
  const noun = key === "no_shows" ? "no-show" : "late cancellation";
  const metric =
    key === "no_shows" ? "appointments_no_show.daily" : "appointments_cancelled_late.daily";
  const window = { from: w.from, to: w.to, days: days.length };
  return priced({
    key,
    basis: "DERIVED",
    window,
    low_minor: count * price.low_minor,
    high_minor: count * price.high_minor,
    currency: price.currency,
    derived_from: [`${b.series}:${metric}`, `${b.series}:booking_revenue.daily`],
    formula:
      `${num(count)} ${noun}${count === 1 ? "" : "s"} in ${num(days.length)} measured days × ` +
      `${rangeText({ low_minor: price.low_minor, high_minor: price.high_minor, currency: price.currency })} ` +
      `(${price.arithmetic}), from ${b.source}`,
    daily,
  });
}

export function noShows(b: BookingsInput | null, w: Window): OpportunityComponent {
  return countPriced("no_shows", b, w);
}

export function lateCancellations(b: BookingsInput | null, w: Window): OpportunityComponent {
  return countPriced("late_cancellations", b, w);
}

/** The owner's stated weekly capacity (service.capacity_per_week), with the basis it carries. */
export interface CapacityInput {
  per_week: number;
  /** STATED or ESTIMATED: the owner's own answer, never an assumption. */
  basis: Basis;
}

export function emptyCapacity(
  b: BookingsInput | null,
  capacity: CapacityInput | null,
  w: Window,
): OpportunityComponent {
  if (capacity === null || !Number.isFinite(capacity.per_week) || capacity.per_week <= 0) {
    return absent(
      "empty_capacity",
      "tell me how many appointments you can take a week and I'll price the empty slots — I won't assume a capacity",
    );
  }
  if (b === null || b.days.length === 0) return absent("empty_capacity", NO_BOOKINGS);
  const price = bookingPriceRange(b, w);
  if (price.status === "absent") return absent("empty_capacity", price.reason);
  const days = b.days
    .filter((d) => inWindow(d.date, w))
    .sort((x, y) => x.date.localeCompare(y.date));
  const weeks = new Map<string, BookingDay[]>();
  for (const d of days) weeks.set(weekStart(d.date), [...(weeks.get(weekStart(d.date)) ?? []), d]);
  const daily: DaySlip[] = [];
  let slots = 0;
  let held = 0;
  let unbooked = 0;
  let low = 0;
  let high = 0;
  for (const list of weeks.values()) {
    const weekSlots = (capacity.per_week * list.length) / 7;
    const weekHeld = list.reduce((n, d) => n + d.completed + d.no_show + (d.late ?? 0), 0);
    const empty = Math.max(0, weekSlots - weekHeld);
    slots += weekSlots;
    held += weekHeld;
    unbooked += empty;
    const lo = Math.round(empty * price.low_minor);
    const hi = Math.round(empty * price.high_minor);
    low += lo;
    high += hi;
    // Spread evenly over the week's measured days; the remainder lands on the last.
    list.forEach((d, i) => {
      const last = i === list.length - 1;
      const share = (v: number) =>
        last ? v - Math.floor(v / list.length) * (list.length - 1) : Math.floor(v / list.length);
      if (lo > 0 || hi > 0)
        daily.push({ date: d.date, low_minor: share(lo), high_minor: share(hi) });
    });
  }
  const r1 = (v: number) =>
    num(Math.round(v * 10) / 10, Number.isInteger(Math.round(v * 10) / 10) ? 0 : 1);
  return priced({
    key: "empty_capacity",
    basis: "DERIVED",
    basis_note: `from a capacity you ${capacity.basis === "ESTIMATED" ? "ESTIMATED" : "STATED"} (${num(capacity.per_week)} a week)`,
    window: { from: w.from, to: w.to, days: days.length },
    low_minor: low,
    high_minor: high,
    currency: price.currency,
    derived_from: [
      "service.capacity_per_week",
      `${b.series}:appointments_completed.daily`,
      `${b.series}:appointments_no_show.daily`,
      `${b.series}:booking_revenue.daily`,
    ],
    formula:
      `${num(capacity.per_week)} a week × ${num(days.length)} measured days ÷ 7 = ${r1(slots)} slots, ` +
      `less ${num(held)} appointments still held when their time came = ${r1(unbooked)} empty, ` +
      `× ${rangeText({ low_minor: price.low_minor, high_minor: price.high_minor, currency: price.currency })} (${price.arithmetic}). ` +
      `No-shows and late cancellations are priced on their own lines, not here`,
    daily,
  });
}

/* ── revenue dips, by the anomaly detector's own baseline ── */

export interface DipInput {
  /** "YYYY-MM-DD" → the day's value, integer minor units; missing days absent. */
  series: ReadonlyMap<string, number>;
  currency: string;
  /** "connector:shopify:revenue.daily" — what the dips are read from. */
  series_id: string;
  /** Owner-facing name of the series ("revenue"). */
  noun: string;
}

/**
 * Days in a run of RUN_DAYS or more consecutive days the detector calls
 * beyond its usual range, downward. `explained` is what that day's other
 * components already price, taken off so nothing counts twice.
 */
export function revenueDips(
  input: DipInput | null,
  w: Window,
  explained: ReadonlyMap<string, { low_minor: number; high_minor: number }> = new Map(),
): OpportunityComponent {
  if (input === null) {
    return absent(
      "revenue_dips",
      "connect where your takings live (your shop, your till or Stripe) and I'll check each day against its usual level",
    );
  }
  // Read from RUN_DAYS − 1 before the window, so a run straddling its start is still a run.
  const verdicts: { date: string; expected: number; actual: number; scale: number }[] = [];
  let judged = 0;
  for (let d = shiftDay(w.from, -(RUN_DAYS - 1)); d <= w.to; d = shiftDay(d, 1)) {
    const v = evaluateDay(input.series, d);
    if (v === null) continue;
    if (d >= w.from) judged += 1;
    if (v.beyond && v.direction === "drop") {
      verdicts.push({ date: d, expected: v.expected, actual: v.actual, scale: v.baseline.scale });
    }
  }
  if (judged === 0) {
    return absent(
      "revenue_dips",
      `I need at least 14 measured days of ${input.noun} in the 28 before a day to judge it — the history is too short yet`,
    );
  }
  // Group into runs of consecutive calendar days.
  const runs: (typeof verdicts)[] = [];
  for (const v of verdicts) {
    const run = runs.at(-1);
    const prev = run?.at(-1);
    if (run && prev && shiftDay(prev.date, 1) === v.date) run.push(v);
    else runs.push([v]);
  }
  const counted = runs.filter((r) => r.length >= RUN_DAYS);
  const daily: DaySlip[] = [];
  let low = 0;
  let high = 0;
  let gross = 0;
  let days = 0;
  for (const run of counted) {
    for (const v of run) {
      if (v.date < w.from) continue;
      days += 1;
      const hi = Math.max(0, v.expected - v.actual);
      const lo = Math.max(0, v.expected - v.scale - v.actual);
      gross += hi;
      const other = explained.get(v.date);
      const netLo = Math.round(Math.max(0, lo - (other?.high_minor ?? 0)));
      const netHi = Math.round(Math.max(0, hi - (other?.low_minor ?? 0)));
      low += netLo;
      high += netHi;
      if (netLo > 0 || netHi > 0) daily.push({ date: v.date, low_minor: netLo, high_minor: netHi });
    }
  }
  const window = { from: w.from, to: w.to, days: judged };
  const runsIn = counted.filter((r) => r.some((v) => v.date >= w.from)).length;
  return priced({
    key: "revenue_dips",
    basis: "DERIVED",
    window,
    low_minor: low,
    high_minor: high,
    currency: input.currency,
    derived_from: [input.series_id],
    formula:
      days === 0
        ? `no run of ${RUN_DAYS}+ days below the usual range in ${num(judged)} judged days (the detector's baseline: 28-day average × weekday factor, beyond at ${MAD_K}× the usual variation)`
        : `${num(days)} day${days === 1 ? "" : "s"} in ${num(runsIn)} run${runsIn === 1 ? "" : "s"} of ${RUN_DAYS}+ below the usual range ` +
          `(28-day average × weekday factor, beyond at ${MAD_K}× the usual variation): ` +
          `expected − actual = ${fig(gross, input.currency)}; the low end leaves one usual variation a day` +
          (explained.size > 0
            ? `; less what that day's no-shows, late cancellations and empty slots already price`
            : ""),
    daily,
  });
}

/* ── ads that cost more than Meta says they bring back ── */

export interface CampaignInput {
  campaign_ref: string;
  campaign_name: string;
  currency: string;
  /** Measured days: spend and Meta's attributed purchase value, minor units. */
  days: readonly { date: string; spend_minor: number; value_minor: number }[];
}

export interface CampaignWindow {
  campaign_ref: string;
  campaign_name: string;
  currency: string;
  measured_days: number;
  spend_minor: number;
  value_minor: number;
  /** value ÷ spend; null when nothing was spent. */
  roas: number | null;
  losing: boolean;
}

export function campaignWindows(campaigns: readonly CampaignInput[], w: Window): CampaignWindow[] {
  return campaigns
    .map((c) => {
      const days = c.days.filter((d) => inWindow(d.date, w));
      const spend = days.reduce((n, d) => n + d.spend_minor, 0);
      const value = days.reduce((n, d) => n + d.value_minor, 0);
      const roas = spend > 0 ? value / spend : null;
      return {
        campaign_ref: c.campaign_ref,
        campaign_name: c.campaign_name,
        currency: c.currency,
        measured_days: days.length,
        spend_minor: spend,
        value_minor: value,
        roas,
        losing: roas !== null && roas < OPPORTUNITY.losing_roas_below,
      };
    })
    .filter((c) => c.measured_days > 0)
    .sort((a, b) => b.spend_minor - a.spend_minor);
}

export function losingAds(
  campaigns: readonly CampaignInput[] | null,
  w: Window,
  currency: string,
): OpportunityComponent {
  if (campaigns === null) {
    return absent(
      "losing_ads",
      "connect Meta Ads and I'll check which campaigns cost more than they bring back",
    );
  }
  const all = campaignWindows(campaigns, w);
  if (all.length === 0) {
    return absent("losing_ads", `no campaign spent anything between ${w.from} and ${w.to}`);
  }
  const mine = all.filter((c) => c.currency === currency);
  const other = all.filter((c) => c.currency !== currency);
  const losers = mine.filter((c) => c.losing);
  const loss = losers.reduce((n, c) => n + (c.spend_minor - c.value_minor), 0);
  const roas = (c: CampaignWindow) => (c.roas === null ? "—" : num(c.roas, 2));
  return priced({
    key: "losing_ads",
    basis: "DERIVED",
    basis_note: "from Meta's own attribution",
    window: { from: w.from, to: w.to, days: daysInclusive(w.from, w.to) },
    low_minor: loss,
    high_minor: loss,
    currency,
    derived_from: [
      "connector:meta_ads:ad_spend.campaign.daily",
      "connector:meta_ads:ad_purchase_value.campaign.daily",
    ],
    formula:
      losers.length === 0
        ? `every campaign returned at least what it cost, by Meta's attribution (${mine.length} campaign${mine.length === 1 ? "" : "s"})`
        : losers
            .map(
              (c) =>
                `${c.campaign_name}: spent ${fig(c.spend_minor, c.currency)}, Meta attributes ${fig(c.value_minor, c.currency)} (return ${roas(c)}) → ${fig(c.spend_minor - c.value_minor, c.currency)}`,
            )
            .join("; "),
    note:
      other.length > 0
        ? `${other.length} campaign${other.length === 1 ? "" : "s"} in ${[...new Set(other.map((c) => c.currency))].join(", ")} left out: currencies never blend`
        : null,
  });
}

/* ── cash tied up in slow stock: a balance, never a month ── */

export interface SlowItemInput {
  name: string;
  cash_tied_minor: number | null;
  currency: string | null;
  cost_basis: "measured" | "stated" | null;
}

export function slowStock(
  items: readonly SlowItemInput[] | null,
  currency: string,
  asOf: string | null,
): OpportunityComponent {
  if (items === null) {
    return absent(
      "slow_stock",
      "connect your store or import a stock file and I'll show the cash sitting on the shelf",
    );
  }
  const mine = items.filter((i) => i.currency === currency && i.cash_tied_minor !== null);
  const unknown = items.filter((i) => i.cash_tied_minor === null).length;
  const other = items.filter((i) => i.currency !== null && i.currency !== currency).length;
  const total = mine.reduce((n, i) => n + (i.cash_tied_minor ?? 0), 0);
  const stated = mine.some((i) => i.cost_basis === "stated");
  const day = asOf ?? "the latest count";
  return priced({
    key: "slow_stock",
    basis: stated ? "DERIVED" : "OBSERVED",
    basis_note: stated ? "units on hand × a cost you gave, for some items" : null,
    window: { from: day, to: day, days: 1 },
    low_minor: total,
    high_minor: total,
    currency,
    derived_from: ["stock.on_hand", "stock.value_at_cost"],
    formula:
      mine.length === 0
        ? `nothing flagged slow or stuck as of ${day}`
        : `${num(mine.length)} slow item${mine.length === 1 ? "" : "s"}, units on hand × unit cost, as of ${day}. A stock, not a monthly flow: it is not added to the month`,
    note:
      [
        unknown > 0 ? `${num(unknown)} with no known cost, left out` : null,
        other > 0 ? `${num(other)} in another currency, left out` : null,
      ]
        .filter(Boolean)
        .join("; ") || null,
  });
}

/* ── what the waiting proposals put on the table ── */

export interface WaitingProposal {
  id: string;
  summary: string;
  base: { amount_minor: number; currency: string } | null;
  upside: { amount_minor: number; currency: string } | null;
}

export function onTheTable(
  proposals: readonly WaitingProposal[],
  currency: string,
  today: string,
): OpportunityComponent {
  const usable = proposals.filter(
    (p) =>
      p.base !== null &&
      p.upside !== null &&
      p.base.currency === currency &&
      p.upside.currency === currency &&
      Math.max(p.base.amount_minor, p.upside.amount_minor) > 0,
  );
  if (usable.length === 0) {
    return absent(
      "on_the_table",
      proposals.length === 0
        ? "nothing is waiting for your approval right now"
        : "nothing waiting for you carries a priced gain yet",
    );
  }
  let low = 0;
  let high = 0;
  const parts: string[] = [];
  for (const p of usable) {
    const base = p.base!.amount_minor;
    const up = p.upside!.amount_minor;
    const lo = Math.max(0, Math.min(base, up));
    const hi = Math.max(0, base, up);
    low += lo;
    high += hi;
    parts.push(`${p.summary}: ${rangeText({ low_minor: lo, high_minor: hi, currency })}`);
  }
  return priced({
    key: "on_the_table",
    basis: "ESTIMATED",
    basis_note: "the proposals' own base and upside cases",
    window: { from: today, to: today, days: OPPORTUNITY.month_days },
    low_minor: low,
    high_minor: high,
    currency,
    derived_from: usable.map((p) => `proposals.${p.id}.scenario`),
    formula: `${num(usable.length)} waiting proposal${usable.length === 1 ? "" : "s"}, base case to upside a month: ${parts.join("; ")}`,
  });
}

/* ── the headline ── */

export interface Headline {
  /** "About €1,180–€1,950 a month is slipping away — mostly no-shows." */
  text: string;
  /** The flows' monthly sum in the chart's currency; null when none is priced. */
  monthly: MoneyRange | null;
  lead: ComponentKey | null;
}

/**
 * "About": low rounded down and high rounded up to ten major units, for the
 * headline only (the table keeps the exact figures). A single figure is
 * rounded to the nearest ten, so a point never turns into a range.
 */
export function aboutRange(r: MoneyRange): MoneyRange {
  const unit = 10 * 10 ** minorUnitExponent(r.currency);
  if (r.low_minor === r.high_minor) {
    const at = Math.round(r.low_minor / unit) * unit;
    return { low_minor: at, high_minor: at, currency: r.currency };
  }
  const low = Math.floor(r.low_minor / unit) * unit;
  const high = Math.ceil(r.high_minor / unit) * unit;
  return { low_minor: low, high_minor: Math.max(low, high), currency: r.currency };
}

export function headline(components: readonly OpportunityComponent[], currency: string): Headline {
  const flows = components.filter(
    (c): c is PricedComponent =>
      c.status === "priced" &&
      c.kind === "flow" &&
      c.monthly !== null &&
      c.total.currency === currency,
  );
  const low = flows.reduce((n, c) => n + c.monthly!.low_minor, 0);
  const high = flows.reduce((n, c) => n + c.monthly!.high_minor, 0);
  if (flows.length === 0) {
    return {
      text: "Nothing I can measure yet shows money slipping away.",
      monthly: null,
      lead: null,
    };
  }
  if (high <= 0) {
    return {
      text: "Nothing measured is slipping away right now.",
      monthly: { low_minor: 0, high_minor: 0, currency },
      lead: null,
    };
  }
  const lead = [...flows].sort((a, b) => b.monthly!.high_minor - a.monthly!.high_minor)[0]!;
  const share = lead.monthly!.high_minor / high;
  const monthly = { low_minor: low, high_minor: high, currency };
  const about = aboutRange(monthly);
  const tail =
    flows.filter((c) => c.monthly!.high_minor > 0).length === 1
      ? ` — all of it ${COMPONENT_NOUN[lead.key]}`
      : share >= 0.5
        ? ` — mostly ${COMPONENT_NOUN[lead.key]}`
        : ` — the largest part ${COMPONENT_NOUN[lead.key]}`;
  return {
    text: `About ${rangeText(about)} a month is slipping away${tail}.`,
    monthly,
    lead: lead.key,
  };
}
