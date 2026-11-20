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
//
// Since 2026-11-20 (the owner: "work on the three things you said it doesn't
// do") every kind of question is answered here: a month is picked, a table
// is built one row and one field at a time, and a file says what the form
// says (uploads are not open yet). Typed words that plainly ask for the
// interview start it, with no model.

import { readTypedAmount } from "../../lib/intake/amount-input";
import type { AnswerAction, EntityField, IntakeQuestion } from "../../lib/intake/types";

/**
 * How a question is answered in the conversation:
 *   "choice"  one of its options is pressed (a yes or no among them)
 *   "many"    several options are picked, then Next
 *   "words"   a sentence or a name is typed
 *   "figure"  a number is typed
 *   "amount"  an amount of money is typed, in the business's currency
 *   "month"   a month is picked (the bank's one date asks for a month)
 *   "rows"    a table: one row at a time, one field of it at a time
 *   "file"    a file: uploads are not open yet, so it is skipped or not known
 *   "form"    a kind of question this conversation has no way to take yet:
 *             Lex gives the way to it on the form
 */
export type AnswerKind =
  "choice" | "many" | "words" | "figure" | "amount" | "month" | "rows" | "file" | "form";

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
    case "date":
      return "month";
    case "entity_list":
      return "rows";
    case "file":
      return "file";
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

/**
 * Pure: a picked month ("2021-03") as the date the endpoint takes, the first
 * of that month, exactly as the form's month picker sends it. A browser with
 * no month picker shows a text box, where a full date typed out is kept as
 * it is. Null when nothing was picked.
 */
export function monthAnswer(raw: string): AnswerAction | null {
  const v = raw.trim();
  if (v === "") return null;
  return { kind: "value", wire: /^\d{4}-\d{2}$/.test(v) ? `${v}-01` : v };
}

/** One exchange of the interview, as the conversation shows it afterwards. */
export interface Exchange {
  id: string;
  prompt: string;
  /** The answer in words: the option's label, what was typed, or that it was skipped. */
  answer: string;
  /** Whether it holds an answer that can be changed (a skip has none to reopen). */
  answered: boolean;
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

/* ── a table of rows, built in the conversation ── */

/** As many rows as the form's own table takes. */
export const ROWS_MAX = 20;

/**
 * How one field of a row is answered. The same kinds as a question, less the
 * ones a row cannot hold here: a date in a row is typed, as on the form, and
 * a table or a file inside a row is not asked.
 */
export function fieldKind(field: Pick<EntityField, "input_type">): AnswerKind | null {
  switch (field.input_type) {
    case "date":
      return "words";
    case "entity_list":
    case "file":
      return null;
    default:
      return answerKind(field);
  }
}

/** The fields of a table's row in the order they are asked. */
export interface RowsPlan {
  /** The field a row cannot do without: the first one, as on the form. */
  anchor: EntityField;
  /** Asked for every row, the anchor first. */
  core: EntityField[];
  /** Asked only when the owner wants to add detail to a row. */
  rest: EntityField[];
}

/** Pure: the plan for a table's rows, or null when it has no field that can be asked. */
export function rowsPlan(fields: readonly EntityField[]): RowsPlan | null {
  const askable = fields.filter((f) => fieldKind(f) !== null);
  const core = askable.filter((f) => f.priority === "core");
  const anchor = core[0] ?? askable[0];
  if (!anchor) return null;
  return {
    anchor,
    core: core.length > 0 ? core : [anchor],
    rest: askable.filter((f) => f.priority !== "core" && f !== anchor),
  };
}

export interface RowsDraft {
  /** The finished rows, each as the endpoint takes it. */
  rows: Record<string, unknown>[];
  /** The row being built or given its detail; null between rows. */
  current: Record<string, unknown> | null;
  /** The key of the field being asked; null between rows. */
  asking: string | null;
  /** The finished row `current` is the detail of; null while a new row is built. */
  editing: number | null;
  /** Whether the last row has been given its detail already. */
  detailed: boolean;
}

/** Pure: a table before anything is said: the first row's first field is asked. */
export function startRows(plan: RowsPlan): RowsDraft {
  return { rows: [], current: {}, asking: plan.anchor.key, editing: null, detailed: false };
}

/**
 * Pure: the draft after the field being asked was answered (`wire`) or left
 * out (undefined). The next field of the same pass is asked; after the last
 * one the row is finished and nothing is asked until the owner says what
 * next (another row, detail for this one, or that is all).
 */
export function fieldAnswered(draft: RowsDraft, plan: RowsPlan, wire: unknown): RowsDraft {
  if (draft.current === null || draft.asking === null) return draft;
  const current = wire === undefined ? draft.current : { ...draft.current, [draft.asking]: wire };
  const pass = draft.editing === null ? plan.core : plan.rest;
  const next = pass[pass.findIndex((f) => f.key === draft.asking) + 1];
  if (next) return { ...draft, current, asking: next.key };
  if (draft.editing !== null) {
    const at = draft.editing;
    return {
      rows: draft.rows.map((r, i) => (i === at ? current : r)),
      current: null,
      asking: null,
      editing: null,
      detailed: true,
    };
  }
  // A row with no first field is no row: the form does not send one either.
  const named = current[plan.anchor.key] !== undefined;
  return {
    rows: named ? [...draft.rows, current] : draft.rows,
    current: null,
    asking: null,
    editing: null,
    detailed: false,
  };
}

/** Pure: another row is started, while the table has room for one. */
export function anotherRow(draft: RowsDraft, plan: RowsPlan): RowsDraft {
  if (draft.current !== null || draft.rows.length >= ROWS_MAX) return draft;
  return { ...draft, current: {}, asking: plan.anchor.key, editing: null };
}

/** Pure: the last row is given its detail: the fields that are not asked for every row. */
export function rowDetail(draft: RowsDraft, plan: RowsPlan): RowsDraft {
  const at = draft.rows.length - 1;
  const first = plan.rest[0];
  const row = draft.rows[at];
  if (draft.current !== null || !row || !first) return draft;
  return { ...draft, current: { ...row }, asking: first.key, editing: at };
}

/** Pure: a finished row taken out again. With none left, the first row is asked for anew. */
export function withoutRow(draft: RowsDraft, plan: RowsPlan, index: number): RowsDraft {
  if (draft.current !== null || index < 0 || index >= draft.rows.length) return draft;
  const rows = draft.rows.filter((_, i) => i !== index);
  return rows.length === 0 ? startRows(plan) : { ...draft, rows, detailed: false };
}

/** How a row's values are said. Figures are formatted by the screen, in the reader's language. */
export interface RowSay {
  yes: string;
  no: string;
  money: (major: number, currency: string) => string;
  figure: (n: number) => string;
}

/**
 * Pure: a row in words, one entry per field that holds a value, in the
 * table's own order. A code is said by its option's label.
 */
export function rowWords(
  fields: readonly EntityField[],
  row: Readonly<Record<string, unknown>>,
  say: RowSay,
): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const v = row[f.key];
    if (v === undefined || v === null || v === "") continue;
    const label = (code: unknown): string =>
      f.options.find((o) => o.code === code)?.label ?? String(code);
    if (Array.isArray(v)) {
      if (v.length > 0) out.push(v.map(label).join(", "));
    } else if (typeof v === "boolean") out.push(v ? say.yes : say.no);
    else if (typeof v === "number") out.push(say.figure(v));
    else if (typeof v === "object" && "amount_major" in v) {
      out.push(say.money(Number((v as { amount_major: unknown }).amount_major), f.currency));
    } else out.push(f.options.length > 0 ? label(v) : String(v));
  }
  return out;
}

/* ── asking for the interview in words ── */

const DO = String.raw`(?:do|start|begin|continue|resume|finish|take)`;
const IT = String.raw`(?:the|my|our|this|that)\s+interview`;

/** Words that plainly ask for the interview. English, like the change catalogue's cues. */
const ASKS: readonly RegExp[] = [
  new RegExp(
    String.raw`^(?:please\s+|ok(?:ay)?[,\s]+|yes[,\s]+)?(?:let'?s|let us)\s+${DO}\s+${IT}\b`,
  ),
  new RegExp(String.raw`^(?:please\s+|ok(?:ay)?[,\s]+|yes[,\s]+)?${DO}\s+${IT}\b`),
  new RegExp(String.raw`^(?:can|could|will|would)\s+(?:you|we)\s+(?:please\s+)?${DO}\s+${IT}\b`),
  new RegExp(String.raw`^i(?:'d| would)?\s+(?:like|want)\s+to\s+${DO}\s+${IT}\b`),
  /^(?:please\s+)?interview me\b/,
  /^(?:please\s+)?ask me (?:the|your|those|my)\s+(?:interview\s+)?questions\b/,
];

/** Said about another time or another place: not a request to begin here and now. */
const NOT_NOW =
  /\b(later|tomorrow|another (?:time|day)|not now|next week|on the form|in the form)\b/;

/**
 * Pure: whether these words plainly ask for the interview, here and now.
 * Deterministic and English only, as the change catalogue's cues are
 * (lib/assistant/catalogue.ts): what it does not recognise goes to Lex like
 * any other message, and his reply offers the same thing as a button. A
 * question about the interview ("how long does it take?") is never a request.
 */
export function asksForInterview(text: string): boolean {
  const said = text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[’‘]/g, "'");
  if (said === "" || said.length > 120) return false;
  if (NOT_NOW.test(said)) return false;
  return ASKS.some((cue) => cue.test(said));
}
