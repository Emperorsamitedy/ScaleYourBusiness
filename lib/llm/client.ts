// The one Anthropic client — lazy so nothing before Session L demands the
// key (lib/env's lazy accessor does the fail-fast naming if it's absent).
// SDK retries are the hard-capped retry loop the cost rules require: the
// cap is explicit here, never unbounded. Raised from the default 2 to 5
// because connection resets (ETIMEDOUT) on this network killed a paid
// 20-persona harness run mid-flight; a retried request that never
// reached the API costs nothing, an abandoned run costs the whole batch.

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";

const MAX_RETRIES = 5;
const TIMEOUT_MS = 120_000;

let client: Anthropic | null = null;

export function anthropicClient(): Anthropic {
  if (client === null) {
    client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      maxRetries: MAX_RETRIES,
      timeout: TIMEOUT_MS,
    });
  }
  return client;
}

// Which Sonnet the interviewer (and every Sonnet site) runs on is read in
// one place, lib/llm/models.ts — SONNET_MODEL, unset = claude-sonnet-5.
