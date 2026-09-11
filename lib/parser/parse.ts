// The answer parser — P0-54..57 / steps 24-25.
//
// Free text → typed Field writes. Haiku (CLAUDE.md routing: Haiku for
// parsing) extracts wire values for the ASKED question and — P0-56 — any
// OTHER open question the same paragraph happens to answer. Estimates
// ("about", "roughly") arrive flagged with the owner's wording preserved;
// per §8.1 a precise owner answer enters at 0.75 confidence, an estimated
// one at 0.55, with the hedge kept in `note` (P0-55).
//
// The LLM boundary is injectable (`llm` param) so every deterministic
// behavior is provable offline; the live path is exercised by
// verify-parser.ts (P0-58) alongside Session L's deferred runs.
//
// No prompt caching here, deliberately: the parser's stable prefix is
// ~1k tokens, under Haiku 4.5's 4096-token cacheable minimum — a
// breakpoint would be a silent no-op. Revisit if the prompt grows.

import { anthropicClient } from "../llm/client";
import { buildCallRecord, recordLlmCall } from "../llm/cost-log";
import type { LlmCallRecord } from "../llm/cost-log";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";
import type { ApplicableQuestion } from "../resolver/applicability";
import { vocabularyCodes } from "../vocab/validate";
import type { InputSpec } from "../interviewer/harness/answers";
import { coerceParsedValue } from "./coerce";

export const PARSER_MODEL = "claude-haiku-4-5";

/** §8.1 base confidences: owner input, precise vs estimated. */
export const CONFIDENCE_PRECISE = 0.75;
export const CONFIDENCE_ESTIMATED = 0.55;

export class ParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParserError";
  }
}

export interface ExtractedField {
  field_key: string;
  value: unknown;
  is_estimate: boolean;
  /** The owner's hedge wording, verbatim, when is_estimate. */
  estimate_wording: string | null;
}

export interface ParseOutcome {
  written: { field_key: string; confidence: number; note: string | null }[];
  rejected: { field_key: string; reason: string }[];
  calls: readonly LlmCallRecord[];
}

/** The LLM seam: given system+user prompts, return the extraction JSON text. */
export type ExtractionLlm = (args: {
  system: string;
  user: string;
  accountId: string;
}) => Promise<{ text: string; calls: LlmCallRecord[] }>;

const EXTRACTION_SCHEMA = {
  type: "object" as const,
  properties: {
    fields: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          field_key: { type: "string" as const },
          // Wire value — the concrete union of shapes the SYSTEM prompt
          // names. Still validated by the coercion layer, never trusted;
          // the API refuses an empty ({} = anything) schema here.
          value: {
            anyOf: [
              { type: "string" as const },
              { type: "number" as const },
              { type: "boolean" as const },
              { type: "array" as const, items: { type: "string" as const } },
              {
                type: "object" as const,
                properties: {
                  amount_major: { type: "number" as const },
                  currency: { type: "string" as const },
                },
                required: ["amount_major"],
                additionalProperties: false,
              },
            ],
          },
          is_estimate: { type: "boolean" as const },
          estimate_wording: { type: ["string", "null"] as unknown as "string" },
        },
        required: ["field_key", "value", "is_estimate", "estimate_wording"],
        additionalProperties: false,
      },
    },
  },
  required: ["fields"],
  additionalProperties: false,
};

const SYSTEM = `You extract structured answers from a small-business owner's free-text reply during an intake interview.

You are given the question that was asked, plus other still-open questions the reply might also answer. Extract a value for every question the reply genuinely answers — owners often answer three questions in one sentence. Never guess or fill fields the reply does not address.

Wire formats by input type:
- text/long_text: string
- number: plain number
- money: {"amount_major": <number in major units, with word-units expanded to digits: "4 and a half million" → 4500000, "20k" → 20000>, "currency": "<ISO code if the owner names one, else omit>"}
- boolean: true/false
- date: "YYYY-MM-DD"
- single_select: one code from the question's listed codes
- multi_select: array of codes from the question's listed codes

Estimates: if the owner hedges a value ("about", "roughly", "maybe", "körülbelül", "talán"), set is_estimate true and put the owner's exact hedge phrase in estimate_wording.

Return JSON only: {"fields": [{"field_key", "value", "is_estimate", "estimate_wording"}]}`;

function questionLine(q: ApplicableQuestion, codes: readonly string[]): string {
  const spec = q.input as InputSpec;
  const codesPart = codes.length > 0 ? ` codes=[${codes.join(", ")}]` : "";
  const promptEn = ((q.prompt as Record<string, string> | null)?.en ?? "").trim();
  return `- ${q.writes_to} (${spec.type}${codesPart}): ${promptEn}`;
}

async function codesFor(q: ApplicableQuestion): Promise<string[]> {
  const spec = q.input as InputSpec;
  if (spec.type !== "single_select" && spec.type !== "multi_select") return [];
  if (!spec.vocabulary_id || spec.vocabulary_id.startsWith("__")) return [];
  return vocabularyCodes(spec.vocabulary_id);
}

/** Default live implementation of the LLM seam. */
export const liveExtractionLlm: ExtractionLlm = async ({ system, user, accountId }) => {
  const started = Date.now();
  const response = await anthropicClient().messages.create({
    model: PARSER_MODEL,
    max_tokens: 1000,
    system,
    output_config: { format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    messages: [{ role: "user", content: user }],
  });
  const record = buildCallRecord({
    workload: "parser",
    account_id: accountId,
    model: PARSER_MODEL,
    duration_ms: Date.now() - started,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
  });
  await recordLlmCall(record);
  if (response.stop_reason !== "end_turn") {
    throw new ParserError(`unexpected stop_reason "${response.stop_reason}"`);
  }
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return { text, calls: [record] };
};

/**
 * Parse a raw reply against the asked question plus other open questions
 * (P0-56), coerce every extraction, and write the survivors as owner_input
 * fields with §8.1 confidences (P0-55). Fields written here make their
 * questions non-candidates on the next pick — the interviewer skips what
 * the paragraph already answered (P0-57, via the selection layer).
 */
export async function parseAndWriteAnswer(args: {
  accountId: string;
  profileId: string;
  asked: ApplicableQuestion;
  otherOpen: readonly ApplicableQuestion[];
  rawText: string;
  reportingCurrency: string;
  llm?: ExtractionLlm;
}): Promise<ParseOutcome> {
  const llm = args.llm ?? liveExtractionLlm;
  const all = [args.asked, ...args.otherOpen];
  const codesByKey = new Map<string, string[]>();
  for (const q of all) codesByKey.set(q.writes_to, await codesFor(q));

  const user = [
    "QUESTION ASKED:",
    questionLine(args.asked, codesByKey.get(args.asked.writes_to) ?? []),
    "",
    "OTHER OPEN QUESTIONS (extract only if the reply answers them):",
    ...args.otherOpen.map((q) => questionLine(q, codesByKey.get(q.writes_to) ?? [])),
    "",
    `OWNER'S REPLY: ${args.rawText}`,
  ].join("\n");

  const { text, calls } = await llm({ system: SYSTEM, user, accountId: args.accountId });

  let payload: { fields: ExtractedField[] };
  try {
    payload = JSON.parse(text) as { fields: ExtractedField[] };
  } catch {
    throw new ParserError(`parser returned non-JSON: ${text.slice(0, 200)}`);
  }

  const byKey = new Map(all.map((q) => [q.writes_to, q]));
  const written: ParseOutcome["written"] = [];
  const rejected: ParseOutcome["rejected"] = [];
  const at = isoDateTime(new Date().toISOString());

  for (const extracted of payload.fields) {
    const question = byKey.get(extracted.field_key);
    if (!question) {
      rejected.push({ field_key: extracted.field_key, reason: "not an open question" });
      continue;
    }
    const coerced = coerceParsedValue(
      question.input as InputSpec,
      extracted.value,
      codesByKey.get(question.writes_to) ?? [],
      args.reportingCurrency,
    );
    if (!coerced.ok) {
      rejected.push({ field_key: extracted.field_key, reason: coerced.reason });
      continue;
    }
    const confidence = extracted.is_estimate ? CONFIDENCE_ESTIMATED : CONFIDENCE_PRECISE;
    const note = extracted.is_estimate ? extracted.estimate_wording?.trim() || "estimated" : null;
    await writeField(
      args.profileId,
      createField<unknown>({
        id: fieldId(question.writes_to),
        value: coerced.value,
        status: "answered",
        confidence,
        source: { kind: "owner_input" },
        observed_at: at,
        recorded_at: at,
        note,
      }),
    );
    written.push({ field_key: question.writes_to, confidence, note });
  }

  return { written, rejected, calls };
}
