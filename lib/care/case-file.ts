// The case file — P3-45 (Session J, alert mode).
//
// Everything the alert review (P3-46) may reason from, assembled by
// code, never by a model: where the business stood on day zero and
// where it stands now, every proposal with its decision, decline reason,
// execution and verdict, what the report found that nobody acted on,
// what was approved and never ran, what failed, what the anomaly layer
// saw, where the owner's figures and the measurements disagree, and
// which sources are missing. Every line carries an evidence id; the
// review may only cite ids that exist here, and code checks that it did.
//
// The case file freezes the profile it read (a snapshot, deduplicated
// by content hash), so a review can be reproduced from exactly the state
// it saw — the report's own discipline.

import { createHash } from "node:crypto";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  anomalies,
  businessProfiles,
  connections,
  diagnosisReports,
  executions,
  proposals,
  validationFindings,
  watchActivity,
} from "../../db/schema";
import { statedVsMeasured } from "../connectors/stated-vs-measured";
import type { DiagnosisFinding } from "../diagnosis/findings";
import { diffSnapshots, ensureSnapshot } from "../profile/snapshot";
import type { StoredRecommendation } from "../report/service";
import { readbackForProposal } from "../trust/readback";
import { dailySeries, shiftDay, windowStat } from "../trust/series";
import { careState } from "./day-zero";
import { GOAL_METRICS, readGoalMeasure } from "./goal-measure";
import { readCurrentField } from "../profile/field-store";

export const CASE_SECTIONS = [
  "goal",
  "day_zero",
  "metrics",
  "proposals",
  "unaddressed",
  "approved_not_executed",
  "executions",
  "anomalies",
  "stated_vs_measured",
  "open_questions",
  "sources",
  "progress",
] as const;
export type CaseSection = (typeof CASE_SECTIONS)[number];

export interface CaseLine {
  /** The evidence id the review must cite, e.g. "proposal:<uuid>". */
  id: string;
  section: CaseSection;
  text: string;
}

export interface CaseFile {
  profile_id: string;
  goal_id: string;
  built_at: string;
  day_zero: string | null;
  /** The profile as the case file read it. */
  snapshot_id: string;
  lines: CaseLine[];
  /** sha256 over the rendered lines — what a stored review is tied to. */
  hash: string;
}

/** Proposals listed in full; older ones are counted, not listed. */
export const CASE_LIMITS = { max_proposals: 120 } as const;

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "—");
const pct = (from: number, to: number) =>
  from === 0 ? "n/a" : `${to >= from ? "+" : ""}${Math.round(((to - from) / from) * 1000) / 10}%`;

export function renderCaseFile(file: Pick<CaseFile, "lines">): string {
  const out: string[] = [];
  for (const section of CASE_SECTIONS) {
    const lines = file.lines.filter((l) => l.section === section);
    if (lines.length === 0) continue;
    out.push(`## ${section}`);
    for (const line of lines) out.push(`[${line.id}] ${line.text}`);
    out.push("");
  }
  return out.join("\n").trim();
}

export async function buildCaseFile(
  profileId: string,
  goalId: string,
  now: Date = new Date(),
): Promise<CaseFile> {
  const lines: CaseLine[] = [];
  const add = (section: CaseSection, id: string, text: string) => lines.push({ section, id, text });
  const today = now.toISOString().slice(0, 10);

  // ── the goal ──
  const statement = await readCurrentField<string>(profileId, `goals.${goalId}.statement`);
  const { measure, baseline } = await readGoalMeasure(profileId, goalId);
  add(
    "goal",
    "goal",
    `"${statement?.value ?? "(no statement)"}"` +
      (measure
        ? ` — ${measure.direction} ${GOAL_METRICS[measure.metric].label} to ${measure.target_per_30d}${measure.currency ? ` ${measure.currency} minor units` : ""} per 30 days by ${measure.deadline} (set ${measure.set_on})`
        : " — not measurable"),
  );
  if (baseline) {
    add(
      "goal",
      "goal:baseline",
      `baseline ${baseline.per_30d}${baseline.currency ? ` ${baseline.currency} minor units` : ""} per 30 days, measured ${baseline.from}..${baseline.to} (${baseline.days_measured} days)`,
    );
  }

  // ── day zero against now ──
  const care = await careState(profileId);
  const nowSnapshot = await ensureSnapshot(profileId, "manual");
  if (care) {
    add(
      "day_zero",
      "day_zero",
      `entered care ${day(care.day_zero)}${care.recorded ? "" : " (inferred from the first mode decision; no day-zero snapshot)"}${care.watch_ends_at ? `; watching until ${day(care.watch_ends_at)}` : ""}`,
    );
    if (care.snapshot_id) {
      const diff = await diffSnapshots(care.snapshot_id, nowSnapshot.id);
      const keys = (xs: string[]) => xs.slice(0, 15).join(", ") || "none";
      add(
        "day_zero",
        "day_zero:diff",
        `profile since day zero: ${diff.changed.length} changed (${keys(diff.changed.map((c) => c.field_key))}), ${diff.added.length} added (${keys(diff.added)}), ${diff.removed.length} removed`,
      );
    }
  } else {
    add("day_zero", "day_zero", "never entered care — no mode decision");
  }

  // ── every measured series: day zero against the last 28 days ──
  const anchor = care ? day(care.day_zero) : today;
  for (const [name, metric] of Object.entries(GOAL_METRICS)) {
    const beforeFrom = shiftDay(anchor, -28);
    const nowFrom = shiftDay(today, -28);
    const series = await dailySeries(profileId, metric.series, beforeFrom, shiftDay(today, -1));
    if (!series || series.values.size === 0) {
      add("metrics", `metric:${name}`, `${metric.label}: not measured`);
      continue;
    }
    const then = windowStat(series, beforeFrom, shiftDay(anchor, -1));
    const latest = windowStat(series, nowFrom, shiftDay(today, -1));
    const unit = metric.kind === "money" ? ` ${series.currency} minor units` : "";
    add(
      "metrics",
      `metric:${name}`,
      `${metric.label} per 30 days: ${then.days_measured > 0 ? then.mean_minor * 30 : "unmeasured"}${unit} in the 28 days before day zero (${then.days_measured} days measured) → ${latest.days_measured > 0 ? latest.mean_minor * 30 : "unmeasured"}${unit} in the last 28 (${latest.days_measured} days)` +
        (then.days_measured > 0 && latest.days_measured > 0
          ? `, ${pct(then.mean_minor, latest.mean_minor)}`
          : ""),
    );
  }

  // ── proposals, newest first ──
  const rows = await db
    .select()
    .from(proposals)
    .where(eq(proposals.profile_id, profileId))
    .orderBy(desc(proposals.created_at));
  const execRows = await db.select().from(executions).where(eq(executions.profile_id, profileId));
  const execByProposal = new Map(execRows.map((e) => [e.proposal_id, e]));
  for (const row of rows.slice(0, CASE_LIMITS.max_proposals)) {
    const action = row.action as { kind?: string; summary?: string };
    const parts = [
      `${row.status} · ${action.kind ?? "?"} · "${action.summary ?? ""}"`,
      `raised ${day(row.created_at)} by ${row.module}`,
    ];
    if (row.decided_at) parts.push(`decided ${day(row.decided_at)}`);
    if (row.rejection_reason) parts.push(`declined because: "${row.rejection_reason}"`);
    if (row.blocked_by_limit) parts.push(`withheld by the owner's limit ${row.blocked_by_limit}`);
    const exec = execByProposal.get(row.id);
    if (exec)
      parts.push(
        `execution ${exec.status}${exec.undone_at ? `, undone ${day(exec.undone_at)}` : ""}`,
      );
    if (row.status === "executed") {
      const outcome = await readbackForProposal(row, now);
      parts.push(`readback ${outcome.verdict}: ${outcome.arithmetic}`);
    }
    add("proposals", `proposal:${row.id}`, parts.join("; "));
  }
  if (rows.length > CASE_LIMITS.max_proposals) {
    add(
      "proposals",
      "proposals:older",
      `${rows.length - CASE_LIMITS.max_proposals} older proposal(s) not listed`,
    );
  }
  if (rows.length === 0) add("proposals", "proposals:none", "no proposal has ever been made");

  // ── what the report found that nobody acted on ──
  const [report] = await db
    .select()
    .from(diagnosisReports)
    .where(eq(diagnosisReports.profile_id, profileId))
    .orderBy(desc(diagnosisReports.generated_at))
    .limit(1);
  if (report) {
    const refs = new Set(rows.map((r) => r.originating_finding).filter(Boolean));
    const recs = report.recommendations as StoredRecommendation[];
    const findings = report.findings as DiagnosisFinding[];
    const addressed = new Set<number>();
    for (const [i, rec] of recs.entries()) {
      for (const f of rec.addresses ?? []) addressed.add(f);
      const ref = `report:${report.id}:rec:${i}`;
      if (rec.status === "rejected") {
        add(
          "unaddressed",
          `rec:${report.id}:${i}`,
          `recommendation "${rec.title}" declined on the report${rec.rejection_reason ? `: "${rec.rejection_reason}"` : ""}`,
        );
      } else if (!refs.has(ref)) {
        add(
          "unaddressed",
          `rec:${report.id}:${i}`,
          `recommendation "${rec.title}" never became a proposal`,
        );
      }
    }
    for (const [i, finding] of findings.entries()) {
      if (!addressed.has(i)) {
        add(
          "unaddressed",
          `finding:${report.id}:${i}`,
          `${finding.severity} finding "${finding.title}" has no recommendation addressing it`,
        );
      }
    }
  } else {
    add("unaddressed", "report:none", "no diagnosis report exists");
  }

  // ── approved, never executed ──
  for (const row of rows) {
    if (row.status === "approved" && !execByProposal.has(row.id)) {
      const action = row.action as { summary?: string };
      add(
        "approved_not_executed",
        `approved:${row.id}`,
        `"${action.summary ?? ""}" approved ${day(row.decided_at)} and never executed${row.execute_not_before ? ` (scheduled for ${day(row.execute_not_before)})` : ""}`,
      );
    }
  }

  // ── executions that failed or were undone ──
  for (const exec of execRows) {
    if (exec.status === "failed" || exec.status === "undone") {
      add(
        "executions",
        `execution:${exec.id}`,
        `${exec.op} via ${exec.provider}: ${exec.status}${exec.error ? ` — ${exec.error}` : ""}${exec.undone_at ? ` (undone ${day(exec.undone_at)} by ${exec.undone_by ? "the owner" : "the system"})` : ""}`,
      );
    }
  }

  // ── anomalies since day zero ──
  const anomalyRows = await db
    .select()
    .from(anomalies)
    .where(
      care
        ? and(eq(anomalies.profile_id, profileId), gte(anomalies.last_date, day(care.day_zero)))
        : eq(anomalies.profile_id, profileId),
    );
  for (const a of anomalyRows) {
    add(
      "anomalies",
      `anomaly:${a.id}`,
      `${a.metric_key} ${a.direction} ${a.first_date}..${a.last_date} (${a.severity}${a.resolved_at ? ", resolved" : ", open"}): ${a.detail}`,
    );
  }

  // ── where the owner's figures and the measurements disagree ──
  for (const pair of await statedVsMeasured(nowSnapshot.id)) {
    add(
      "stated_vs_measured",
      `measured:${pair.field_key}`,
      `${pair.field_key}: owner said ${JSON.stringify(pair.stated.value)}, ${pair.provider} measured ${JSON.stringify(pair.measured.value)}${pair.delta?.pct != null ? ` (${pair.delta.pct}%)` : ""}`,
    );
  }

  // ── open validation findings: gaps and contradictions in the profile ──
  const open = await db
    .select()
    .from(validationFindings)
    .where(
      and(eq(validationFindings.profile_id, profileId), isNull(validationFindings.resolution)),
    );
  for (const f of open) {
    const message = (f.message as { en?: string }).en ?? f.rule_id;
    add("open_questions", `validation:${f.id}`, `${f.kind} (${f.severity}): ${message}`);
  }

  // ── sources ──
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  const conns = profile
    ? await db.select().from(connections).where(eq(connections.account_id, profile.account_id))
    : [];
  for (const c of conns) {
    add(
      "sources",
      `source:${c.provider}:${c.purpose}`,
      `${c.provider} (${c.purpose}): ${c.status}${c.last_sync_at ? `, last synced ${day(c.last_sync_at)}` : ", never synced"}${c.last_error ? ` — ${c.last_error}` : ""}`,
    );
  }
  if (conns.length === 0)
    add("sources", "sources:none", "no source is connected — every figure is the owner's word");

  // ── this goal's weekly verdicts ──
  const checks = await db
    .select({ at: watchActivity.at, meta: watchActivity.meta })
    .from(watchActivity)
    .where(and(eq(watchActivity.profile_id, profileId), eq(watchActivity.kind, "goal_progress")))
    .orderBy(watchActivity.at);
  const verdicts = checks
    .map((c) => ({ at: c.at, meta: c.meta as { goal_id?: string; verdict?: string } | null }))
    .filter((c) => c.meta?.goal_id === goalId);
  if (verdicts.length > 0) {
    add(
      "progress",
      "progress",
      verdicts.map((v) => `${day(v.at)} ${v.meta?.verdict ?? "?"}`).join(", "),
    );
  }

  const hash = createHash("sha256").update(renderCaseFile({ lines })).digest("hex");
  return {
    profile_id: profileId,
    goal_id: goalId,
    built_at: now.toISOString(),
    day_zero: care?.day_zero ?? null,
    snapshot_id: nowSnapshot.id,
    lines,
    hash,
  };
}
