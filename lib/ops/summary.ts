// Ops summary — Session I (P1-51/53). The pilot's instrument panel:
// the funnel, where abandoners actually stopped, and what every account
// costs. All of it deterministic reads over telemetry tables — no model
// is consulted to describe our own operations (CLAUDE.md cost rule).
// Internal accounts (P3-40b) are left out of every figure here: the
// panel describes customers, and SYB is not one.

import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "../../db";
import { intakeEvents, llmCalls } from "../../db/schema";
import type { MediaStore } from "../content/media";
import { internalAccountIds, internalProfileIds } from "./internal";

export interface FunnelSummary {
  started: number;
  core_completed: number;
  report_delivered: number;
  responded: number;
  /** Of those who started, the share reaching each later stage. */
  conversion: { core: number; report: number; responded: number };
}

const share = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 1000) / 1000;

/** P1-52's stages, counted as distinct profiles. */
export async function funnelSummary(sinceIso: string): Promise<FunnelSummary> {
  const rows = await db
    .select({ profile_id: intakeEvents.profile_id, kind: intakeEvents.kind })
    .from(intakeEvents)
    .where(
      and(
        gte(intakeEvents.at, sinceIso),
        inArray(intakeEvents.kind, [
          "funnel_intake_started",
          "funnel_core_completed",
          "funnel_report_delivered",
          "funnel_recommendation_response",
        ]),
      ),
    );
  const internal = await internalProfileIds();
  const byKind = new Map<string, Set<string>>();
  for (const r of rows) {
    if (internal.has(r.profile_id)) continue;
    const set = byKind.get(r.kind) ?? new Set<string>();
    set.add(r.profile_id);
    byKind.set(r.kind, set);
  }
  const count = (k: string) => byKind.get(k)?.size ?? 0;
  const started = count("funnel_intake_started");
  const core = count("funnel_core_completed");
  const report = count("funnel_report_delivered");
  const responded = count("funnel_recommendation_response");
  return {
    started,
    core_completed: core,
    report_delivered: report,
    responded,
    conversion: {
      core: share(core, started),
      report: share(report, started),
      responded: share(responded, started),
    },
  };
}

export interface AbandonmentRow {
  question_id: string;
  /** Profiles whose LAST shown question this was, and who never finished core. */
  stalled_profiles: number;
}

/**
 * P1-53: where the trail stops. For every profile that started but never
 * completed core, take the last question it was shown; rank questions by
 * how many trails end on them. The top of this list is the question that
 * kills intakes — P0-88's successor feeds on it.
 */
export async function abandonmentSummary(sinceIso: string): Promise<AbandonmentRow[]> {
  const started = await db
    .select({ profile_id: intakeEvents.profile_id })
    .from(intakeEvents)
    .where(and(gte(intakeEvents.at, sinceIso), eq(intakeEvents.kind, "funnel_intake_started")));
  const completed = await db
    .select({ profile_id: intakeEvents.profile_id })
    .from(intakeEvents)
    .where(eq(intakeEvents.kind, "funnel_core_completed"));
  const done = new Set(completed.map((r) => r.profile_id));
  const internal = await internalProfileIds();
  const stalled = [...new Set(started.map((r) => r.profile_id))].filter(
    (p) => !done.has(p) && !internal.has(p),
  );
  if (stalled.length === 0) return [];

  const shown = await db
    .select({
      profile_id: intakeEvents.profile_id,
      question_id: intakeEvents.question_id,
      at: intakeEvents.at,
    })
    .from(intakeEvents)
    .where(and(inArray(intakeEvents.profile_id, stalled), eq(intakeEvents.kind, "question_shown")));

  const lastByProfile = new Map<string, { question_id: string; at: string }>();
  for (const r of shown) {
    if (r.question_id === null) continue;
    const prev = lastByProfile.get(r.profile_id);
    if (!prev || r.at > prev.at)
      lastByProfile.set(r.profile_id, { question_id: r.question_id, at: r.at });
  }
  const counts = new Map<string, number>();
  for (const { question_id } of lastByProfile.values()) {
    counts.set(question_id, (counts.get(question_id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([question_id, stalled_profiles]) => ({ question_id, stalled_profiles }))
    .sort((a, b) => b.stalled_profiles - a.stalled_profiles);
}

export interface AccountCostRow {
  account_id: string;
  calls: number;
  cost_eur: number;
  by_workload: Record<string, number>;
}

export interface CostSummary {
  total_eur: number;
  total_calls: number;
  by_workload: Record<string, number>;
  accounts: AccountCostRow[];
}

/** P1-51: what one onboarding truly costs — a query, not archaeology. */
export async function costSummary(sinceIso: string): Promise<CostSummary> {
  const rows = await db
    .select({
      account_id: llmCalls.account_id,
      workload: llmCalls.workload,
      cost_eur: llmCalls.cost_eur,
    })
    .from(llmCalls)
    .where(gte(llmCalls.at, sinceIso));
  const internal = await internalAccountIds();
  const customerRows = rows.filter((r) => !internal.has(r.account_id));

  const accounts = new Map<string, AccountCostRow>();
  const byWorkload: Record<string, number> = {};
  let total = 0;
  for (const r of customerRows) {
    const cost = Number(r.cost_eur);
    total += cost;
    byWorkload[r.workload] = (byWorkload[r.workload] ?? 0) + cost;
    const acc = accounts.get(r.account_id) ?? {
      account_id: r.account_id,
      calls: 0,
      cost_eur: 0,
      by_workload: {},
    };
    acc.calls += 1;
    acc.cost_eur += cost;
    acc.by_workload[r.workload] = (acc.by_workload[r.workload] ?? 0) + cost;
    accounts.set(r.account_id, acc);
  }
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return {
    total_eur: round(total),
    total_calls: customerRows.length,
    by_workload: Object.fromEntries(Object.entries(byWorkload).map(([k, v]) => [k, round(v)])),
    accounts: [...accounts.values()]
      .map((a) => ({
        ...a,
        cost_eur: round(a.cost_eur),
        by_workload: Object.fromEntries(
          Object.entries(a.by_workload).map(([k, v]) => [k, round(v)]),
        ),
      }))
      .sort((a, b) => b.cost_eur - a.cost_eur),
  };
}

/* ── P3-24d: Blob storage in the cost view ── */

/**
 * Vercel Blob's storage list price, in integer micro-dollars per GB-month
 * ($0.023/GB-month = 23 000 µ$), and what Hobby includes free (1 GB stored,
 * the figure P3-20c recorded from Vercel's pricing page on 2026-09-30).
 * _Verify at build_ against vercel.com/docs/vercel-blob/usage-and-pricing:
 * the per-GB price, whether a GB is 10^9 or 2^30 bytes there (10^9 is used
 * here), and the included amount on the plan production runs on. Transfer
 * and operations are billed separately and are not counted here — renders
 * are deleted once the platform has them (P3-20c), so storage stays small.
 */
export const BLOB_STORAGE_MICRO_USD_PER_GB_MONTH = 23_000;
export const BLOB_HOBBY_INCLUDED_BYTES = 1_000_000_000;
const BYTES_PER_GB = 1_000_000_000;

export type StorageSummary =
  | {
      known: true;
      store: MediaStore["kind"];
      objects: number;
      bytes: number;
      /** True when the listing stopped at its page cap: the figures are a floor. */
      truncated: boolean;
      /** bytes × the list price, a month of it, in integer micro-dollars (rule 1: no float money). */
      monthly_list_micro_usd: number;
      currency: "USD";
      within_hobby_included: boolean;
      price_micro_usd_per_gb_month: number;
    }
  | { known: false; reason: string };

/** Pure: a month of storing `bytes` at the list price, in micro-dollars, rounded up. */
export function blobMonthlyMicroUsd(bytes: number): number {
  return Math.ceil((bytes * BLOB_STORAGE_MICRO_USD_PER_GB_MONTH) / BYTES_PER_GB);
}

/**
 * What the media store holds and what that costs a month — read from the
 * store itself (MediaStore.usage), never estimated. A store that can't be
 * read (no BLOB_READ_WRITE_TOKEN here, Vercel unreachable) is "unknown",
 * never zero.
 */
export async function storageSummary(store?: MediaStore): Promise<StorageSummary> {
  try {
    const s = store ?? (await import("../content/media")).vercelBlobStore();
    const u = await s.usage();
    return {
      known: true,
      store: s.kind,
      objects: u.objects,
      bytes: u.bytes,
      truncated: u.truncated,
      monthly_list_micro_usd: blobMonthlyMicroUsd(u.bytes),
      currency: "USD",
      within_hobby_included: u.bytes <= BLOB_HOBBY_INCLUDED_BYTES,
      price_micro_usd_per_gb_month: BLOB_STORAGE_MICRO_USD_PER_GB_MONTH,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "ops_storage_unreadable",
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return {
      known: false,
      reason: "Blob storage couldn't be read here, so its size and cost are unknown.",
    };
  }
}
