// Interviewer prompt construction — P0-48 / step 22, caching per step 23.
//
// Cache design (rule 8): render order is system → messages, so the system
// prompt carries ONLY content that is byte-identical across every turn of
// every profile — the instructions and the question bank — with the
// cache_control breakpoint on the bank block. Everything volatile
// (profile state, history, candidates) lives in the per-turn user
// message, after the breakpoint. One cache entry therefore serves every
// turn of every interview until the bank version changes.
//
// Determinism matters at the byte level: the bank block is built with a
// fixed key order and a lexicographic id sort, and must never embed
// timestamps, ids, or anything per-request.
//
// L-2 (TASKS-LANGUAGES.md, rule 5): the owner may read the interview in
// another language. The cached prefix is then per language — the same
// instructions, and a bank block that names the language and carries each
// question's words in it (the overlay) beside the English. One cache entry
// per language, each byte-stable across turns and profiles. English's
// prefix is exactly what it was before L-2. The model still only chooses an
// id; what the owner reads is the overlay's text, never the model's.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { bankQuestions, bankVersions } from "../../db/schema";
import { loadBankWords } from "../bank/words";
import type { AppLocale } from "../i18n/locales";
import { LANGUAGE_FOR_MODEL } from "../llm/language";

export interface PromptBankQuestion {
  id: string;
  section: string;
  writes_to: string;
  priority: "core" | "important" | "deep" | "optional";
  cost: number;
  prompt_en: string;
  unlocks: readonly string[];
  /** The prompt as the owner reads it, when their language is not English (L-2). */
  prompt_local?: string;
}

export interface InterviewerBank {
  version: string;
  questions: readonly PromptBankQuestion[];
  /** The language the owner reads the interview in; English when absent. */
  locale?: AppLocale;
}

// Each language's English name, for the model: one table for every call
// site (lib/llm/language.ts, L-5), re-exported where L-2 first put it.
export { LANGUAGE_FOR_MODEL } from "../llm/language";

export class PromptBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptBuildError";
  }
}

/**
 * Load the current bank in prompt-ready, deterministically ordered form —
 * with the owner's language's words beside each English prompt when that
 * language is not English.
 */
export async function loadInterviewerBank(locale: AppLocale = "en"): Promise<InterviewerBank> {
  const [current] = await db.select().from(bankVersions).where(eq(bankVersions.is_current, true));
  if (!current) throw new PromptBuildError("no current bank version — run the bank loader first");
  const rows = await db
    .select()
    .from(bankQuestions)
    .where(eq(bankQuestions.bank_version, current.version));
  const questions = rows
    .map((r) => ({
      id: r.id,
      section: r.section,
      writes_to: r.writes_to,
      priority: r.priority,
      cost: r.cost,
      prompt_en: ((r.prompt as Record<string, string>).en ?? "").trim(),
      unlocks: (r.unlocks as string[] | null) ?? [],
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (locale === "en") return { version: current.version, questions };
  const words = await loadBankWords(locale);
  // An overlay missing for this version leaves the interview in English.
  if (words.locale === "en") return { version: current.version, questions };
  return {
    version: current.version,
    locale,
    questions: questions.map((q) => ({ ...q, prompt_local: words.prompt(q.id, q.prompt_en) })),
  };
}

const INSTRUCTIONS = `You are the interviewer for a small-business intake. Each turn you choose exactly ONE next question to ask the owner.

Rules, in priority order:
1. Choose only from CANDIDATES. Never any other id, never anything in ASKED.
2. Prefer natural flow: a direct follow-up to the last exchange (the previous question's "unlocks" list names its follow-ups), then the same topic, then a new topic in section order.
3. When flow is equal, prefer lower cost — cheap facts before hard ones. The owner should reach a usable profile before the demanding questions.
4. selection_reason is one short sentence saying why this question, now. It is stored and audited.

Respond with JSON only: {"next_question_id": "<id>", "selection_reason": "<sentence>"}

The full question bank follows, one JSON object per line (id, section, writes_to, priority, cost, unlocks, prompt).`;

function bankBlock(bank: InterviewerBank): string {
  const local = bank.locale && bank.locale !== "en" ? bank.locale : null;
  const lines = bank.questions.map((q) =>
    JSON.stringify(
      local
        ? {
            id: q.id,
            section: q.section,
            writes_to: q.writes_to,
            priority: q.priority,
            cost: q.cost,
            unlocks: q.unlocks,
            prompt: q.prompt_en,
            prompt_local: q.prompt_local ?? q.prompt_en,
          }
        : {
            id: q.id,
            section: q.section,
            writes_to: q.writes_to,
            priority: q.priority,
            cost: q.cost,
            unlocks: q.unlocks,
            prompt: q.prompt_en,
          },
    ),
  );
  const head = `QUESTION BANK ${bank.version} (${bank.questions.length} questions)`;
  if (!local) return `${head}\n${lines.join("\n")}`;
  const name = LANGUAGE_FOR_MODEL[local];
  // Per language, byte-stable: nothing here varies by turn or by profile.
  return [
    `${head} · LANGUAGE ${local}`,
    `The owner reads this interview in ${name}. Each question is shown to them exactly as its prompt_local reads; the English prompt is the source it was translated from. Their answers so far may be in ${name}. Choose by id exactly as you would in English. Write selection_reason in English: it is an audit record, never shown to the owner.`,
    ...lines,
  ].join("\n");
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/** The stable system prompt: instructions, then the bank with the cache breakpoint. */
export function buildSystemBlocks(bank: InterviewerBank): SystemBlock[] {
  return [
    { type: "text", text: INSTRUCTIONS },
    { type: "text", text: bankBlock(bank), cache_control: { type: "ephemeral" } },
  ];
}

export interface AskedEntry {
  question_id: string;
  answer_repr: string;
}

export interface TurnInput {
  /** field_key → short value representation, answered fields only. */
  profileSummary: readonly { field_key: string; repr: string }[];
  /** field_keys the owner explicitly couldn't or wouldn't answer. */
  unknownOrSkipped: readonly string[];
  asked: readonly AskedEntry[];
  candidateIds: readonly string[];
  /** Set on the retry after an invalid pick. */
  feedback?: string;
}

const HISTORY_TAIL = 5;

/** The volatile per-turn user message — everything after the cache breakpoint. */
export function buildUserMessage(input: TurnInput): string {
  const lines: string[] = [];
  lines.push("PROFILE (answered so far):");
  if (input.profileSummary.length === 0) {
    lines.push("  (empty — this is the first question)");
  } else {
    for (const f of input.profileSummary) lines.push(`  ${f.field_key} = ${f.repr}`);
  }
  if (input.unknownOrSkipped.length > 0) {
    lines.push(`UNKNOWN OR SKIPPED: ${input.unknownOrSkipped.join(", ")}`);
  }
  lines.push(
    `ASKED (${input.asked.length}, in order): ${input.asked.map((a) => a.question_id).join(", ") || "none"}`,
  );
  const tail = input.asked.slice(-HISTORY_TAIL);
  if (tail.length > 0) {
    lines.push("RECENT EXCHANGES:");
    for (const t of tail) lines.push(`  ${t.question_id} -> ${t.answer_repr}`);
  }
  lines.push(`CANDIDATES (choose exactly one): ${input.candidateIds.join(", ")}`);
  if (input.feedback) lines.push(`FEEDBACK: ${input.feedback}`);
  return lines.join("\n");
}
