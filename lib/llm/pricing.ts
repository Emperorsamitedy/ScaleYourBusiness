// Model pricing for cost logging — CLAUDE.md cost discipline: log token
// counts and cost per call from the first day, tagged by workload.
//
// Prices are USD per million tokens, checked against the pricing page on
// 2026-08-21. Sonnet 5 carries introductory pricing ($2/$10) through
// 2026-08-31; it reverts to $3/$15 after — update then. Cache multipliers
// are Anthropic-wide: writes 1.25× input (5-minute TTL), reads 0.1×.

export interface ModelPricing {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  cache_write_multiplier: number;
  cache_read_multiplier: number;
}

export const PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-opus-4-8": {
    input_usd_per_mtok: 5,
    output_usd_per_mtok: 25,
    cache_write_multiplier: 1.25,
    cache_read_multiplier: 0.1,
  },
  "claude-sonnet-5": {
    input_usd_per_mtok: 2,
    output_usd_per_mtok: 10,
    cache_write_multiplier: 1.25,
    cache_read_multiplier: 0.1,
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

export function costEur(model: string, usage: UsageTokens): number {
  const p = PRICING[model];
  if (!p) throw new UnknownModelError(model);
  const usd =
    (usage.input_tokens * p.input_usd_per_mtok +
      usage.cache_creation_input_tokens * p.input_usd_per_mtok * p.cache_write_multiplier +
      usage.cache_read_input_tokens * p.input_usd_per_mtok * p.cache_read_multiplier +
      usage.output_tokens * p.output_usd_per_mtok) /
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
