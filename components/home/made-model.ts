// Home's "Made" list (docs/DASHBOARD-OVERHAUL.md C7) — pure. Everything Lex
// drafted, whatever became of it: what waits first, then the rest, newest
// first, each with one line of the thing itself. The line is the
// proposal's own words (its stated before and after, or what it would
// send, publish or change); nothing is summarised by a model here.

import { parseTs } from "../chat/chat-view";
import { answerOf } from "./activity-model";

export type MadeState =
  "waiting" | "approved" | "declined" | "changes" | "done" | "expired" | "blocked";

export interface MadeProposal {
  id: string;
  status: string;
  module?: string | null;
  action: { kind?: string; summary: string; detail?: unknown };
  created_at?: string | null;
  decided_at?: string | null;
}

export interface MadeRow<P extends MadeProposal = MadeProposal> {
  proposal: P;
  state: MadeState;
  ms: number;
}

/**
 * Pure: the list. A status with no word (one this screen doesn't know) is
 * left out rather than shown as waiting.
 */
export function madeRows<P extends MadeProposal>(all: readonly P[], limit = 12): MadeRow<P>[] {
  const rows = all.flatMap((proposal): MadeRow<P>[] => {
    const state: MadeState | null =
      proposal.status === "pending" ? "waiting" : answerOf(proposal.status);
    if (state === null) return [];
    const at = parseTs(
      (state === "waiting" ? null : proposal.decided_at) ?? proposal.created_at ?? "",
    );
    return [{ proposal, state, ms: Number.isNaN(at) ? 0 : at }];
  });
  rows.sort(
    (a, b) =>
      Number(b.state === "waiting") - Number(a.state === "waiting") ||
      b.ms - a.ms ||
      (a.proposal.id < b.proposal.id ? -1 : 1),
  );
  return rows.slice(0, limit);
}

const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const first = (v: unknown): Record<string, unknown> | null =>
  Array.isArray(v) && typeof v[0] === "object" && v[0] !== null
    ? (v[0] as Record<string, unknown>)
    : null;

/**
 * Pure: one line of the thing itself. A stated before and after reads whole
 * when it is short ("€24 → €26") and as what it would become when it is
 * long (a page's new wording); otherwise what would be sent, the first
 * answer or item, or the reason given. Null when the proposal says none.
 */
export function previewOf(
  detail: unknown,
  lines: readonly { before: string; after: string }[] | null,
  max = 120,
): string | null {
  const line = lines?.[0];
  if (line) {
    const pair = `${line.before} → ${line.after}`;
    return pair.length <= max ? pair : clip(line.after, max);
  }
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as Record<string, unknown>;
  const found =
    text(d.what) ??
    text(first(d.entries)?.answer) ??
    text(first(d.items)?.brief) ??
    text(d.rationale);
  return found === null ? null : clip(found, max);
}
