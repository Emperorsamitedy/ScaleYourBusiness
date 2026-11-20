// The single-proposal card — idea 53 (I-53.5). Pure: what the card says,
// from the proposal's own data and the owner's recorded limits. The card
// (ProposalCard.tsx) draws it; the queue's own helpers (queue-model.ts)
// format the money, the range and the reversibility, so the card and the
// queue can never word one proposal two ways.
//
// L-3a: its words are the "proposals.card" catalogue (and the queue's own)
// through an optional translator, English by default; dates and figures
// in the reader's locale. The owner's quoted limits and the forecast's
// statements are shown as they were written.

import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type { ReversibilityLike, ScenarioOutcomeLike } from "./queue-model";
import {
  dayWord,
  clockWord,
  effectRange,
  rangeWords,
  reversibilityLabel,
  signedMoney,
  wholeMoney,
} from "./queue-model";

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

/** The card's words and the reader's locale: the "proposals" catalogue. */
export interface CardWords {
  tr: Tr;
  locale: AppLocale;
}
const ENGLISH = (): CardWords => ({ tr: englishTr("proposals"), locale: "en" });

/** Whether the card can be decided, and if not, the sentence that says why. No buttons unless "decide". */
export type CardState = { kind: "decide" } | { kind: "closed"; word: string; sentence: string };

export function cardState(
  p: CardProposal,
  now: Date,
  timeZone?: string,
  w: CardWords = ENGLISH(),
): CardState {
  const { tr, locale } = w;
  const when = (iso: string | null) =>
    iso
      ? tr("card.when", {
          day: dayWord(iso, timeZone, locale),
          clock: clockWord(iso, timeZone, locale),
        })
      : tr("card.earlier");
  if (p.status === "pending" && p.expires_at > now.toISOString()) return { kind: "decide" };
  if (p.status === "pending" || p.status === "expired") {
    return {
      kind: "closed",
      word: tr("history.expired"),
      sentence: tr("card.expired", { day: dayWord(p.expires_at, timeZone, locale) }),
    };
  }
  if (p.status === "approved" || p.status === "executed") {
    return {
      kind: "closed",
      word: p.status === "executed" ? tr("card.done") : tr("history.approved"),
      sentence: `${tr("card.approved", { when: when(p.decided_at) })}${p.status === "executed" ? ` ${tr("card.ran")}` : ""}`,
    };
  }
  if (p.status === "rejected") {
    return {
      kind: "closed",
      word: tr("history.rejected"),
      sentence: tr("card.declined", { when: when(p.decided_at) }),
    };
  }
  if (p.status === "changes_requested") {
    return {
      kind: "closed",
      word: tr("history.changes_requested"),
      sentence: tr("card.changes", { when: when(p.decided_at) }),
    };
  }
  if (p.status === "blocked") {
    const said = p.blocked_by_limit?.replace(/^13\.5:\s*/, "") ?? "";
    return {
      kind: "closed",
      word: tr("card.heldBack"),
      sentence: tr(/[.!?]$/.test(said) ? "card.blockedEnded" : "card.blocked", { said }),
    };
  }
  return {
    kind: "closed",
    word: p.status.toUpperCase(),
    sentence: tr("card.notUp"),
  };
}

/**
 * The gain as a range, never a point: "+€120 – +€480", in whole units (the
 * queue's own wording). Null when the cases carry no money.
 */
export function gainLine(p: CardProposal, locale: AppLocale = "en"): string | null {
  const range = effectRange(p.scenario.downside_case, p.scenario.upside_case);
  return range ? rangeWords(range, locale) : null;
}

/** Past this many characters a change's two sides are sentences, not figures (the queue's own line). */
export const WORDS_OVER = 48;

/**
 * Pure: whether a change's before and after read as sentences. Figures sit
 * on one right-aligned line ("€38.00 → €41.40"); sentences stack, each side
 * named, so the two can't run together.
 */
export function readsAsWords(line: { before: string; after: string }): boolean {
  return line.before.length + line.after.length > WORDS_OVER;
}

/** The worst case: the downside's money when it has some, and its words. */
export function worstCase(p: CardProposal, w: CardWords = ENGLISH()): string {
  const d = p.scenario.downside_case;
  const money = d?.profit_delta_monthly;
  const words = d?.statement?.trim() ?? "";
  if (money && Number.isSafeInteger(money.amount_minor) && typeof money.currency === "string") {
    const sum = signedMoney(wholeMoney(money), w.locale);
    return words ? `${sum}: ${words}` : sum;
  }
  return words || w.tr("card.noWorst");
}

export function undoLine(
  p: CardProposal,
  tr: Tr = ENGLISH().tr,
): { word: string; note: string; reversible: boolean } {
  return reversibilityLabel(p.reversibility, p.action.detail, tr);
}

/**
 * What it was checked against: the owner's 13.5 answer. Machine-checked
 * limits passed (a proposal that broke one is born blocked, rule 14); the
 * ones code can't check ride along for the owner to weigh.
 */
export function limitLines(limits: readonly CardLimit[] | null, tr: Tr = ENGLISH().tr): string[] {
  if (limits === null || limits.length === 0) {
    return [tr("card.noLimits", { question: "13.5" })];
  }
  const and = tr("card.and");
  const auto = limits.filter((l) => l.enforcement === "auto").map((l) => `“${l.quote}”`);
  const manual = limits.filter((l) => l.enforcement === "manual").map((l) => `“${l.quote}”`);
  const lines: string[] = [];
  if (auto.length > 0) {
    lines.push(tr("card.checked", { limits: auto.join(` ${and} `), count: auto.length }));
  }
  if (manual.length > 0) {
    lines.push(tr("card.cantCheck", { limits: manual.join(` ${and} `), count: manual.length }));
  }
  return lines;
}
