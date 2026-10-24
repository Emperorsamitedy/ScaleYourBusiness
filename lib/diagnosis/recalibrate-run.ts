// M-2: the recalibration run — the database and model half.
//
// Reads, never writes: the targets are businesses' STORED snapshots (the
// one their latest report was built from, else their latest snapshot —
// never a new one), the prompt is buildDiagnosisPrompt's (read-only), and
// the answers are judged in memory by lib/diagnosis/recalibrate.ts. The
// only rows written are the llm_calls rows every model call writes, filed
// under one synthetic account so no business's own spend moves.
//
// Imported only by scripts/recalibrate-diagnosis.ts, after the key check,
// the printed estimate and --yes (the database pool reads DATABASE_URL at
// import). recalibrate-run.test.ts runs it on a fake client.

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, diagnosisReports, fieldRecords } from "../../db/schema";
import type { AskedEntry } from "../interviewer/prompt";
import { buildSystemBlocks, loadInterviewerBank } from "../interviewer/prompt";
import { pickNextQuestion } from "../interviewer/interviewer";
import { captureLoggedCalls } from "../llm/call-capture";
import type { DiagnosisModel, SonnetModel } from "../llm/models";
import { opusShape } from "../llm/models";
import { costEur } from "../llm/pricing";
import { readCurrentField } from "../profile/field-store";
import { listSnapshots, readSnapshot } from "../profile/snapshot";
import { applicableQuestions } from "../resolver/applicability";
import type { DiagnosisPrompt } from "./findings";
import { buildDiagnosisPrompt, diagnosisLlmFor } from "./findings";
import type { BusinessComparison, PickComparison, PickRun } from "./recalibrate";
import {
  compareBusiness,
  comparePicks,
  estimateTokens,
  failedRun,
  toModelRun,
} from "./recalibrate";

export interface Target {
  profile_id: string;
  /** The stored snapshot to diagnose; null when the profile has none (it is skipped). */
  snapshot_id: string | null;
  label: string;
}

async function labelOf(profileId: string): Promise<string> {
  const name = await readCurrentField<unknown>(profileId, "identity.legal_name");
  return typeof name?.value === "string" && name.value.trim() !== ""
    ? name.value.trim()
    : `profile ${profileId.slice(0, 8)}`;
}

/** The snapshot a profile's latest report was built from, else its latest snapshot. */
async function storedSnapshot(profileId: string): Promise<string | null> {
  const [report] = await db
    .select({ snapshot_id: diagnosisReports.snapshot_id })
    .from(diagnosisReports)
    .where(eq(diagnosisReports.profile_id, profileId))
    .orderBy(desc(diagnosisReports.generated_at))
    .limit(1);
  if (report) return report.snapshot_id;
  const [latest] = (await listSnapshots(profileId)).sort((a, b) =>
    b.taken_at.localeCompare(a.taken_at),
  );
  return latest?.id ?? null;
}

/** --profiles a,b,c — or --latest N: the N most recently reported businesses. */
export async function diagnosisTargets(sel: {
  profiles?: readonly string[];
  latest?: number;
}): Promise<Target[]> {
  let ids: string[];
  if (sel.profiles && sel.profiles.length > 0) {
    ids = [...sel.profiles];
  } else {
    const rows = await db
      .select({ profile_id: diagnosisReports.profile_id, at: diagnosisReports.generated_at })
      .from(diagnosisReports)
      .orderBy(desc(diagnosisReports.generated_at));
    ids = [...new Set(rows.map((r) => r.profile_id))].slice(0, sel.latest ?? 5);
  }
  const out: Target[] = [];
  for (const id of ids) {
    out.push({ profile_id: id, snapshot_id: await storedSnapshot(id), label: await labelOf(id) });
  }
  return out;
}

export interface Prepared {
  target: Target;
  prompt: DiagnosisPrompt;
}

/** The prompts, built read-only before anything is spent — the estimate is made from these. */
export async function prepareDiagnosis(targets: readonly Target[]): Promise<{
  prepared: Prepared[];
  skipped: { target: Target; reason: string }[];
}> {
  const prepared: Prepared[] = [];
  const skipped: { target: Target; reason: string }[] = [];
  for (const target of targets) {
    if (target.snapshot_id === null) {
      skipped.push({ target, reason: "no stored snapshot (none is taken here)" });
      continue;
    }
    // The snapshot must belong to the profile asked for.
    const view = await readSnapshot(target.snapshot_id);
    if (view.summary.profile_id !== target.profile_id) {
      skipped.push({ target, reason: "the snapshot belongs to another profile" });
      continue;
    }
    try {
      prepared.push({
        target,
        prompt: await buildDiagnosisPrompt(target.profile_id, target.snapshot_id),
      });
    } catch (e) {
      skipped.push({ target, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { prepared, skipped };
}

/** Worst case per model: the prompt (estimated from its size) and the whole output cap. */
export function estimateDiagnosisEur(
  prepared: readonly Prepared[],
  models: readonly DiagnosisModel[],
): { per_model: Record<string, number>; total: number; input_tokens: number } {
  const per_model: Record<string, number> = {};
  let input_tokens = 0;
  for (const p of prepared) {
    const input = estimateTokens(p.prompt.system.length + p.prompt.user.length);
    input_tokens += input;
    for (const m of models) {
      const usage = {
        input_tokens: input,
        output_tokens: opusShape(8_000, m).max_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
      per_model[m] = (per_model[m] ?? 0) + costEur(m, usage);
    }
  }
  const total = Object.values(per_model).reduce((s, v) => s + v, 0);
  return { per_model, total, input_tokens };
}

/** Both models on every prepared snapshot, compared. Writes nothing but llm_calls rows. */
export async function runDiagnosisComparison(args: {
  prepared: readonly Prepared[];
  models: readonly [DiagnosisModel, DiagnosisModel];
  accountId: string;
  print?: (line: string) => void;
  render?: (c: BusinessComparison) => string;
}): Promise<BusinessComparison[]> {
  const capture = captureLoggedCalls();
  const print = args.print ?? ((l: string) => capture.print(l));
  const rows: BusinessComparison[] = [];
  try {
    for (const { target, prompt } of args.prepared) {
      const runs = [];
      for (const model of args.models) {
        const before = capture.logged.length;
        try {
          const { text, stop_reason } = await diagnosisLlmFor(model)({
            system: prompt.system,
            user: prompt.user,
            accountId: args.accountId,
          });
          runs.push(
            toModelRun({
              model,
              text,
              stop_reason: stop_reason ?? null,
              calls: capture.logged.slice(before),
              fact_keys: prompt.fact_keys,
            }),
          );
        } catch (e) {
          runs.push(failedRun(model, e, capture.logged.slice(before)));
        }
      }
      const row = compareBusiness({
        label: target.label,
        profile_id: target.profile_id,
        snapshot_id: prompt.snapshot_id,
        a: runs[0]!,
        b: runs[1]!,
      });
      rows.push(row);
      if (args.render) print(args.render(row));
    }
  } finally {
    capture.restore();
  }
  return rows;
}

/* ── --sonnet: the interviewer's pick on stored intake states ── */

/** This session's history as the intake builds it: answered, unknown and skipped, in bank order. */
async function askedFor(profileId: string): Promise<AskedEntry[]> {
  const [applicable, rows] = await Promise.all([
    applicableQuestions(profileId),
    db
      .select({
        field_key: fieldRecords.field_key,
        status: fieldRecords.status,
        value: fieldRecords.value,
      })
      .from(fieldRecords)
      .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at))),
  ]);
  const byKey = new Map(rows.map((r) => [r.field_key, r]));
  const out: AskedEntry[] = [];
  for (const q of applicable) {
    const r = byKey.get(q.writes_to);
    if (!r || (r.status !== "answered" && r.status !== "unknown" && r.status !== "skipped"))
      continue;
    out.push({
      question_id: q.id,
      answer_repr:
        r.status === "answered" ? (JSON.stringify(r.value)?.slice(0, 60) ?? "") : r.status,
    });
  }
  return out;
}

/** --profiles, or the latest N profiles by creation (complete ones are reported, not called). */
export async function intakeTargets(sel: {
  profiles?: readonly string[];
  latest?: number;
}): Promise<Target[]> {
  const ids =
    sel.profiles && sel.profiles.length > 0
      ? [...sel.profiles]
      : (
          await db
            .select({ id: businessProfiles.id })
            .from(businessProfiles)
            .orderBy(desc(businessProfiles.created_at))
            .limit(sel.latest ?? 5)
        ).map((r) => r.id);
  const out: Target[] = [];
  for (const id of ids) out.push({ profile_id: id, snapshot_id: null, label: await labelOf(id) });
  return out;
}

/** Worst case: every call writes the whole bank to cache, twice (the retry), at 300 output. */
export async function estimateSonnetEur(
  targets: number,
  models: readonly SonnetModel[],
): Promise<{ total: number; bank_tokens: number }> {
  const system = buildSystemBlocks(await loadInterviewerBank());
  const bank_tokens = estimateTokens(system.reduce((s, b) => s + b.text.length, 0)) + 1_000;
  let total = 0;
  for (const m of models) {
    total +=
      targets *
      2 *
      costEur(m, {
        input_tokens: 1_000,
        output_tokens: 300,
        cache_creation_input_tokens: bank_tokens,
        cache_read_input_tokens: 0,
      });
  }
  return { total, bank_tokens };
}

export async function runPickComparison(args: {
  targets: readonly Target[];
  models: readonly [SonnetModel, SonnetModel];
  accountId: string;
}): Promise<PickComparison[]> {
  const capture = captureLoggedCalls();
  const rows: PickComparison[] = [];
  try {
    for (const target of args.targets) {
      const asked = await askedFor(target.profile_id);
      let candidates = 0;
      const runs: PickRun[] = [];
      for (const model of args.models) {
        const before = capture.logged.length;
        const run: PickRun = {
          model,
          question_id: null,
          reason: "",
          fallback: false,
          error: null,
          calls: 0,
          cache_read_input_tokens: 0,
          cost_eur: 0,
        };
        try {
          const next = await pickNextQuestion({
            accountId: args.accountId,
            profileId: target.profile_id,
            asked,
            model,
          });
          if (next === null) {
            run.reason = "no open question — no call made";
          } else {
            candidates = next.selection.candidates.length;
            run.question_id = next.question.id;
            run.reason = next.selection_reason;
            run.fallback = next.selection_reason.startsWith("fallback:");
          }
        } catch (e) {
          run.error = e instanceof Error ? e.message : String(e);
        }
        const calls = capture.logged.slice(before);
        run.calls = calls.length;
        run.cache_read_input_tokens = calls.reduce((s, c) => s + c.cache_read_input_tokens, 0);
        run.cost_eur = calls.reduce((s, c) => s + c.cost_eur, 0);
        runs.push(run);
      }
      rows.push(
        comparePicks({
          label: target.label,
          profile_id: target.profile_id,
          candidates,
          a: runs[0]!,
          b: runs[1]!,
        }),
      );
    }
  } finally {
    capture.restore();
  }
  return rows;
}
