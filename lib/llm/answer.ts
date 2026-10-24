// Reading a model's answer — the one way every Haiku call site does it.
//
// Claude Haiku 5.5 thinks by default (adaptive), so a response can BEGIN
// with `thinking` blocks: the answer is read by block type, never as
// content[0]. Its safety classifiers can also decline with HTTP 200 and
// stop_reason "refusal", and there is no server-side fallback — so the
// refusal is checked before any content is read, and a refusal is never
// data. Each call site sends it down its own failure path; nothing here
// retries.

import type { LlmCallRecord } from "./cost-log";

interface Block {
  type: string;
  text?: unknown;
}

/** Every text block's text, in order, joined — found by type, never by position. */
export function textOf(content: readonly Block[]): string {
  return content
    .filter((b): b is Block & { text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/** A declined call, for call sites whose failure path is a throw. */
export class ModelRefusalError extends Error {
  readonly category: string;
  constructor(record: Pick<LlmCallRecord, "model" | "workload">, category: string) {
    super(`the model declined this request (${record.model}, ${record.workload}: ${category})`);
    this.name = "ModelRefusalError";
    this.category = category;
  }
}

/**
 * The answer, or the refusal. `refusal` is the classifier's category
 * ("unspecified" when it gave none) and `text` is then always "": a
 * declined call carries no answer to parse. Logged with the account id.
 */
export function readAnswer(
  response: {
    stop_reason: string | null;
    stop_details?: { category?: string | null } | null;
    content: readonly Block[];
  },
  record: Pick<LlmCallRecord, "account_id" | "workload" | "model">,
): { text: string; refusal: string | null } {
  if (response.stop_reason === "refusal") {
    const refusal = response.stop_details?.category ?? "unspecified";
    console.warn(
      JSON.stringify({
        event: "llm_refusal",
        account_id: record.account_id,
        workload: record.workload,
        model: record.model,
        category: refusal,
      }),
    );
    return { text: "", refusal };
  }
  return { text: textOf(response.content), refusal: null };
}
