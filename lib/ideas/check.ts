// The idea check, end to end — TASKS-IDEAS.md I-20..I-41. The answers are
// checked against specs/idea-v1.json, worked through (./model, ./sector),
// given their cheapest next test with pass and fail set now (rule 41), and
// kept under a share token. No account, no model call, no network.

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { ideaChecks } from "../../db/schema";
import ideaFile from "../../specs/idea-v1.json";
import benchmarkMap from "../../specs/benchmark-map-v1.json";
import { benchEnglish } from "../benchmarks/map";
import type { AppLocale } from "../i18n/locales";
import { isAppLocale } from "../i18n/locales";
import type { Words } from "../i18n/request-words";
import type { CustomerKind, IdeaMoney, InputKey, Plan, RevenueModel } from "./model";
import { workMoney } from "./model";
import type { SectorLine, Survival } from "./sector";
import { sectorLines, survivalFor } from "./sector";
import { toMinor } from "./units";
import type { Local } from "./local";
import { isCityOf, localFor } from "./local";

export { toMinor };

export class IdeaError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "IdeaError";
    this.status = status;
  }
}

export const BUSINESS_TYPES = Object.keys(
  (benchmarkMap as { business_types: Record<string, unknown> }).business_types,
);
export const CUSTOMERS = ["consumer", "business", "both"] as const;
export const REVENUE_MODELS = ["one_off", "subscription", "commission", "recruitment"] as const;
export const CURRENCIES: readonly string[] = ideaFile.currencies;
export const RAMPS = ["1", "3", "6", "12"] as const;
export const IDEA_COUNTRIES = [
  ...(benchmarkMap as { countries: { eu27: string[] } }).countries.eu27.map((c) =>
    c === "EL" ? "GR" : c,
  ),
  "CH",
  "NO",
  "IS",
  "GB",
];
const MAX_MAJOR = ideaFile.max_amount_major;

export interface IdeaAnswers {
  sector: string;
  country: string;
  customer: CustomerKind;
  revenue_model: RevenueModel;
  currency: string;
  /** Whole units of `currency`, as typed; null for a recruitment-based model. */
  price: number | null;
  variable_cost: number | null;
  /** Null: "I don't know" (rule 5). */
  customers_month: number | null;
  fixed_month: number | null;
  startup: number | null;
  capital: number | null;
  team: number | null;
  ramp_months: number | null;
  /** D98: the chosen city (its Wikidata id, from the local snapshot), or null for "somewhere else". */
  city?: string | null;
}

export type NextTest =
  | { id: "presale"; weeks: number; pass_at_least: number; fail_below: number; break_even: number }
  | {
      id: "pilots";
      weeks: number;
      conversations: number;
      pass_at_least: number;
      fail_at_most: number;
    }
  | {
      id: "quotes";
      weeks: number;
      quotes: number;
      cost: InputKey;
      pass_at_most_minor: number;
      fail_at_least_minor: number;
    };

export type IdeaResult =
  | { status: "recruitment" }
  | {
      status: "worked";
      currency: string;
      team: number;
      money: IdeaMoney;
      survival: Survival;
      margin: SectorLine | null;
      per_person: SectorLine | null;
      /** D98: places of the same kind mapped nearby, a floor (rule 37). */
      local: Local;
      /** Null when the plan doesn't cover itself on paper: the levers come first. */
      test: NextTest | null;
    };

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

function oneOf<T extends string>(v: unknown, list: readonly T[], what: string): T {
  if (typeof v !== "string" || !list.includes(v as T)) throw new IdeaError(`choose ${what}`);
  return v as T;
}

/** Pure: the answers as the spec allows them, or why not. */
export function checkIdeaAnswers(raw: unknown): IdeaAnswers {
  if (typeof raw !== "object" || raw === null) throw new IdeaError("no answers", 400);
  const a = raw as Record<string, unknown>;
  const sector = oneOf(a.sector, BUSINESS_TYPES, "the kind of business");
  const country = oneOf(a.country, IDEA_COUNTRIES, "a country");
  const customer = oneOf(a.customer, CUSTOMERS, "who buys");
  const revenue_model = oneOf(a.revenue_model, REVENUE_MODELS, "how money comes in");
  const currency = oneOf(a.currency, CURRENCIES, "a currency");
  const city = typeof a.city === "string" && a.city !== "" ? a.city : null;
  if (city !== null && !isCityOf(country, city)) throw new IdeaError("choose a city from the list");
  const base = { sector, country, customer, revenue_model, currency, city };
  if (revenue_model === "recruitment") {
    return {
      ...base,
      price: null,
      variable_cost: null,
      customers_month: null,
      fixed_month: null,
      startup: null,
      capital: null,
      team: null,
      ramp_months: null,
    };
  }
  const amount = (k: string, min: number) => {
    if (!isInt(a[k], min, MAX_MAJOR))
      throw new IdeaError(`give ${k.replace(/_/g, " ")} as a whole amount`);
    return a[k] as number;
  };
  const customers = a.customers_month;
  if (customers !== null && !isInt(customers, 1, 1_000_000)) {
    throw new IdeaError("give the customers a month as a whole number, or say you don't know");
  }
  if (!isInt(a.team, 1, 500)) throw new IdeaError("give the team as a whole number from 1");
  const ramp = Number(oneOf(String(a.ramp_months), RAMPS, "how long until full sales"));
  return {
    ...base,
    price: amount("price", 1),
    variable_cost: amount("variable_cost", 0),
    customers_month: customers as number | null,
    fixed_month: amount("fixed_month", 0),
    startup: amount("startup", 0),
    capital: amount("capital", 0),
    team: a.team as number,
    ramp_months: ramp,
  };
}

/** A share (basis points) of a count, rounded up, at least 1. */
const shareOf = (count: number, bp: number) =>
  Math.max(1, Math.floor((count * bp + 9_999) / 10_000));

/** Pure: rule 41 — the test for the riskiest input, its thresholds worked out from the plan now. */
export function nextTest(money: IdeaMoney, customer: CustomerKind): NextTest | null {
  if (money.status !== "worked" || money.short_at_plan) return null;
  const t = ideaFile.tests;
  const key = money.riskiest;
  if (key === "customers") {
    if (customer === "consumer") {
      const be = money.break_even_customers;
      return {
        id: "presale",
        weeks: t.presale.weeks,
        break_even: be,
        pass_at_least: shareOf(be, t.presale.pass_share_of_break_even_bp),
        fail_below: shareOf(be, t.presale.fail_below_share_of_break_even_bp),
      };
    }
    return {
      id: "pilots",
      weeks: t.pilots.weeks,
      conversations: t.pilots.conversations,
      pass_at_least: t.pilots.pass_at_least,
      fail_at_most: t.pilots.fail_at_most,
    };
  }
  const lever = money.levers.find((l) => l.key === key)!;
  return {
    id: "quotes",
    weeks: t.quotes.weeks,
    quotes: t.quotes.quotes,
    cost: key,
    pass_at_most_minor: lever.stated,
    fail_at_least_minor: lever.breaking_point,
  };
}

/** Pure but for the snapshots: the whole result for these answers. */
export function evaluateIdea(a: IdeaAnswers, w: Words = benchEnglish()): IdeaResult {
  if (a.revenue_model === "recruitment") return { status: "recruitment" };
  const c = a.currency;
  const plan: Plan = {
    currency: c,
    price_minor: toMinor(a.price!, c),
    variable_cost_minor: toMinor(a.variable_cost!, c),
    customers_month: a.customers_month,
    fixed_month_minor: toMinor(a.fixed_month!, c),
    startup_minor: toMinor(a.startup!, c),
    capital_minor: toMinor(a.capital!, c),
    ramp_months: a.ramp_months!,
  };
  let money = workMoney(plan);
  const atPlan = money.status === "worked" ? money.at_plan : null;
  const lines = sectorLines({
    typeCode: a.sector,
    iso: a.country,
    team: a.team!,
    currency: c,
    at_plan: atPlan,
    w,
  });
  // D94: a plan that needs more revenue per person than the sector makes rests on its customers.
  if (money.status === "worked" && lines.per_person?.reading === "above") {
    money = { ...money, riskiest: "customers", riskiest_basis: "above_sector" };
  }
  return {
    status: "worked",
    currency: c,
    team: a.team!,
    money,
    survival: survivalFor(a.sector, a.country, w),
    margin: lines.margin,
    per_person: lines.per_person,
    local: localFor(a.sector, a.country, a.city ?? null),
    test: nextTest(money, a.customer),
  };
}

function newToken(): string {
  return randomBytes(12).toString("base64url");
}

/** Check, work through, keep. */
export async function runIdea(args: {
  answers: unknown;
  locale: string;
  words?: Words;
}): Promise<{ token: string; result: IdeaResult; answers: IdeaAnswers }> {
  const answers = checkIdeaAnswers(args.answers);
  const result = evaluateIdea(answers, args.words);
  const locale: AppLocale = isAppLocale(args.locale) ? args.locale : "en";
  const token = newToken();
  await db.insert(ideaChecks).values({ token, answers, result, locale });
  return { token, result, answers };
}

/** A shared idea check, as it was when it was made. */
export async function ideaByToken(token: string): Promise<{
  answers: IdeaAnswers;
  result: IdeaResult;
  created_at: string;
  /** Kept as an idea business already (part 2): it can't be kept twice. */
  kept: boolean;
} | null> {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) return null;
  const [row] = await db.select().from(ideaChecks).where(eq(ideaChecks.token, token)).limit(1);
  if (!row) return null;
  return {
    answers: row.answers as IdeaAnswers,
    result: row.result as IdeaResult,
    created_at: row.created_at,
    kept: row.profile_id !== null,
  };
}
