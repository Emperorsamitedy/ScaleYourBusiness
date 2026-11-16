// The idea check's arithmetic — TASKS-IDEAS.md I-20, I-22, I-23. Pure: no
// database, no network, no model, no clock.
//
// Everything here is the owner's own stated plan worked through (grade D,
// rule 37); nothing is a verdict on the idea (rule 36). Money is integer
// minor units in the plan's one currency (rule 1), and every figure says
// what it was worked out from (rule 6).
//
//   contribution        price − variable cost, per sale (or per subscriber a month)
//   break-even          ⌈fixed a month ÷ contribution⌉ customers a month
//   cash path           36 months: capital − start-up, then each month's
//                       sales (ramping straight up to the plan over the
//                       chosen months, rounded down) × contribution − fixed
//   breaking point      for each of customers, price, variable cost and
//                       fixed cost alone: the value at which a month at full
//                       plan stops covering itself, and how far that is from
//                       what was stated (basis points of the stated value)
//   riskiest            D94, rule 38: among the ESTIMATES only (customers,
//                       variable cost, fixed cost — the price is a decision,
//                       and as a share of itself it always has the least
//                       room, so ranking it would say nothing), the one with
//                       the least room; ties in a fixed order. With the
//                       customers unknown, it is the customers; and
//                       ./check overrides to the customers when the plan's
//                       revenue per person is above the sector's.
//
// A recruitment-based revenue model is never worked through (rule 39).

import ideaFile from "../../specs/idea-v1.json";
import { ratioBp } from "../core/money";

export const HORIZON_MONTHS = ideaFile.horizon_months;

export type CustomerKind = "consumer" | "business" | "both";
export type RevenueModel = "one_off" | "subscription" | "commission" | "recruitment";
export type InputKey = "customers" | "price" | "variable_cost" | "fixed_month";

/** The estimates, in tie order. The price is a decision, shown as a lever but never ranked. */
export const RISK_ORDER: readonly InputKey[] = ["customers", "variable_cost", "fixed_month"];

/** Why the riskiest is the riskiest. */
export type RiskBasis = "unknown" | "least_room" | "above_sector";

export interface Plan {
  currency: string;
  price_minor: number;
  variable_cost_minor: number;
  /** Null: "I don't know" (rule 5) — a gap, never a zero. */
  customers_month: number | null;
  fixed_month_minor: number;
  startup_minor: number;
  capital_minor: number;
  ramp_months: number;
}

export interface Lever {
  key: InputKey;
  /** What was stated: a count for customers, minor units otherwise. */
  stated: number;
  /** The value at which a full month just covers itself, holding the rest. */
  breaking_point: number;
  /** How far the breaking point is from what was stated, in basis points of it; negative when already past it. */
  room_bp: number;
}

export interface CashPath {
  /** Month 0 is the day after start-up costs are paid. */
  start_minor: number;
  lowest_minor: number;
  lowest_month: number;
  /** First month the cash goes below zero; null when it never does within the horizon. */
  runs_out_month: number | null;
  /** First month that covers its own costs; null when none does within the horizon. */
  covers_costs_month: number | null;
  /** More money needed to never go below zero: −lowest, or 0. */
  shortfall_minor: number;
  end_minor: number;
}

export type IdeaMoney =
  | { status: "loses_per_sale"; contribution_minor: number }
  | {
      status: "worked";
      contribution_minor: number;
      break_even_customers: number;
      /** Null when the customers aren't known. */
      at_plan: { revenue_minor: number; profit_minor: number; margin_bp: number | null } | null;
      cash: CashPath | null;
      levers: Lever[];
      riskiest: InputKey;
      riskiest_basis: RiskBasis;
      /** True when a full month at plan doesn't cover itself: no input has room, every lever is a target. */
      short_at_plan: boolean;
    };

const ceilDiv = (a: number, b: number) => Math.floor((a + b - 1) / b);

/** Sales in month m (1-based) of a straight ramp to the plan over `ramp` months, rounded down. */
export function salesInMonth(customers: number, m: number, ramp: number): number {
  const r = Math.max(1, ramp);
  return Math.floor((customers * Math.min(m, r)) / r);
}

export function cashPath(p: Plan & { customers_month: number }): CashPath {
  const contribution = p.price_minor - p.variable_cost_minor;
  const start = p.capital_minor - p.startup_minor;
  let cash = start;
  let lowest = start;
  let lowestMonth = 0;
  let runsOut: number | null = start < 0 ? 0 : null;
  let covers: number | null = null;
  for (let m = 1; m <= HORIZON_MONTHS; m++) {
    const profit =
      salesInMonth(p.customers_month, m, p.ramp_months) * contribution - p.fixed_month_minor;
    if (covers === null && profit >= 0) covers = m;
    cash += profit;
    if (cash < lowest) {
      lowest = cash;
      lowestMonth = m;
    }
    if (runsOut === null && cash < 0) runsOut = m;
  }
  return {
    start_minor: start,
    lowest_minor: lowest,
    lowest_month: lowestMonth,
    runs_out_month: runsOut,
    covers_costs_month: covers,
    shortfall_minor: lowest < 0 ? -lowest : 0,
    end_minor: cash,
  };
}

/** Room as basis points of the stated value; a stated zero has no room to measure. */
function room(stated: number, breaking: number, falling: boolean): number | null {
  if (stated === 0) return null;
  return falling ? ratioBp(stated - breaking, stated) : ratioBp(breaking - stated, stated);
}

/** Each input's breaking point at full plan, holding the rest as stated. */
export function levers(p: Plan & { customers_month: number }): Lever[] {
  const c = p.customers_month;
  const contribution = p.price_minor - p.variable_cost_minor;
  const fixedPerCustomer = ceilDiv(p.fixed_month_minor, c);
  const out: Lever[] = [];
  const push = (key: InputKey, stated: number, breaking: number, falling: boolean) => {
    const r = room(stated, breaking, falling);
    if (r !== null) out.push({ key, stated, breaking_point: breaking, room_bp: r });
  };
  push("customers", c, ceilDiv(p.fixed_month_minor, Math.max(contribution, 1)), true);
  push("price", p.price_minor, p.variable_cost_minor + fixedPerCustomer, true);
  push("variable_cost", p.variable_cost_minor, p.price_minor - fixedPerCustomer, false);
  push("fixed_month", p.fixed_month_minor, c * contribution, false);
  return out;
}

/** Pure: rule 38. Among the estimates, the least room wins; ties in RISK_ORDER. */
export function riskiestOf(ls: readonly Lever[]): InputKey {
  let best: Lever | null = null;
  for (const key of RISK_ORDER) {
    const l = ls.find((x) => x.key === key);
    if (l && (best === null || l.room_bp < best.room_bp)) best = l;
  }
  return best?.key ?? "customers";
}

export function workMoney(p: Plan): IdeaMoney {
  const contribution = p.price_minor - p.variable_cost_minor;
  if (contribution <= 0) return { status: "loses_per_sale", contribution_minor: contribution };
  const breakEven = Math.max(1, ceilDiv(p.fixed_month_minor, contribution));
  if (p.customers_month === null) {
    return {
      status: "worked",
      contribution_minor: contribution,
      break_even_customers: breakEven,
      at_plan: null,
      cash: null,
      levers: [],
      riskiest: "customers",
      riskiest_basis: "unknown",
      short_at_plan: false,
    };
  }
  const known = { ...p, customers_month: p.customers_month };
  const revenue = p.customers_month * p.price_minor;
  const profit = p.customers_month * contribution - p.fixed_month_minor;
  const ls = levers(known);
  return {
    status: "worked",
    contribution_minor: contribution,
    break_even_customers: breakEven,
    at_plan: {
      revenue_minor: revenue,
      profit_minor: profit,
      margin_bp: revenue > 0 ? ratioBp(profit, revenue) : null,
    },
    cash: cashPath(known),
    levers: ls,
    riskiest: riskiestOf(ls),
    riskiest_basis: "least_room",
    short_at_plan: profit < 0,
  };
}
