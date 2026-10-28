// Hand-built inputs for the cash forecast's tests and the demo's numbers.
// Pure: no database, no clock.

import { addDays } from "../seasons/forecast";
import type { CashInputs, CostLine, DailySeries, MoneyFact, OfferLine } from "./model";

export const TODAY = "2026-10-27";

export function eur(major: number, basis: MoneyFact["basis"] = "STATED"): MoneyFact {
  return {
    amount_minor: Math.round(major * 100),
    currency: "EUR",
    basis,
    source: "as you told me",
    on: null,
  };
}

/** A daily series of `days` days ending yesterday, each day's value from `at`. */
export function daily(
  today: string,
  days: number,
  at: (day: string, i: number) => number,
  extra: Partial<DailySeries> = {},
): DailySeries {
  const values = new Map<string, number>();
  for (let i = days; i >= 1; i--) {
    const day = addDays(today, -i);
    values.set(day, Math.round(at(day, days - i)));
  }
  return {
    source: "Shopify",
    provider: "shopify",
    noun: "revenue",
    currency: "EUR",
    values,
    ...extra,
  };
}

export function cost(
  label: string,
  major: number,
  cadence: string,
  extra: Partial<CostLine> = {},
): CostLine {
  return {
    key: `costs.${label.toLowerCase().replace(/\W+/g, "-")}`,
    label,
    category: null,
    list: cadence === "per_unit" || cadence === "per_job" ? "variable" : "fixed",
    amount: eur(major),
    cadence,
    ...extra,
  };
}

export function offer(
  name: string,
  price: number,
  cost: number | null,
  volume: number | null,
): OfferLine {
  return {
    key: `offers.${name.toLowerCase()}`,
    name,
    price: eur(price),
    cost: cost === null ? null : eur(cost),
    volume_month:
      volume === null ? null : { value: volume, basis: "STATED", source: "as you told me" },
  };
}

/** A business paid in cash only (no payout delay), with €1,000 a day for 120 days. */
export function baseInputs(over: Partial<CashInputs> = {}): CashInputs {
  return {
    today: TODAY,
    cash: { status: "known", fact: eur(5000) },
    buffer: { status: "known", fact: eur(2000) },
    debt: { status: "missing" },
    revenue: daily(TODAY, 120, () => 100_000),
    volume: null,
    orders_month: null,
    payout: { provider: null, methods: ["cash"] },
    costs: [],
    offers: [],
    connect: "Connect your shop or your payments",
    other_currencies: [],
    ...over,
  };
}
