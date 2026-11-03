// The report service — Session G (P1-34..39) / build-sequence steps 44-46.
//
// A report reads a SNAPSHOT, not the live profile (P1-34): generation
// pins the snapshot id, and every later read renders from that frozen
// state. The cost guard is structural: if the latest report's snapshot
// matches the profile's current content hash, generation RETURNS THE
// EXISTING REPORT — the two Opus calls (~€0.12 measured) cannot be spent
// twice on identical facts.
//
// Responses (P1-38/39) mutate the recommendation's status in the report
// row — the current view — and append to the decision log in the same
// transaction — the history. The reason chips' text is the training
// corpus for every later proposal; it is stored verbatim in the log
// payload, hashed on the row.
//
// Phase 2 (P2-10/11): a connector measurement is labelled "measured", and
// where it superseded something the owner said, the economics block
// carries both figures (rule 11) rather than silently swapping them.
//
// P2-30: the trading-hours findings ride beside the economics as their
// own deterministic block, computed from measured hourly sales at
// generation and frozen on the row with the report.
//
// P5-13: the site audit's measured findings (lib/site/audit) join the
// findings list itself, marked `kind: "measured"`, citing presence.site_audit.
//
// I-44a: a large benchmark gap (lib/benchmarks/gap) joins it too, marked
// `kind: "benchmark"`, citing the margin's own fact keys. Neither prompt's
// text changes: the recommendations model reads it in its FINDINGS list.

import { logSafeError } from "../core/log-safe";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { accounts, businessProfiles, decisionLog, diagnosisReports } from "../../db/schema";
import { displaySourceKind } from "../connectors/measured";
import { statedVsMeasured } from "../connectors/stated-vs-measured";
import { format, money } from "../core/money";
import { computeEconomics } from "../economics/unit-economics";
import type { EconomicsResult } from "../economics/unit-economics";
import type { DiagnosisFinding, DiagnosisLlm } from "../diagnosis/findings";
import { DiagnosisError, runDiagnosis, sortFindings } from "../diagnosis/findings";
import type { Recommendation, RecommendationsLlm } from "../diagnosis/recommendations";
import { runRecommendations } from "../diagnosis/recommendations";
import type { TradingHoursBlock } from "../hours/findings";
import { tradingFindings } from "../hours/findings";
import { tradingAnalysis } from "../hours/trading";
import { displayValue, gapBuys, readSupersededFacts, sourceDetail } from "../profile/factsheet";
import type { FactHistory, GapRow } from "../profile/factsheet";
import { ensureSnapshot, readSnapshot } from "../profile/snapshot";
import { computeCompleteness } from "../scorer/completeness";
import { reportGapFinding } from "../benchmarks/gap-read";
import { SITE_AUDIT_KEY } from "../site/audit/findings";
import { siteFindingsForReport } from "../site/audit/service";
import { recordFunnelEvent } from "../intake/telemetry";
import { applicableQuestions } from "../resolver/applicability";

export type RecommendationResponse = "look_into" | "not_for_us";

export interface StoredRecommendation extends Recommendation {
  status: "proposed" | "accepted" | "rejected";
  rejection_reason: string | null;
}

export interface ReportView {
  id: string;
  profile_id: string;
  snapshot_id: string;
  generated_at: string;
  summary: string;
  completeness: number;
  cost_eur: number;
  unit_economics: EconomicsResult;
  findings: DiagnosisFinding[];
  recommendations: StoredRecommendation[];
  data_gaps: GapRow[];
  /** P2-30: null when no stated hours or no hourly sales are measured. */
  trading_hours: TradingHoursBlock | null;
  /** Evidence rendering (P1-36): key → value/status/confidence/source. */
  fact_map: Record<
    string,
    {
      value: string | null;
      status: string;
      confidence: number;
      source_kind: string;
      /** When the fact was true, a question id / URL / method, and any note — printed beside it. */
      observed_at: string;
      source_detail: string | null;
      note: string | null;
    }
  >;
  /**
   * The derivation sheet's "history": every superseded record of the
   * profile's facts, by key, newest first (rule 3 — superseded, never
   * erased). Read at view time, so a correction made after the report
   * was issued still shows against the figure it would have changed.
   */
  history: FactHistory;
  /** The report issued before this one, for the "prior" column; null when this is the first. */
  prior: PriorReport | null;
}

export interface PriorReport {
  id: string;
  generated_at: string;
  unit_economics: EconomicsResult;
}

async function factMap(snapshotId: string): Promise<ReportView["fact_map"]> {
  const view = await readSnapshot(snapshotId);
  const out: ReportView["fact_map"] = {};
  for (const [key, f] of view.facts) {
    out[key] = {
      value: displayValue(f.value),
      status: f.status,
      confidence: f.confidence,
      source_kind: displaySourceKind(f.source),
      observed_at: f.observed_at,
      source_detail: sourceDetail(f.source),
      note: f.note ?? null,
    };
  }
  return out;
}

/** Pure: the prior-report slice of an earlier row, or null when there is none. */
export function priorOf(row: typeof diagnosisReports.$inferSelect | undefined): PriorReport | null {
  if (!row) return null;
  return {
    id: row.id,
    generated_at: row.generated_at,
    unit_economics: row.unit_economics as EconomicsResult,
  };
}

/** The report issued immediately before `row` for the same profile. */
async function priorReport(row: typeof diagnosisReports.$inferSelect): Promise<PriorReport | null> {
  const rows = await db
    .select()
    .from(diagnosisReports)
    .where(eq(diagnosisReports.profile_id, row.profile_id))
    .orderBy(desc(diagnosisReports.generated_at))
    .limit(12);
  const at = rows.findIndex((r) => r.id === row.id);
  return priorOf(at >= 0 ? rows[at + 1] : undefined);
}

async function viewOf(row: typeof diagnosisReports.$inferSelect): Promise<ReportView> {
  const [facts, history, prior] = await Promise.all([
    factMap(row.snapshot_id),
    readSupersededFacts(row.profile_id),
    priorReport(row),
  ]);
  return rowToView(row, facts, history, prior);
}

function rowToView(
  row: typeof diagnosisReports.$inferSelect,
  facts: ReportView["fact_map"],
  history: FactHistory,
  prior: PriorReport | null,
): ReportView {
  return {
    id: row.id,
    profile_id: row.profile_id,
    snapshot_id: row.snapshot_id,
    generated_at: row.generated_at,
    summary: row.summary,
    completeness: Number(row.completeness),
    cost_eur: Number(row.cost_eur),
    unit_economics: row.unit_economics as EconomicsResult,
    findings: row.findings as DiagnosisFinding[],
    recommendations: row.recommendations as StoredRecommendation[],
    data_gaps: row.data_gaps as GapRow[],
    trading_hours: (row.trading_hours as TradingHoursBlock | null) ?? null,
    fact_map: facts,
    history,
    prior,
  };
}

export async function latestReport(profileId: string): Promise<ReportView | null> {
  const [row] = await db
    .select()
    .from(diagnosisReports)
    .where(eq(diagnosisReports.profile_id, profileId))
    .orderBy(desc(diagnosisReports.generated_at))
    .limit(1);
  if (!row) return null;
  return viewOf(row);
}

/**
 * One report by id, only if it belongs to this profile — what a shared link
 * (idea 51, lib/report/share.ts) renders: the report the link was made for,
 * never whichever is latest.
 */
export async function reportForProfile(
  profileId: string,
  reportId: string,
): Promise<ReportView | null> {
  const [row] = await db
    .select()
    .from(diagnosisReports)
    .where(and(eq(diagnosisReports.id, reportId), eq(diagnosisReports.profile_id, profileId)));
  if (!row) return null;
  return viewOf(row);
}

/**
 * Generate — or return the report that already covers this exact profile
 * state. The Opus spend happens at most once per snapshot content.
 */
export async function generateReport(args: {
  accountId: string;
  profileId: string;
  findingsLlm?: DiagnosisLlm;
  recommendationsLlm?: RecommendationsLlm;
}): Promise<{ report: ReportView; fresh: boolean }> {
  const snapshot = await ensureSnapshot(args.profileId, "report");

  const [existing] = await db
    .select()
    .from(diagnosisReports)
    .where(eq(diagnosisReports.profile_id, args.profileId))
    .orderBy(desc(diagnosisReports.generated_at))
    .limit(1);
  if (existing && existing.snapshot_id === snapshot.id) {
    return { report: await viewOf(existing), fresh: false };
  }

  // The expensive part — findings, then recommendations addressing them.
  const diagnosis = await runDiagnosis({
    accountId: args.accountId,
    profileId: args.profileId,
    ...(args.findingsLlm ? { llm: args.findingsLlm } : {}),
  });
  // P5-13: the site audit's measured findings ride beside the model's —
  // from the audit the snapshot's presence.site_audit fact names, each
  // citing that fact (P1-24), marked measured, severest first with the rest.
  const view = await readSnapshot(snapshot.id);
  let findings = diagnosis.findings;
  try {
    const measured = await siteFindingsForReport(view.facts.get(SITE_AUDIT_KEY), args.profileId);
    if (measured.length > 0) findings = sortFindings([...measured, ...diagnosis.findings]);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "report_site_audit_failed",
        account_id: args.accountId,
        profile_id: args.profileId,
        ...logSafeError(error),
      }),
    );
  }
  // I-44a: a large, like-for-like gap against Eurostat's figure for similar
  // businesses joins the findings the same way, as structured input marked
  // `kind: "benchmark"` — decided by lib/benchmarks/gap's stated threshold,
  // never by the model. Computed from the snapshot's facts, frozen on the row.
  try {
    const gap = await reportGapFinding(args.profileId, view.facts);
    if (gap) findings = sortFindings([gap, ...findings]);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "report_benchmark_gap_failed",
        account_id: args.accountId,
        profile_id: args.profileId,
        ...logSafeError(error),
      }),
    );
  }

  const recs = await runRecommendations({
    accountId: args.accountId,
    profileId: args.profileId,
    findings,
    ...(args.recommendationsLlm ? { llm: args.recommendationsLlm } : {}),
  });

  // The deterministic parts — economics and gaps, from the same snapshot.
  const [acct] = await db
    .select({ currency: accounts.reporting_currency })
    .from(businessProfiles)
    .innerJoin(accounts, eq(accounts.id, businessProfiles.account_id))
    .where(eq(businessProfiles.id, args.profileId));
  // Rule 11: where a connector superseded the owner's figure, carry both.
  const economics: EconomicsResult = {
    ...computeEconomics(view, acct?.currency ?? "EUR"),
    stated_vs_measured: await statedVsMeasured(snapshot.id),
  };

  const completeness = await computeCompleteness(args.profileId);
  const responded = new Set(
    [...view.facts.entries()]
      .filter(
        ([, f]) => f.status === "answered" || f.status === "inferred" || f.status === "unknown",
      )
      .map(([key]) => key),
  );
  const blocking = new Set(completeness.blocking_gaps);
  const gaps: GapRow[] = (await applicableQuestions(args.profileId))
    .filter((q) => !responded.has(q.writes_to))
    .map((q) => ({
      question_id: q.id,
      prompt:
        typeof (q.prompt as { en?: unknown })?.en === "string"
          ? (q.prompt as { en: string }).en
          : q.id,
      section: q.section,
      priority: q.priority,
      buys: gapBuys(q),
      blocking: blocking.has(q.writes_to),
    }))
    .sort((a, b) => Number(b.blocking) - Number(a.blocking))
    .slice(0, 8);

  // P2-30: deterministic, from measured hourly sales; never fails the report.
  let tradingHours: TradingHoursBlock | null = null;
  try {
    tradingHours = tradingFindings(
      await tradingAnalysis(args.profileId, new Date(), (m, c) => format(money(m, c))),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "report_trading_hours_failed",
        account_id: args.accountId,
        profile_id: args.profileId,
        ...logSafeError(error),
      }),
    );
  }

  const stored: StoredRecommendation[] = recs.recommendations.map((r) => ({
    ...r,
    status: "proposed",
    rejection_reason: null,
  }));

  const [row] = await db
    .insert(diagnosisReports)
    .values({
      profile_id: args.profileId,
      snapshot_id: snapshot.id,
      summary: diagnosis.summary,
      completeness: String(diagnosis.completeness),
      cost_eur: String(diagnosis.cost_eur + recs.cost_eur),
      unit_economics: economics,
      findings,
      recommendations: stored,
      data_gaps: gaps,
      trading_hours: tradingHours,
    })
    .returning();
  if (!row) throw new DiagnosisError("report insert failed");

  await recordFunnelEvent(args.profileId, "funnel_report_delivered");
  return { report: await viewOf(row), fresh: true };
}

/**
 * P1-38/39: the owner's answer to a recommendation. The report row holds
 * the current status; the decision log holds every response ever given,
 * append-only, reason verbatim in the hashed payload.
 */
export async function respondToRecommendation(args: {
  profileId: string;
  reportId: string;
  index: number;
  response: RecommendationResponse;
  reason?: string;
}): Promise<StoredRecommendation> {
  const [row] = await db
    .select()
    .from(diagnosisReports)
    .where(eq(diagnosisReports.id, args.reportId));
  if (!row || row.profile_id !== args.profileId) {
    throw new DiagnosisError("no such report for this profile");
  }
  const recs = row.recommendations as StoredRecommendation[];
  const rec = recs[args.index];
  if (!rec) throw new DiagnosisError(`no recommendation at index ${args.index}`);

  rec.status = args.response === "look_into" ? "accepted" : "rejected";
  rec.rejection_reason =
    args.response === "not_for_us" && args.reason && args.reason.trim() !== ""
      ? args.reason.trim()
      : null;

  const payload = {
    report_id: args.reportId,
    recommendation_index: args.index,
    recommendation_title: rec.title,
    response: args.response,
    reason: rec.rejection_reason,
  };

  await db.transaction(async (tx) => {
    await tx
      .update(diagnosisReports)
      .set({ recommendations: recs })
      .where(eq(diagnosisReports.id, args.reportId));
    await tx.insert(decisionLog).values({
      profile_id: args.profileId,
      actor: "owner",
      kind: args.response === "look_into" ? "approval" : "rejection",
      ref_id: `${args.reportId}#${args.index}`,
      payload_hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    });
  });

  await recordFunnelEvent(args.profileId, "funnel_recommendation_response", {
    response: args.response,
    recommendation_index: args.index,
  });

  return rec;
}
