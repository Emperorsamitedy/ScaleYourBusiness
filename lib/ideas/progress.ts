// After the check: a test's result against the lines set before it ran
// (I-32, rule 41), the plan against the first measured month (I-51), and
// the first connector to suggest at launch (I-52). Pure.

import ideaFile from "../../specs/idea-v1.json";
import { isProviderId } from "../connectors/scopes";
import type { ProviderId } from "../connectors/scopes";
import { ratioBp, scaleMinorBy } from "../core/money";
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
      measured: measured.currency ?? "—",
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
