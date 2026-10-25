// Model pricing for cost logging — CLAUDE.md cost discipline: log token
// counts and cost per call from the first day, tagged by workload.
//
// Prices are USD per million tokens, checked against the pricing page on
// 2026-08-21. Sonnet 5 carries introductory pricing ($2/$10) through
// 2026-08-31; it reverts to $3/$15 after — update then. Cache multipliers
// are per model: writes 1.25× input (5-minute TTL), reads 0.1× (Opus 5.5:
// 0.05×). No call here uses the 1-hour TTL (2× writes), so it isn't
// modelled.
//
// Claude Haiku 5.5 (owner-approved move, 2026-10-24) has two rate cards,
// chosen by the prompt's length — every input token the call sent, cached
// or not: $0.10/$0.50 at 100K tokens or fewer, $0.50/$2.50 above. Haiku
// 4.5 stays priced for the llm_calls rows it already wrote.
//
// The 5.5 Sonnet and Opus (M-2, behind SONNET_MODEL / DIAGNOSIS_MODEL,
// off by default), from the model migration notes of 2026-10:
//   · Sonnet 5.5 — $2/$10, the same as Sonnet 5; 5-minute cache writes
//     $2.50 (1.25×), cache reads $0.20 (0.1×).
//   · Opus 5.5 — $4/$20; 5-minute cache writes $5 (1.25×), cache reads
//     $0.20, which is 0.05× input — deeper than every other model here.

export interface RateCard {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
}

export interface ModelPricing extends RateCard {
  cache_write_multiplier: number;
  cache_read_multiplier: number;
  /** A second card for long prompts: it applies when the prompt is above `above_tokens`. */
  long_prompt?: RateCard & { above_tokens: number };
}

export const PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-opus-4-8": {
    input_usd_per_mtok: 5,
    output_usd_per_mtok: 25,
    cache_write_multiplier: 1.25,
    cache_read_multiplier: 0.1,
  },
  "claude-opus-5-5": {
    input_usd_per_mtok: 4,
    output_usd_per_mtok: 20,
    cache_write_multiplier: 1.25,
    cache_read_multiplier: 0.05,
  },
  "claude-sonnet-5": {
    input_usd_per_mtok: 2,
    output_usd_per_mtok: 10,
    cache_write_multiplier: 1.25,
    cache_read_multiplier: 0.1,
  },
  "claude-sonnet-5-5": {
    input_usd_per_mtok: 2,
    output_usd_per_mtok: 10,
    cache_write_multiplier: 1.25,
    cache_read_multiplier: 0.1,
  },
  "claude-haiku-5-5": {
    input_usd_per_mtok: 0.1,
    output_usd_per_mtok: 0.5,
    cache_write_multiplier: 1.25,
    cache_read_multiplier: 0.1,
    long_prompt: { above_tokens: 100_000, input_usd_per_mtok: 0.5, output_usd_per_mtok: 2.5 },
  },
  "claude-haiku-4-5": {
    input_usd_per_mtok: 1,
    output_usd_per_mtok: 5,
    cache_write_multiplier: 1.25,
    cache_read_multiplier: 0.1,
  },
};

/** Rough conversion for the €-denominated budget; measurement, not FX truth. */
export const USD_TO_EUR = 0.92;

export interface UsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export class UnknownModelError extends Error {
  constructor(model: string) {
    super(`no pricing entry for model "${model}" — add it to PRICING before calling it`);
    this.name = "UnknownModelError";
  }
}

/** The prompt's length for rate-card purposes: uncached input plus cache writes plus cache reads. */
export function promptTokens(usage: UsageTokens): number {
  return usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
}

/** The card a call is billed on: the long-prompt card above its threshold, else the base. */
export function rateCard(p: ModelPricing, usage: UsageTokens): RateCard {
  return p.long_prompt && promptTokens(usage) > p.long_prompt.above_tokens ? p.long_prompt : p;
}

export function costEur(model: string, usage: UsageTokens): number {
  const p = PRICING[model];
  if (!p) throw new UnknownModelError(model);
  const card = rateCard(p, usage);
  const usd =
    (usage.input_tokens * card.input_usd_per_mtok +
      usage.cache_creation_input_tokens * card.input_usd_per_mtok * p.cache_write_multiplier +
      usage.cache_read_input_tokens * card.input_usd_per_mtok * p.cache_read_multiplier +
      usage.output_tokens * card.output_usd_per_mtok) /
    1_000_000;
  return usd * USD_TO_EUR;
}

/**
 * Anthropic's server-side web search is billed per search on top of the
 * tokens: $10 per 1,000 searches. The response reports the count in
 * usage.server_tool_use.web_search_requests (review 2026-10-23, finding 9:
 * these fees were uncosted).
 */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;

export function webSearchCostEur(requests: number): number {
  if (!Number.isFinite(requests) || requests <= 0) return 0;
  return Math.floor(requests) * WEB_SEARCH_USD_PER_REQUEST * USD_TO_EUR;
}
