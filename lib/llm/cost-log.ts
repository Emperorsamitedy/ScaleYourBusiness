// Per-call LLM cost logging — P0-51 / step 22.
//
// One structured JSON line per API call, tagged by workload, with the
// account id on every line (CLAUDE.md logging convention). This is the
// €50/month budget's measurement instrument; nothing calls a model
// without passing through here.

import { logSafeError } from "../core/log-safe";
import type { UsageTokens } from "./pricing";
import { costEur } from "./pricing";

export interface LlmCallRecord {
  at: string;
  event: "llm_call";
  /** e.g. "interviewer", "parser", "diagnosis" — routes to the budget line. */
  workload: string;
  account_id: string;
  model: string;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_eur: number;
}

export function buildCallRecord(args: {
  workload: string;
  account_id: string;
  model: string;
  duration_ms: number;
  usage: UsageTokens;
}): LlmCallRecord {
  return {
    at: new Date().toISOString(),
    event: "llm_call",
    workload: args.workload,
    account_id: args.account_id,
    model: args.model,
    duration_ms: args.duration_ms,
    ...args.usage,
    cost_eur: costEur(args.model, args.usage),
  };
}

export function logLlmCall(record: LlmCallRecord): void {
  console.log(JSON.stringify(record));
}

/**
 * P1-51: the log line, persisted. Vercel keeps no function-log history,
 * so before this table every cost figure was an estimate reconstructed
 * by hand from whatever logs happened to still be on screen. Telemetry
 * must never break the call it measures: a failed insert is logged and
 * swallowed — the model call already succeeded and cost real money,
 * and losing one metering row is better than failing the answer.
 */
export async function recordLlmCall(record: LlmCallRecord): Promise<void> {
  logLlmCall(record);
  try {
    const { db } = await import("../../db");
    const { llmCalls } = await import("../../db/schema");
    await db.insert(llmCalls).values({
      at: record.at,
      account_id: record.account_id,
      workload: record.workload,
      model: record.model,
      duration_ms: record.duration_ms,
      input_tokens: record.input_tokens,
      output_tokens: record.output_tokens,
      cache_creation_input_tokens: record.cache_creation_input_tokens,
      cache_read_input_tokens: record.cache_read_input_tokens,
      cost_eur: record.cost_eur.toFixed(6),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "llm_call_persist_failed", ...logSafeError(error) }));
  }
}

/** Aggregate a run's records — the harness prints this as its cost report. */
export function summarizeCalls(records: readonly LlmCallRecord[]): {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_eur: number;
  cache_hit_rate: number;
} {
  const sum = {
    calls: records.length,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cost_eur: 0,
    cache_hit_rate: 0,
  };
  for (const r of records) {
    sum.input_tokens += r.input_tokens;
    sum.output_tokens += r.output_tokens;
    sum.cache_creation_input_tokens += r.cache_creation_input_tokens;
    sum.cache_read_input_tokens += r.cache_read_input_tokens;
    sum.cost_eur += r.cost_eur;
  }
  const prompt_total =
    sum.input_tokens + sum.cache_creation_input_tokens + sum.cache_read_input_tokens;
  sum.cache_hit_rate = prompt_total === 0 ? 0 : sum.cache_read_input_tokens / prompt_total;
  return sum;
}
