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

import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { accounts, businessProfiles, decisionLog, diagnosisReports } from "../../db/schema";
import { computeEconomics } from "../economics/unit-economics";
import type { EconomicsResult } from "../economics/unit-economics";
import type { DiagnosisFinding, DiagnosisLlm } from "../diagnosis/findings";
import { DiagnosisError, runDiagnosis } from "../diagnosis/findings";
import type { Recommendation, RecommendationsLlm } from "../diagnosis/recommendations";
import { runRecommendations } from "../diagnosis/recommendations";
import { gapBuys, repr } from "../profile/factsheet";
import type { GapRow } from "../profile/factsheet";
import { ensureSnapshot, readSnapshot } from "../profile/snapshot";
import { computeCompleteness } from "../scorer/completeness";
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
  /** Evidence rendering (P1-36): key → value/status/confidence/source. */
  fact_map: Record<
    string,
    { value: string | null; status: string; confidence: number; source_kind: string }
  >;
}

async function factMap(snapshotId: string): Promise<ReportView["fact_map"]> {
  const view = await readSnapshot(snapshotId);
  const out: ReportView["fact_map"] = {};
  for (const [key, f] of view.facts) {
    out[key] = {
      value: repr(f.value),
      status: f.status,
      confidence: f.confidence,
      source_kind: (f.source as { kind?: string } | null)?.kind ?? "unknown",
    };
  }
  return out;
}

function rowToView(
  row: typeof diagnosisReports.$inferSelect,
  facts: ReportView["fact_map"],
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
    fact_map: facts,
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
  return rowToView(row, await factMap(row.snapshot_id));
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
    return { report: rowToView(existing, await factMap(existing.snapshot_id)), fresh: false };
  }

  // The expensive part — findings, then recommendations addressing them.
  const diagnosis = await runDiagnosis({
    accountId: args.accountId,
    profileId: args.profileId,
    ...(args.findingsLlm ? { llm: args.findingsLlm } : {}),
  });
  const recs = await runRecommendations({
    accountId: args.accountId,
    profileId: args.profileId,
    findings: diagnosis.findings,
    ...(args.recommendationsLlm ? { llm: args.recommendationsLlm } : {}),
  });

  // The deterministic parts — economics and gaps, from the same snapshot.
  const view = await readSnapshot(snapshot.id);
  const [acct] = await db
    .select({ currency: accounts.reporting_currency })
    .from(businessProfiles)
    .innerJoin(accounts, eq(accounts.id, businessProfiles.account_id))
    .where(eq(businessProfiles.id, args.profileId));
  const economics = computeEconomics(view, acct?.currency ?? "EUR");

  const completeness = await computeCompleteness(args.profileId);
  const responded = new Set(
    [...view.facts.entries()]
      .filter(([, f]) => f.status === "answered" || f.status === "inferred" || f.status === "unknown")
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
      findings: diagnosis.findings,
      recommendations: stored,
      data_gaps: gaps,
    })
    .returning();
  if (!row) throw new DiagnosisError("report insert failed");

  return { report: rowToView(row, await factMap(row.snapshot_id)), fresh: true };
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

  return rec;
}
