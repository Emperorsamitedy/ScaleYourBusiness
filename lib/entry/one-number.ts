// The free one-number entry — the v1 build spec §8.1 stage 1 and §8.2
// (P7-70).
//
// Six questions, no account, no connector, no model call: a result in
// milliseconds, well inside §8.6's ten seconds. What it gives:
//   · one leak, named, with a euro range and its grade — always D here,
//     "your estimate": the rates are rule-of-thumb assumptions held as data
//     (specs/entry-v1.json), shown with what they rest on
//   · one peer comparison from the live cohort (lib/peers), described in
//     words, or "not enough yet" — the same floor as everywhere
//   · one sentence on what measuring it would take
//   · a share link, and the referral chain (§5.6) when it came from one
// The lead record holds the answers and the result, never a person: no
// name, no email, nothing to sign up for before the result (§8.2).

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { entryLeads } from "../../db/schema";
import benchmarkMap from "../../specs/benchmark-map-v1.json";
import entryFile from "../../specs/entry-v1.json";
import { isAppLocale } from "../i18n/locales";
import type { AppLocale } from "../i18n/locales";
import { roundMinorTo, scaleMinorBy } from "../core/money";
import type { AnonymousComparison } from "../peers/benchmark";
import { anonymousComparison } from "../peers/benchmark";
import { naceOfType, precisionOf } from "../peers/cohort";

const SPEC = entryFile as unknown as {
  monthly_revenue_bands: Record<
    string,
    { from: number; to: number | null; year_band: string } | string
  >;
  sector_groups: Record<string, string[] | string>;
  operations: Record<string, { question: string; options: string[] }>;
  leaks: {
    rules: {
      id: string;
      when: { operations?: string[]; channel?: string[] };
      low_bp: number;
      high_bp: number;
      measure: string;
    }[];
  };
  questions: { id: string; options?: string[]; min?: number; max?: number }[];
};

/** The bank's business types (benchmark-map-v1.json), the sector question's options. */
export const BUSINESS_TYPES = Object.keys(
  (benchmarkMap as { business_types: Record<string, unknown> }).business_types,
);

export const REVENUE_BANDS = SPEC.questions.find((q) => q.id === "revenue_band")!.options!;
export const CHANNELS = SPEC.questions.find((q) => q.id === "channel")!.options!;
const EMPLOYEES = SPEC.questions.find((q) => q.id === "employees")!;

export class EntryError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "EntryError";
    this.status = status;
  }
}

export interface EntryAnswers {
  /** A business type from the bank's vocabulary (benchmark-map-v1.json). */
  sector: string;
  /** ISO alpha-2. */
  country: string;
  revenue_band: string;
  employees: number;
  channel: string;
  /** The answer to the sector's own operations question. */
  operations: string;
}

export type SectorGroup = "hospitality" | "appointments" | "retail" | "services";

/** Pure: which operations question a business type gets. */
export function sectorGroupOf(sector: string): SectorGroup {
  for (const [group, types] of Object.entries(SPEC.sector_groups)) {
    if (group !== "about" && Array.isArray(types) && types.includes(sector))
      return group as SectorGroup;
  }
  return "services";
}

/** Pure: the sector's operations question and its options. */
export function operationsQuestion(sector: string): {
  group: SectorGroup;
  question: string;
  options: string[];
} {
  const group = sectorGroupOf(sector);
  return { group, ...SPEC.operations[group]! };
}

function band(id: string) {
  const b = SPEC.monthly_revenue_bands[id];
  if (!b || typeof b === "string") throw new EntryError("pick a revenue band");
  return b;
}

/** Pure: the answers, checked against the question bank's own options (rule 4). */
export function checkAnswers(raw: unknown): EntryAnswers {
  const a = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
  const sector = str("sector");
  if (!BUSINESS_TYPES.includes(sector)) throw new EntryError("pick a kind of business");
  const country = str("country").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new EntryError("pick a country");
  const revenue_band = str("revenue_band");
  if (!REVENUE_BANDS.includes(revenue_band)) throw new EntryError("pick a revenue band");
  const employees = a.employees;
  if (
    typeof employees !== "number" ||
    !Number.isSafeInteger(employees) ||
    employees < (EMPLOYEES.min ?? 1) ||
    employees > (EMPLOYEES.max ?? 500)
  ) {
    throw new EntryError("say how many people work there");
  }
  const channel = str("channel");
  if (!CHANNELS.includes(channel)) throw new EntryError("pick where most customers find you");
  const operations = str("operations");
  if (!operationsQuestion(sector).options.includes(operations))
    throw new EntryError("answer the last question");
  return { sector, country, revenue_band, employees, channel, operations };
}

export interface EntryLeak {
  id: string;
  /** Euro cents a month. */
  low_minor: number;
  high_minor: number;
  currency: "EUR";
  /** §8.2: always D at this stage — "your estimate". */
  grade: "D";
  /** The assumption it rests on: a share of monthly revenue, in basis points. */
  basis: { low_bp: number; high_bp: number; band: string };
  /** What would turn it into a measured number. */
  measure: string;
}

/** Pure: the band's monthly midpoint in euro cents (an open band: 1.5 × its floor). */
export function bandMidpoint(id: string): number {
  const b = band(id);
  return b.to === null ? scaleMinorBy(b.from, 3, 2) : scaleMinorBy(b.from + b.to, 1, 2);
}

/** Pure: the one leak, from the first rule that holds. */
export function oneLeak(a: EntryAnswers): EntryLeak {
  const rule = SPEC.leaks.rules.find(
    (r) =>
      (!r.when.operations || r.when.operations.includes(a.operations)) &&
      (!r.when.channel || r.when.channel.includes(a.channel)),
  )!;
  const mid = bandMidpoint(a.revenue_band);
  const at = (bp: number) => roundMinorTo(scaleMinorBy(mid, bp, 10_000), 1_000);
  return {
    id: rule.id,
    low_minor: at(rule.low_bp),
    high_minor: at(rule.high_bp),
    currency: "EUR",
    grade: "D",
    basis: { low_bp: rule.low_bp, high_bp: rule.high_bp, band: a.revenue_band },
    measure: rule.measure,
  };
}

export interface EntryResult {
  leak: EntryLeak;
  comparison: AnonymousComparison;
  /** The visitor's own revenue per person, estimated from the band: compared, never pooled. */
  own_minor: number;
}

/** Pure + the cohort read: the whole result for these answers. */
export async function evaluateEntry(a: EntryAnswers, now = new Date()): Promise<EntryResult> {
  const leak = oneLeak(a);
  const nace = naceOfType(a.sector);
  const mid = bandMidpoint(a.revenue_band);
  const own = scaleMinorBy(mid, 1, a.employees);
  const comparison: AnonymousComparison = nace
    ? await anonymousComparison({
        nace,
        country: a.country,
        band: band(a.revenue_band).year_band,
        metric: "revenue_per_employee",
        currency: "EUR",
        // The visitor's own estimate, compared and never pooled.
        own,
        now,
      })
    : {
        status: "not_enough",
        metric: "revenue_per_employee",
        month: "",
        source: "syb_peer_cohort",
        as_of: "",
      };
  return { leak, comparison, own_minor: own };
}

/** A share token: unguessable, URL-safe, short. */
function newToken(): string {
  return randomBytes(12).toString("base64url");
}

/**
 * §8.1 stage 1: answer, record the lead, return the result and its share
 * token. `ref` is the share token the visitor arrived from, if any.
 */
export async function runEntry(args: {
  answers: unknown;
  locale: string;
  ref?: string | null;
  now?: Date;
}): Promise<{ token: string; result: EntryResult; answers: EntryAnswers }> {
  const answers = checkAnswers(args.answers);
  const result = await evaluateEntry(answers, args.now);
  const locale: AppLocale = isAppLocale(args.locale) ? args.locale : "en";
  let referredBy: string | null = null;
  if (args.ref) {
    const [from] = await db
      .select({ id: entryLeads.id })
      .from(entryLeads)
      .where(eq(entryLeads.token, args.ref))
      .limit(1);
    referredBy = from?.id ?? null;
  }
  const token = newToken();
  await db.insert(entryLeads).values({ token, answers, result, locale, referred_by: referredBy });
  return { token, result, answers };
}

/** A shared result, as it was when it was made. */
export async function entryByToken(
  token: string,
): Promise<{ answers: EntryAnswers; result: EntryResult; created_at: string } | null> {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) return null;
  const [row] = await db.select().from(entryLeads).where(eq(entryLeads.token, token)).limit(1);
  if (!row) return null;
  const result = row.result as EntryResult;
  const c = result.comparison;
  // A result saved before D90 has no precision; it follows from what was saved.
  if (c.status === "served" && !(c as Partial<typeof c>).precision) {
    c.precision = precisionOf(c.cohort.businesses, c.cohort.widened);
  }
  return { answers: row.answers as EntryAnswers, result, created_at: row.created_at };
}

/** §5.6: how far a shared result travelled — the leads that came from it, and theirs. */
export async function referralChain(token: string, maxDepth = 5): Promise<number> {
  const [root] = await db
    .select({ id: entryLeads.id })
    .from(entryLeads)
    .where(eq(entryLeads.token, token));
  if (!root) return 0;
  let frontier = [root.id];
  let total = 0;
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const rows = await db
        .select({ id: entryLeads.id })
        .from(entryLeads)
        .where(eq(entryLeads.referred_by, id));
      next.push(...rows.map((r) => r.id));
    }
    total += next.length;
    frontier = next;
  }
  return total;
}
