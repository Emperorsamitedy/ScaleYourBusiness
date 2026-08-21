// SourceRef — data-model-v1.md §3.2, amended by conversation-channel.md §2.1.
//
// Seven kinds: §3.2's six plus "conversation" (step 13a). A
// conversation-sourced fact must point back at the exact message that
// produced it — when an owner later disputes a number, the system shows
// them the sentence it came from.
//
// Each kind requires its evidence and forbids everyone else's: a ref that
// names a connector AND a formula is two claims about provenance, and a
// fact has one source. The discriminated union makes most violations
// unrepresentable at compile time; validateSourceRef() re-checks at
// runtime for data crossing the JSON boundary.

import type { ConnectorId, DocumentId, FieldId, UtteranceId } from "./ids";

export const SOURCE_KINDS = [
  "owner_input",
  "conversation",
  "connector",
  "document",
  "inferred",
  "web_research",
  "system_default",
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export type SourceRef =
  | { kind: "owner_input" }
  | {
      kind: "conversation";
      /** The exact message this fact was extracted from (§2.1). */
      utterance_id: UtteranceId;
    }
  | { kind: "connector"; connector_id: ConnectorId }
  | { kind: "document"; document_id: DocumentId }
  | {
      kind: "inferred";
      /** Which fields produced it — never empty (rule 6). */
      derived_from: readonly FieldId[];
      /** The formula, e.g. "gross_margin = (price - cogs) / price". */
      method: string;
    }
  | { kind: "web_research"; researched_url: string }
  | { kind: "system_default" };

export class InvalidSourceRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSourceRefError";
  }
}

export function isSourceKind(value: string): value is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * Runtime validation for refs arriving from JSON. Enforces per-kind
 * requirements — most importantly rule 6: an inferred value that cannot
 * name its inputs and formula is an unexplainable number, and those are
 * banned from the profile.
 */
export function validateSourceRef(ref: SourceRef): SourceRef {
  switch (ref.kind) {
    case "owner_input":
    case "system_default":
      return ref;
    case "conversation":
      if (ref.utterance_id.trim() === "") {
        throw new InvalidSourceRefError(
          "conversation source must point at the utterance it came from — disputes replay the exact sentence",
        );
      }
      return ref;
    case "connector":
      if (ref.connector_id.trim() === "") {
        throw new InvalidSourceRefError("connector source must name its connector_id");
      }
      return ref;
    case "document":
      if (ref.document_id.trim() === "") {
        throw new InvalidSourceRefError("document source must name its document_id");
      }
      return ref;
    case "inferred":
      if (ref.derived_from.length === 0) {
        throw new InvalidSourceRefError(
          "inferred source must name the fields it was derived from (rule 6 — no unexplainable numbers)",
        );
      }
      if (ref.method.trim() === "") {
        throw new InvalidSourceRefError(
          "inferred source must state its method — the formula is part of the provenance (rule 6)",
        );
      }
      return ref;
    case "web_research":
      if (ref.researched_url.trim() === "") {
        throw new InvalidSourceRefError("web_research source must name the page it came from");
      }
      return ref;
  }
}
