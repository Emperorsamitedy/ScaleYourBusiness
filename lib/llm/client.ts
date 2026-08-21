// The one Anthropic client — lazy so nothing before Session L demands the
// key (lib/env's lazy accessor does the fail-fast naming if it's absent).
// SDK retries (429/5xx, max_retries=2 default) are the hard-capped retry
// loop the cost rules require.

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";

let client: Anthropic | null = null;

export function anthropicClient(): Anthropic {
  if (client === null) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

/** Interviewer model per CLAUDE.md routing: Sonnet for the interviewer. */
export const INTERVIEWER_MODEL = "claude-sonnet-5";
