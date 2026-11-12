// The interviewer — P0-48 / step 22.
//
// Given a profile, the current bank, and this session's history, pick the
// next question via Sonnet and return its id + selection_reason. The
// model chooses; the SYSTEM guarantees: candidates are computed by the
// deterministic resolver + tier gate, and the model's pick is validated
// against them, so an inapplicable or repeated question cannot escape
// this function no matter what the model says. One retry with feedback,
// then a hard error (retry caps per cost discipline).

import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { fieldRecords } from "../../db/schema";
import { readAnswer } from "../llm/answer";
import { anthropicClient } from "../llm/client";
import { buildCallRecord, recordLlmCall } from "../llm/cost-log";
import type { LlmCallRecord } from "../llm/cost-log";
import type { SonnetModel } from "../llm/models";
import type { AppLocale } from "../i18n/locales";
import { sonnetModel, thinkingOff } from "../llm/models";
import type { ApplicableQuestion } from "../resolver/applicability";
import { applicableQuestions } from "../resolver/applicability";
import {
  channels,
  competitors,
  costItems,
  customerSegments,
  goals,
  offers,
  staffRoles,
  suppliers,
} from "../../db/schema";
import type { AskedEntry, InterviewerBank, SystemBlock } from "./prompt";
import { buildSystemBlocks, buildUserMessage, loadInterviewerBank } from "./prompt";
import type { CandidateSelection } from "./select";
import { QuotaError, assertWithinQuota } from "../billing/usage";
import { applyFirstInterview } from "./first-interview";
import { selectCandidates } from "./select";

export class InterviewerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterviewerError";
  }
}

export interface NextQuestion {
  question: ApplicableQuestion;
  selection_reason: string;
  selection: CandidateSelection;
  calls: readonly LlmCallRecord[];
}

const MAX_ATTEMPTS = 2;
const MAX_TOKENS = 300;

interface SelectionPayload {
  next_question_id: string;
  selection_reason: string;
}

// Deliberately STATIC: a per-turn enum of candidate ids would be the
// cleaner constraint, but the schema participates in the prompt-cache
// prefix — measured live, it drove cache hits to 0% and cost to ~9x
// (rule 8). Validity is enforced our side instead: retry with feedback,
// then fall back deterministically to the first candidate.
const OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    next_question_id: { type: "string" as const },
    selection_reason: { type: "string" as const },
  },
  required: ["next_question_id", "selection_reason"],
  additionalProperties: false,
};

const bankCache = new Map<AppLocale, Promise<{ bank: InterviewerBank; system: SystemBlock[] }>>();

/**
 * Bank + system blocks are per-process constants per language — byte-stable
 * for the cache (rule 8). L-2: one prefix per language the owner reads in.
 */
function cachedSystem(
  locale: AppLocale = "en",
): Promise<{ bank: InterviewerBank; system: SystemBlock[] }> {
  let pending = bankCache.get(locale);
  if (!pending) {
    pending = loadInterviewerBank(locale).then((bank) => ({
      bank,
      system: buildSystemBlocks(bank),
    }));
    bankCache.set(locale, pending);
  }
  return pending;
}

/** Test/bank-reload hook. */
export function resetInterviewerBankCache(): void {
  bankCache.clear();
}

/**
 * The interviewer's request, built in one place so its shape is testable
 * without a database. Selection is a small structured decision: no
 * thinking, low effort. "No thinking" is {type:"disabled"} on Sonnet 5 and
 * {type:"between_tools"} on Sonnet 5.5, where "disabled" is a 400 and
 * between_tools needs effort high or below — low is. The system blocks
 * (the bank, with its cache breakpoint) come first and unchanged on both
 * models: rule 8's prefix does not depend on the model choice.
 */
export function interviewerRequest(
  model: SonnetModel,
  system: SystemBlock[],
  userMessage: string,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: MAX_TOKENS,
    thinking: thinkingOff(model),
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    system,
    messages: [{ role: "user", content: userMessage }],
  };
}

const SPINES = [
  ["offers", offers],
  ["suppliers", suppliers],
  ["channels", channels],
  ["competitors", competitors],
  ["staff_roles", staffRoles],
  ["cost_items", costItems],
  ["customer_segments", customerSegments],
  ["goals", goals],
] as const;

interface ProfileState {
  responded: Set<string>;
  summary: { field_key: string; repr: string }[];
  unknownOrSkipped: string[];
}

function repr(value: unknown): string {
  const s = JSON.stringify(value);
  return s === undefined ? "null" : s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

async function loadProfileState(profileId: string): Promise<ProfileState> {
  const records = await db
    .select({
      field_key: fieldRecords.field_key,
      status: fieldRecords.status,
      value: fieldRecords.value,
    })
    .from(fieldRecords)
    .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at)));

  const responded = new Set<string>();
  const summary: { field_key: string; repr: string }[] = [];
  const unknownOrSkipped: string[] = [];
  for (const r of records) {
    if (r.status === "answered" || r.status === "inferred") {
      responded.add(r.field_key);
      summary.push({ field_key: r.field_key, repr: repr(r.value) });
    } else if (r.status === "unknown") {
      responded.add(r.field_key);
      unknownOrSkipped.push(r.field_key);
    } else if (r.status === "skipped") {
      unknownOrSkipped.push(r.field_key);
    }
  }
  summary.sort((a, b) => (a.field_key < b.field_key ? -1 : 1));
  unknownOrSkipped.sort();

  for (const [key, table] of SPINES) {
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.profile_id, profileId));
    if (rows.length > 0) responded.add(key);
  }
  return { responded, summary, unknownOrSkipped };
}

/**
 * Pick the next question for a profile, or null when the interview is
 * complete (no open applicable questions remain — deterministic, no model
 * call). `asked` is this session's history in ask order.
 */
export async function pickNextQuestion(args: {
  accountId: string;
  profileId: string;
  asked: readonly AskedEntry[];
  /** SONNET_MODEL unless a caller (the recalibration harness) names one. */
  model?: SonnetModel;
  /** The language the owner reads the interview in (L-2); English when absent. */
  locale?: AppLocale;
}): Promise<NextQuestion | null> {
  const model = args.model ?? sonnetModel();
  // The multi-market spec §B.4: at the plan's hard cap the interviewer asks nothing more this month.
  try {
    await assertWithinQuota(args.accountId, args.profileId, "llm_tokens");
  } catch (error) {
    if (error instanceof QuotaError) return null;
    throw error;
  }
  const [{ system }, applicable, state] = await Promise.all([
    cachedSystem(args.locale ?? "en"),
    applicableQuestions(args.profileId),
    loadProfileState(args.profileId),
  ]);

  const askedIds = new Set(args.asked.map((a) => a.question_id));
  const picked = selectCandidates(applicable, state.responded, askedIds);
  // The v1 spec §6.5: nothing a live connection measures; the 8-minute first interview.
  const allowed = await applyFirstInterview({
    profileId: args.profileId,
    accountId: args.accountId,
    applicable,
    candidates: picked.candidates,
  });
  const selection = {
    ...picked,
    candidates: allowed,
    tier: allowed.length > 0 ? picked.tier : null,
  };
  if (selection.tier === null) return null;

  const byId = new Map(selection.candidates.map((q) => [q.id, q]));
  const calls: LlmCallRecord[] = [];
  let feedback: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const userMessage = buildUserMessage({
      profileSummary: state.summary,
      unknownOrSkipped: state.unknownOrSkipped,
      asked: args.asked,
      candidateIds: selection.candidates.map((q) => q.id),
      ...(feedback === undefined ? {} : { feedback }),
    });

    const started = Date.now();
    const response = await anthropicClient().messages.create(
      interviewerRequest(model, system, userMessage),
    );

    const record = buildCallRecord({
      workload: "interviewer",
      account_id: args.accountId,
      model,
      duration_ms: Date.now() - started,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      },
    });
    await recordLlmCall(record);
    calls.push(record);

    // Refusal first (logged with the account id), never parsed; then the
    // answer by block type — a 5.5 reply can carry thinking blocks ahead of it.
    const { text, refusal } = readAnswer(response, record);
    if (refusal !== null) {
      throw new InterviewerError(`model refused the selection request (${refusal})`);
    }
    if (response.stop_reason !== "end_turn") {
      throw new InterviewerError(`unexpected stop_reason "${response.stop_reason}"`);
    }
    let payload: SelectionPayload;
    try {
      payload = JSON.parse(text) as SelectionPayload;
    } catch {
      throw new InterviewerError(
        `model returned non-JSON despite output schema: ${text.slice(0, 200)}`,
      );
    }

    const question = byId.get(payload.next_question_id);
    if (question) {
      return { question, selection_reason: payload.selection_reason, selection, calls };
    }
    console.error(
      JSON.stringify({
        msg: "interviewer picked outside candidates",
        account_id: args.accountId,
        attempt,
        picked: payload.next_question_id,
        candidates: selection.candidates.map((q) => q.id),
      }),
    );
    feedback = `"${payload.next_question_id}" is not in CANDIDATES — choose one of the listed ids exactly.`;
  }

  // The model exhausted its attempts outside the candidate list. The tier
  // gate still holds absolutely: fall back to the deterministic first
  // candidate rather than crashing the interview — P0-53's guarantees
  // (never inapplicable, never repeated) live in the candidate set, not
  // in the model's cooperation.
  const fallback = selection.candidates[0];
  if (!fallback) throw new InterviewerError("no candidates despite an open tier");
  return {
    question: fallback,
    selection_reason: "fallback: deterministic first candidate after invalid model picks",
    selection,
    calls,
  };
}

/** Used by scripts that need the spine list for cleanup. */
export { SPINES as INTERVIEWER_SPINES };
