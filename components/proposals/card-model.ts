// The single-proposal card — idea 53 (I-53.5). Pure: what the card says,
// from the proposal's own data and the owner's recorded limits. The card
// (ProposalCard.tsx) draws it; the queue's own helpers (queue-model.ts)
// format the money, the range and the reversibility, so the card and the
// queue can never word one proposal two ways.

import type { ReversibilityLike, ScenarioOutcomeLike } from "./queue-model";
import { dayWord, clockWord, effectRange, reversibilityLabel, signedMoney } from "./queue-model";

export interface CardProposal {
  id: string;
  status: string;
  action: { kind: string; summary: string; detail?: unknown };
  scenario: {
    downside_case?: ScenarioOutcomeLike & { statement?: string };
    upside_case?: ScenarioOutcomeLike & { statement?: string };
    base_case?: ScenarioOutcomeLike & { statement?: string };
  };
  reversibility: ReversibilityLike | null;
  blocked_by_limit: string | null;
  expires_at: string;
  decided_at: string | null;
}

export interface CardLimit {
  quote: string;
  enforcement: "auto" | "manual";
}

/** Whether the card can be decided, and if not, the sentence that says why. No buttons unless "decide". */
export type CardState = { kind: "decide" } | { kind: "closed"; word: string; sentence: string };

export function cardState(p: CardProposal, now: Date, timeZone?: string): CardState {
  const when = (iso: string | null) =>
    iso ? `${dayWord(iso, timeZone)}, ${clockWord(iso, timeZone)}` : "earlier";
  if (p.status === "pending" && p.expires_at > now.toISOString()) return { kind: "decide" };
  if (p.status === "pending" || p.status === "expired") {
    return {
      kind: "closed",
      word: "EXPIRED",
      sentence: `This ran out of time on ${dayWord(p.expires_at, timeZone)} without a decision: not approved, and nothing ran.`,
    };
  }
  if (p.status === "approved" || p.status === "executed") {
    return {
      kind: "closed",
      word: p.status === "executed" ? "DONE" : "APPROVED",
      sentence: `Already decided: approved ${when(p.decided_at)}.${p.status === "executed" ? " It has run." : ""}`,
    };
  }
  if (p.status === "rejected") {
    return {
      kind: "closed",
      word: "DECLINED",
      sentence: `Already decided: declined ${when(p.decided_at)}. Nothing ran.`,
    };
  }
  if (p.status === "changes_requested") {
    return {
      kind: "closed",
      word: "CHANGES REQUESTED",
      sentence: `Already answered: you asked for changes ${when(p.decided_at)}. Nothing runs from it.`,
    };
  }
  if (p.status === "blocked") {
    const said = p.blocked_by_limit?.replace(/^13\.5:\s*/, "") ?? "";
    return {
      kind: "closed",
      word: "HELD BACK",
      sentence: `I held this back myself: you said “${said}”${/[.!?]$/.test(said) ? "" : "."} It isn't up for a decision.`,
    };
  }
  return {
    kind: "closed",
    word: p.status.toUpperCase(),
    sentence: "This isn't up for a decision.",
  };
}

/** The gain as a range, never a point: "+€120 – +€480". Null when the cases carry no money. */
export function gainLine(p: CardProposal): string | null {
  const range = effectRange(p.scenario.downside_case, p.scenario.upside_case);
  return range ? `${signedMoney(range.low)} – ${signedMoney(range.high)}` : null;
}

/** The worst case: the downside's money when it has some, and its words. */
export function worstCase(p: CardProposal): string {
  const d = p.scenario.downside_case;
  const money = d?.profit_delta_monthly;
  const words = d?.statement?.trim() ?? "";
  if (money && Number.isSafeInteger(money.amount_minor) && typeof money.currency === "string") {
    return words ? `${signedMoney(money)}: ${words}` : signedMoney(money);
  }
  return words || "No worst case was forecast for this one.";
}

export function undoLine(p: CardProposal): { word: string; note: string; reversible: boolean } {
  return reversibilityLabel(p.reversibility, p.action.detail);
}

/**
 * What it was checked against: the owner's 13.5 answer. Machine-checked
 * limits passed (a proposal that broke one is born blocked, rule 14); the
 * ones code can't check ride along for the owner to weigh.
 */
export function limitLines(limits: readonly CardLimit[] | null): string[] {
  if (limits === null || limits.length === 0) {
    return [
      "You haven't told me anything you'd never want done (question 13.5), so there was nothing to check it against.",
    ];
  }
  const auto = limits.filter((l) => l.enforcement === "auto").map((l) => `“${l.quote}”`);
  const manual = limits.filter((l) => l.enforcement === "manual").map((l) => `“${l.quote}”`);
  const lines: string[] = [];
  if (auto.length > 0) {
    lines.push(
      `Checked against ${auto.join(" and ")}: it doesn't go against ${auto.length === 1 ? "it" : "them"}.`,
    );
  }
  if (manual.length > 0) {
    lines.push(
      `I can't check ${manual.join(" and ")} for you: weigh this against ${manual.length === 1 ? "it" : "them"} yourself.`,
    );
  }
  return lines;
}
