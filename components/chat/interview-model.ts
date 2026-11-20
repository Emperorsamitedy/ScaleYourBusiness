// The interview with Lex, the rules (the owner's fourth round, 2026-11-20:
// "give the user the option to complete the interview himself and/or use lex
// instead ... as lex asks the questions with options and the user answers").
//
// Lex asks the interview's own questions in the conversation. Nothing here
// decides which question comes next or what a question says: both arrive
// from the interview's API (lib/intake/service, the resolver over the bank:
// rule 4), and an answer goes back through the same endpoint the form uses,
// so the same fact lands on the fact sheet with the same source. No model
// takes part. This file is only how a question is answered in a
// conversation and how the answer is put into the shape that endpoint takes.

import { readTypedAmount } from "../../lib/intake/amount-input";
import type { AnswerAction, IntakeQuestion } from "../../lib/intake/types";

/**
 * How a question is answered in the conversation:
 *   "choice"  one of its options is pressed (a yes or no among them)
 *   "many"    several options are picked, then Next
 *   "words"   a sentence or a name is typed
 *   "figure"  a number is typed
 *   "amount"  an amount of money is typed, in the business's currency
 *   "form"    a date, a table of rows or a file: answered on the form, where
 *             the control for it is
 */
export type AnswerKind = "choice" | "many" | "words" | "figure" | "amount" | "form";

export function answerKind(question: Pick<IntakeQuestion, "input_type">): AnswerKind {
  switch (question.input_type) {
    case "single_select":
    case "boolean":
      return "choice";
    case "multi_select":
      return "many";
    case "text":
    case "long_text":
      return "words";
    case "number":
      return "figure";
    case "money":
      return "amount";
    default:
      return "form";
  }
}

export interface Choice {
  id: string;
  label: string;
  /** What the interview's endpoint takes for this choice. */
  wire: unknown;
}

/** The buttons of a question that is answered by pressing: its options, or Yes and No. */
export function choicesOf(
  question: Pick<IntakeQuestion, "input_type" | "options">,
  words: { yes: string; no: string },
): Choice[] {
  if (question.input_type === "boolean") {
    return [
      { id: "yes", label: words.yes, wire: true },
      { id: "no", label: words.no, wire: false },
    ];
  }
  return question.options.map((o) => ({ id: o.code, label: o.label, wire: o.code }));
}

export type Typed =
  | { ok: true; action: AnswerAction }
  /** Nothing was typed. */
  | { ok: false; reason: "empty" }
  /** Not a number at all. */
  | { ok: false; reason: "unreadable" }
  /** "1.200": twelve hundred, or one point two? Never guessed (lib/intake/amount-input). */
  | { ok: false; reason: "unclear" };

/**
 * Pure: what was typed, as the answer the interview's endpoint takes. Money
 * stays a decimal the server turns into minor units with the business's
 * currency (rule 1); a figure that can be read two ways is not guessed.
 */
export function typedAnswer(kind: AnswerKind, raw: string): Typed {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (kind === "words") return { ok: true, action: { kind: "value", wire: text } };
  if (kind !== "figure" && kind !== "amount") return { ok: false, reason: "unreadable" };
  const read = readTypedAmount(text);
  if (read.kind === "empty") return { ok: false, reason: "empty" };
  if (read.kind === "ambiguous") return { ok: false, reason: "unclear" };
  if (read.kind === "unreadable") return { ok: false, reason: "unreadable" };
  const n = Number(read.decimal);
  if (!Number.isFinite(n)) return { ok: false, reason: "unreadable" };
  return {
    ok: true,
    action: { kind: "value", wire: kind === "amount" ? { amount_major: n } : n },
  };
}

/** Pure: the picked options of a "many" question as its answer, or null when none is picked. */
export function pickedAnswer(picked: readonly string[]): AnswerAction | null {
  return picked.length === 0 ? null : { kind: "value", wire: [...picked] };
}

/** One exchange of the interview, as the conversation shows it afterwards. */
export interface Exchange {
  id: string;
  prompt: string;
  /** The answer in words: the option's label, what was typed, or that it was skipped. */
  answer: string;
}

/** Pure: an answer in the words the conversation keeps beside its question. */
export function answerWords(
  action: AnswerAction,
  choices: readonly Choice[],
  typed: string,
  words: { unknown: string; skipped: string },
): string {
  if (action.kind === "unknown") return words.unknown;
  if (action.kind === "skip") return words.skipped;
  if (action.kind !== "value") return "";
  const wire = action.wire;
  if (Array.isArray(wire)) {
    return wire
      .map((code) => choices.find((c) => c.wire === code)?.label ?? String(code))
      .join(", ");
  }
  const one = choices.find((c) => c.wire === wire);
  return one ? one.label : typed.trim();
}
