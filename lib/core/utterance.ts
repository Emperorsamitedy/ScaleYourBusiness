// Utterance — conversation-channel.md §2.2. One message in the owner's
// chat with their agent, and the anchor every conversation-sourced fact
// points back at.
//
// cost_eur is a per-message operational metering value feeding the §6
// monthly cap — deliberately a plain number as the spec defines it, not a
// Money: it's the system's own telemetry, not a captured business fact
// with provenance.

import type { FieldId, BusinessProfileId, ThreadId, UtteranceId } from "./ids";
import type { ISODateTime } from "./iso";

export const UTTERANCE_INTENTS = [
  "ask", // question about the business
  "tell", // new information
  "correct", // fixes something already recorded
  "request", // wants something done
  "limit", // sets a constraint — writes to goals.owner_boundaries
  "social", // no action needed
] as const;

export type UtteranceIntent = (typeof UTTERANCE_INTENTS)[number];

export const UTTERANCE_ROLES = ["owner", "system"] as const;

export type UtteranceRole = (typeof UTTERANCE_ROLES)[number];

export interface Utterance {
  id: UtteranceId;
  profile_id: BusinessProfileId;
  thread_id: ThreadId;
  role: UtteranceRole;
  text: string;
  at: ISODateTime;
  /** Classified intent — owner turns only, null until classified. */
  intent: UtteranceIntent | null;
  /** What this message wrote to the profile, if anything. */
  extracted_fields: readonly FieldId[];
  confirmed: boolean;
  /** Per-message API cost for the §6 cap. Never negative. */
  cost_eur: number;
}

export class InvalidUtteranceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUtteranceError";
  }
}

export function isUtteranceIntent(value: string): value is UtteranceIntent {
  return (UTTERANCE_INTENTS as readonly string[]).includes(value);
}

export interface CreateUtteranceInput {
  id: UtteranceId;
  profile_id: BusinessProfileId;
  thread_id: ThreadId;
  role: UtteranceRole;
  text: string;
  at: ISODateTime;
  intent?: UtteranceIntent | null;
  extracted_fields?: readonly FieldId[];
  confirmed?: boolean;
  cost_eur: number;
}

/** Validating constructor — every stored utterance comes through here. */
export function createUtterance(input: CreateUtteranceInput): Utterance {
  if (input.text.trim() === "") {
    throw new InvalidUtteranceError("an utterance with no text records nothing");
  }
  if (!Number.isFinite(input.cost_eur) || input.cost_eur < 0) {
    throw new InvalidUtteranceError(
      `cost_eur must be a non-negative finite number, got ${input.cost_eur} — the §6 cap depends on it`,
    );
  }
  const intent = input.intent ?? null;
  if (intent !== null && input.role === "system") {
    throw new InvalidUtteranceError(
      "only the owner's own turns carry intent (conversation-channel.md §5) — system turns are never classified",
    );
  }
  return {
    id: input.id,
    profile_id: input.profile_id,
    thread_id: input.thread_id,
    role: input.role,
    text: input.text,
    at: input.at,
    intent,
    extracted_fields: input.extracted_fields ?? [],
    confirmed: input.confirmed ?? false,
    cost_eur: input.cost_eur,
  };
}
