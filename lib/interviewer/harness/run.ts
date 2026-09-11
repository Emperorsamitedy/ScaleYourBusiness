// The interviewer harness — P0-52/53 / step 22.
//
// Runs N synthetic personas end to end against the LIVE interviewer and
// asserts, per transcript:
//   A. no question repeated (P0-53)
//   B. every ask came from the resolver-computed candidate set (P0-53 —
//      structurally guaranteed, recorded per turn and re-checked here)
//   C. every deep ask happened with zero core AND zero important open;
//      every important ask with zero core open (P0-49, stronger form)
//   D. the interview completed (pickNextQuestion returned null) within
//      MAX_TURNS
//   E. core_complete is true at the end (ties Session K to Session L)
//   F. no selection needed a retry beyond the capped attempts
//
// Env: HARNESS_PROFILES=N (first N personas, default all 20),
//      HARNESS_CONCURRENCY (default 2), HARNESS_MAX_TURNS (default 220).
// Output: per-profile lines + aggregate cost report; JSON transcript in
// var/harness-report.json (gitignored). Exit 1 on any assertion failure.

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import {
  accounts,
  businessProfiles,
  channels,
  competitors,
  costItems,
  customerSegments,
  fieldRecords,
  goals,
  offers,
  staffRoles,
  suppliers,
} from "../../../db/schema";
import { loadBank } from "../../bank/loader";
import type { LlmCallRecord } from "../../llm/cost-log";
import { summarizeCalls } from "../../llm/cost-log";
import { computeCompleteness } from "../../scorer/completeness";
import type { AskedEntry } from "../prompt";
import { pickNextQuestion } from "../interviewer";
import { answerQuestion } from "./answers";
import type { Persona } from "./personas";
import { PERSONAS, rngFor } from "./personas";

interface TurnRecord {
  index: number;
  question_id: string;
  priority: string;
  tier: string;
  open_core: number;
  open_important: number;
  open_deep: number;
  in_candidates: boolean;
  attempts: number;
  answer: string;
  selection_reason: string;
}

interface ProfileResult {
  persona: string;
  turns: TurnRecord[];
  completed: boolean;
  core_complete: boolean;
  overall_completeness: number;
  failures: string[];
  calls: LlmCallRecord[];
}

const MAX_TURNS = Number(process.env.HARNESS_MAX_TURNS ?? 220);

async function runPersona(persona: Persona): Promise<ProfileResult> {
  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: "HUF", locale: "hu-HU" })
    .returning();
  if (!account) throw new Error("account insert failed");
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: account.id, schema_version: "1.0.0" })
    .returning();
  if (!profile) throw new Error("profile insert failed");

  const rng = rngFor(persona.seed);
  const asked: AskedEntry[] = [];
  const turns: TurnRecord[] = [];
  const calls: LlmCallRecord[] = [];
  const failures: string[] = [];
  let completed = false;

  try {
    for (let i = 0; i < MAX_TURNS; i++) {
      const next = await pickNextQuestion({
        accountId: account.id,
        profileId: profile.id,
        asked,
      });
      if (next === null) {
        completed = true;
        break;
      }
      calls.push(...next.calls);

      const inCandidates = next.selection.candidates.some((c) => c.id === next.question.id);
      const outcome = await answerQuestion(profile.id, persona, next.question, rng);
      turns.push({
        index: i,
        question_id: next.question.id,
        priority: next.question.priority,
        tier: next.selection.tier ?? "?",
        open_core: next.selection.open.core,
        open_important: next.selection.open.important,
        open_deep: next.selection.open.deep,
        in_candidates: inCandidates,
        attempts: next.calls.length,
        answer: outcome.repr,
        selection_reason: next.selection_reason,
      });
      asked.push({ question_id: next.question.id, answer_repr: outcome.repr });
    }

    // ---- assertions ----
    const ids = turns.map((t) => t.question_id);
    if (new Set(ids).size !== ids.length) {
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      failures.push(`A: repeated question(s): ${[...new Set(dupes)].join(", ")}`);
    }
    for (const t of turns) {
      if (!t.in_candidates)
        failures.push(`B: turn ${t.index} asked ${t.question_id} outside candidates`);
      if (t.priority === "deep" && (t.open_core > 0 || t.open_important > 0)) {
        failures.push(
          `C: deep ${t.question_id} asked with core=${t.open_core} important=${t.open_important} open`,
        );
      }
      if (t.priority === "important" && t.open_core > 0) {
        failures.push(`C: important ${t.question_id} asked with ${t.open_core} core open`);
      }
      if (t.attempts > 2) failures.push(`F: turn ${t.index} took ${t.attempts} attempts`);
    }
    if (!completed) failures.push(`D: not complete after ${MAX_TURNS} turns`);

    const score = await computeCompleteness(profile.id);
    if (!score.core_complete) {
      failures.push(`E: core_complete false at end — gaps: ${score.blocking_gaps.join(", ")}`);
    }

    return {
      persona: persona.name,
      turns,
      completed,
      core_complete: score.core_complete,
      overall_completeness: score.overall,
      failures,
      calls,
    };
  } finally {
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profile.id));
    for (const table of [
      offers,
      suppliers,
      channels,
      competitors,
      staffRoles,
      costItems,
      customerSegments,
      goals,
    ]) {
      await db.delete(table).where(eq(table.profile_id, profile.id));
    }
    await db.delete(businessProfiles).where(eq(businessProfiles.id, profile.id));
    await db.delete(accounts).where(eq(accounts.id, account.id));
  }
}

/** var/harness-report.json — rewritten after every persona (see below). */
function writeReport(results: ProfileResult[], crashed: string[]): void {
  mkdirSync("var", { recursive: true });
  writeFileSync(
    "var/harness-report.json",
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        total: summarizeCalls(results.flatMap((r) => r.calls)),
        crashed,
        results,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  await loadBank("specs/question-bank-v1.json");

  const count = Number(process.env.HARNESS_PROFILES ?? PERSONAS.length);
  const concurrency = Number(process.env.HARNESS_CONCURRENCY ?? 2);
  // HARNESS_ONLY: comma-separated persona names, for finishing a run's
  // tail without paying for the personas that already passed. Unknown
  // names fail loudly — a typo silently running zero personas would
  // read as a pass.
  const only = (process.env.HARNESS_ONLY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = only.filter((name) => !PERSONAS.some((p) => p.name === name));
  if (unknown.length > 0) throw new Error(`HARNESS_ONLY names not found: ${unknown.join(", ")}`);
  const queue = only.length > 0 ? PERSONAS.filter((p) => only.includes(p.name)) : PERSONAS.slice(0, count);
  const results: ProfileResult[] = [];
  const crashed: string[] = [];
  let cursor = 0;

  console.log(`harness: ${queue.length} personas, concurrency ${concurrency}`);
  const started = Date.now();

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      const persona = queue[index];
      if (!persona) return;
      const t0 = Date.now();
      let result: ProfileResult;
      try {
        result = await runPersona(persona);
      } catch (error) {
        // One persona's transport failure must not discard the paid work
        // of the other nineteen. Record it as a failure and carry on;
        // the aggregate reports it and the run still exits non-zero.
        const message = error instanceof Error ? error.message : String(error);
        console.log(`✗ ${persona.name}: ABORTED — ${message}`);
        crashed.push(`${persona.name} — aborted: ${message}`);
        continue;
      }
      results.push(result);
      // Checkpoint after every persona: a run stopped early (budget,
      // network, Ctrl-C) must not discard the profiles already paid for.
      writeReport(results, crashed);
      const cost = summarizeCalls(result.calls);
      console.log(
        `✓ ${result.persona}: ${result.turns.length} turns, ` +
          `${result.completed ? "completed" : "INCOMPLETE"}, ` +
          `core_complete=${result.core_complete}, overall=${result.overall_completeness.toFixed(2)}, ` +
          `€${cost.cost_eur.toFixed(3)}, cache=${(cost.cache_hit_rate * 100).toFixed(1)}%, ` +
          `${Math.round((Date.now() - t0) / 1000)}s` +
          (result.failures.length > 0 ? `  ⚠ ${result.failures.length} FAILURES` : ""),
      );
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  const allCalls = results.flatMap((r) => r.calls);
  const total = summarizeCalls(allCalls);
  const allFailures = results.flatMap((r) => r.failures.map((f) => `${r.persona} — ${f}`));

  console.log("\n==== aggregate ====");
  console.log(`profiles      : ${results.length}`);
  console.log(`total turns   : ${results.reduce((n, r) => n + r.turns.length, 0)}`);
  console.log(`api calls     : ${total.calls}`);
  console.log(`cache hit rate: ${(total.cache_hit_rate * 100).toFixed(1)}%`);
  console.log(`total cost    : €${total.cost_eur.toFixed(2)}`);
  console.log(`wall clock    : ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`aborted       : ${crashed.length}`);
  console.log(`failures      : ${allFailures.length}`);
  for (const f of crashed) console.log(`  ✗ ${f}`);
  for (const f of allFailures) console.log(`  ✗ ${f}`);

  writeReport(results, crashed);
  console.log("report: var/harness-report.json");

  process.exit(allFailures.length === 0 && crashed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
