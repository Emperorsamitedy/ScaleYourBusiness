// After the check: a test's result against the lines set before it ran
// (I-32, rule 41), the plan against the first measured month (I-51), and
// the first connector to suggest at launch (I-52). Pure.

import ideaFile from "../../specs/idea-v1.json";
import { isProviderId } from "../connectors/scopes";
import type { ProviderId } from "../connectors/scopes";
import { perUnit, ratioBp, scaleMinorBy } from "../core/money";
import type { NextTest } from "./check";
import type { RevenueModel } from "./model";

export type TestReading = "pass" | "fail" | "between";

/**
 * Pure: rule 41. A result is read against the lines stored with the test,
 * never re-read: a count for a pre-sale or pilots, the middle quote in
 * minor units for quotes.
 */
export function scoreTest(test: NextTest, observed: number): TestReading {
  if (!Number.isSafeInteger(observed) || observed < 0) {
    throw new RangeError("a result is a whole number from zero");
  }
  switch (test.id) {
    case "presale":
      return observed >= test.pass_at_least
        ? "pass"
        : observed < test.fail_below
          ? "fail"
          : "between";
    case "pilots":
      return observed >= test.pass_at_least
        ? "pass"
        : observed <= test.fail_at_most
          ? "fail"
          : "between";
    case "quotes":
      return observed <= test.pass_at_most_minor
        ? "pass"
        : observed >= test.fail_at_least_minor
          ? "fail"
          : "between";
  }
}

export const MIN_MEASURED_DAYS = ideaFile.plan_vs_actual.min_measured_days;

export type PlanVsActual =
  | {
      status: "compared";
      currency: string;
      planned_minor: number;
      actual_minor: number;
      days_measured: number;
      /** (actual − planned) ÷ planned, basis points. */
      delta_bp: number;
    }
  | { status: "too_early"; days_measured: number; needed: number }
  | { status: "no_plan" }
  | { status: "other_currency"; planned: string; measured: string };

/**
 * Pure: I-51. The plan's monthly revenue against the last measured days,
 * scaled to the same number of days (30 days = the plan's month). Shown,
 * never swapped in: the stated figure stays as it was (Phase 2's rule).
 */
export function planVsActual(args: {
  planned: { amount_minor: number; currency: string } | null;
  measured: { sum_minor: number; days: number; currency: string | null };
}): PlanVsActual {
  if (!args.planned || args.planned.amount_minor <= 0) return { status: "no_plan" };
  const { measured } = args;
  if (measured.days < MIN_MEASURED_DAYS) {
    return { status: "too_early", days_measured: measured.days, needed: MIN_MEASURED_DAYS };
  }
  if (measured.currency !== args.planned.currency) {
    return {
      status: "other_currency",
      planned: args.planned.currency,
      measured: measured.currency ?? "-",
    };
  }
  // The plan is a month; the measured window is `days` long: compare per 30 days.
  const actual = scaleMinorBy(measured.sum_minor, 30, measured.days);
  return {
    status: "compared",
    currency: args.planned.currency,
    planned_minor: args.planned.amount_minor,
    actual_minor: actual,
    days_measured: measured.days,
    delta_bp: ratioBp(actual - args.planned.amount_minor, args.planned.amount_minor),
  };
}

export type AssumptionLine =
  | {
      key: "customers";
      status: "compared";
      planned: number;
      /** Measured orders, scaled to 30 days. */
      actual: number;
      delta_bp: number;
    }
  | {
      key: "price";
      status: "compared";
      currency: string;
      planned_minor: number;
      /** Measured revenue ÷ measured orders: the average sale. */
      actual_minor: number;
      delta_bp: number;
    }
  | {
      key: "customers" | "price";
      status: "not_comparable";
      why: "subscription" | "no_estimate" | "no_orders" | "other_currency";
    }
  | { key: "costs"; status: "not_measured" };

/**
 * Pure: I-51, per assumption. Customers against measured orders (scaled to
 * a 30-day month) and price against the measured average sale (revenue ÷
 * orders, same days). Costs aren't measured from any connected source yet,
 * and say so. A subscription's orders aren't its subscribers, so neither
 * line is compared for one. Shown beside the plan, never swapped in.
 */
export function assumptionsVsActual(args: {
  model: RevenueModel;
  planned: { customers: number | null; price_minor: number; currency: string };
  revenue: { sum_minor: number; days: number; currency: string | null };
  orders: { sum: number; days: number };
}): AssumptionLine[] {
  const costs: AssumptionLine = { key: "costs", status: "not_measured" };
  if (args.model === "subscription") {
    return [
      { key: "customers", status: "not_comparable", why: "subscription" },
      { key: "price", status: "not_comparable", why: "subscription" },
      costs,
    ];
  }
  const enough = args.orders.days >= MIN_MEASURED_DAYS && args.orders.sum > 0;
  const customers: AssumptionLine =
    args.planned.customers === null || args.planned.customers <= 0
      ? { key: "customers", status: "not_comparable", why: "no_estimate" }
      : !enough
        ? { key: "customers", status: "not_comparable", why: "no_orders" }
        : (() => {
            const actual = Math.round((args.orders.sum * 30) / args.orders.days); // not money: orders per 30 days
            return {
              key: "customers" as const,
              status: "compared" as const,
              planned: args.planned.customers,
              actual,
              delta_bp: ratioBp(actual - args.planned.customers, args.planned.customers),
            };
          })();
  const price: AssumptionLine = !enough
    ? { key: "price", status: "not_comparable", why: "no_orders" }
    : args.revenue.currency !== args.planned.currency
      ? { key: "price", status: "not_comparable", why: "other_currency" }
      : (() => {
          const actual = perUnit(args.revenue.sum_minor, args.orders.sum);
          return {
            key: "price" as const,
            status: "compared" as const,
            currency: args.planned.currency,
            planned_minor: args.planned.price_minor,
            actual_minor: actual,
            delta_bp: ratioBp(actual - args.planned.price_minor, args.planned.price_minor),
          };
        })();
  return [customers, price, costs];
}

const FIRST = ideaFile.first_connector as {
  by_model: Record<string, string>;
  by_sector: Record<string, string>;
  default: string;
};

/** Pure: I-52, as data. Revenue model first, then the kind of business, then the default. */
export function firstConnector(model: RevenueModel, sector: string): ProviderId {
  const id = FIRST.by_model[model] ?? FIRST.by_sector[sector] ?? FIRST.default;
  if (!isProviderId(id)) throw new Error(`idea-v1.json names an unknown provider: ${id}`);
  return id;
}
