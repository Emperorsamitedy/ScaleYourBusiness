// The interviewer — P0-48 / step 22.
//
// Given a profile, the current bank, and this session's history, pick the
// next question via Sonnet and return its id + selection_reason. The
// model chooses; the SYSTEM guarantees: candidates are computed by the
// deterministic resolver + tier gate, and the model's pick is validated
// against them, so an inapplicable or repeated question cannot escape
// this function no matter what the model says. One retry with feedback,
// then a hard error (retry caps per cost discipline).

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { fieldRecords } from "../../db/schema";
import { anthropicClient, INTERVIEWER_MODEL } from "../llm/client";
import { buildCallRecord, logLlmCall } from "../llm/cost-log";
import type { LlmCallRecord } from "../llm/cost-log";
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

const OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    next_question_id: { type: "string" as const },
    selection_reason: { type: "string" as const },
  },
  required: ["next_question_id", "selection_reason"],
  additionalProperties: false,
};

let bankCache: Promise<{ bank: InterviewerBank; system: SystemBlock[] }> | null = null;

/** Bank + system blocks are per-process constants — byte-stable for the cache. */
function cachedSystem(): Promise<{ bank: InterviewerBank; system: SystemBlock[] }> {
  bankCache ??= loadInterviewerBank().then((bank) => ({ bank, system: buildSystemBlocks(bank) }));
  return bankCache;
}

/** Test/bank-reload hook. */
export function resetInterviewerBankCache(): void {
  bankCache = null;
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
}): Promise<NextQuestion | null> {
  const [{ system }, applicable, state] = await Promise.all([
    cachedSystem(),
    applicableQuestions(args.profileId),
    loadProfileState(args.profileId),
  ]);

  const askedIds = new Set(args.asked.map((a) => a.question_id));
  const selection = selectCandidates(applicable, state.responded, askedIds);
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
    const response = await anthropicClient().messages.create({
      model: INTERVIEWER_MODEL,
      max_tokens: MAX_TOKENS,
      // Selection is a small structured decision: no thinking, low effort.
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      system,
      messages: [{ role: "user", content: userMessage }],
    });

    const record = buildCallRecord({
      workload: "interviewer",
      account_id: args.accountId,
      model: INTERVIEWER_MODEL,
      duration_ms: Date.now() - started,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      },
    });
    logLlmCall(record);
    calls.push(record);

    if (response.stop_reason === "refusal") {
      throw new InterviewerError("model refused the selection request");
    }
    if (response.stop_reason !== "end_turn") {
      throw new InterviewerError(`unexpected stop_reason "${response.stop_reason}"`);
    }
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
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
    feedback = `"${payload.next_question_id}" is not in CANDIDATES — choose one of the listed ids exactly.`;
  }

  throw new InterviewerError(
    `model failed to pick a valid candidate in ${MAX_ATTEMPTS} attempts (tier ${selection.tier}, ${selection.candidates.length} candidates)`,
  );
}

/** Used by scripts that need the spine list for cleanup. */
export { SPINES as INTERVIEWER_SPINES };
