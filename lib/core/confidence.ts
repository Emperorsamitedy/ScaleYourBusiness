// Confidence — data-model-v1.md §3.1, valued per §8.1.
//
// A branded number in [0, 1]. Base values by source and their adjustment
// rules live in §8.1 and are implemented by the sessions that assign
// confidence (parser, connectors, inference) — this module only guarantees
// that no out-of-range confidence can exist.

declare const ConfidenceBrand: unique symbol;

export type Confidence = number & { readonly [ConfidenceBrand]: true };

export class InvalidConfidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfidenceError";
  }
}

export function confidence(value: number): Confidence {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new InvalidConfidenceError(`confidence must be in [0, 1], got ${value}`);
  }
  return value as Confidence;
}

// Base values per conversation-channel.md §2.3. Conversational facts start
// lower than structured answers — "we're doing about double what we were"
// is not "4,200,000 HUF" — and an unconfirmed extraction must never
// silently override a structured answer or connector value: at 0.45 it
// sits below every §8.1 base except system_default, so a conflict is a
// contradiction for reconcile, not a quiet overwrite.
export const CONFIDENCE_BASE = {
  /** Owner input, structured and precise (also §8.1). */
  owner_input_precise: confidence(0.75),
  /** Conversation, confirmed by the owner in the §3 loop. */
  conversation_confirmed: confidence(0.7),
  /** Conversation, extracted but unconfirmed. Context, not authority. */
  conversation_unconfirmed: confidence(0.45),
} as const;
