// Prompt construction — byte-level determinism is what keeps the cache
// warm (rule 8), so it gets its own tests against the real loaded bank.

import "dotenv/config";
import { describe, expect, it, beforeAll } from "vitest";
import { loadBank } from "../bank/loader";
import { buildSystemBlocks, buildUserMessage, loadInterviewerBank } from "./prompt";

beforeAll(async () => {
  await loadBank("specs/question-bank-v1.json");
});

describe("system prompt — stable, cached, complete", () => {
  it("builds byte-identical blocks across two independent loads", async () => {
    const [a, b] = [await loadInterviewerBank(), await loadInterviewerBank()];
    const blocksA = buildSystemBlocks(a);
    const blocksB = buildSystemBlocks(b);
    expect(blocksA.length).toBe(2);
    expect(blocksA[0]?.text).toBe(blocksB[0]?.text);
    expect(blocksA[1]?.text).toBe(blocksB[1]?.text);
  });

  it("carries all 160 questions and puts the cache breakpoint on the bank block", async () => {
    const bank = await loadInterviewerBank();
    expect(bank.questions).toHaveLength(160);
    const blocks = buildSystemBlocks(bank);
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[1]?.cache_control).toEqual({ type: "ephemeral" });
    // Every question id appears in the bank block.
    const text = blocks[1]?.text ?? "";
    for (const q of bank.questions) expect(text).toContain(`"id":"${q.id}"`);
    // Nothing volatile: no timestamps, no uuids.
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });
});

describe("user message — volatile content only, structured", () => {
  it("lays out profile, history tail, and candidates", () => {
    const msg = buildUserMessage({
      profileSummary: [{ field_key: "identity.legal_name", repr: '"Szörp Kft."' }],
      unknownOrSkipped: ["revenue.repeat_customer_rate"],
      asked: [
        { question_id: "1.1", answer_repr: '"Szörp Kft."' },
        { question_id: "4.2", answer_repr: "unknown" },
      ],
      candidateIds: ["1.2", "1.3"],
    });
    expect(msg).toContain('identity.legal_name = "Szörp Kft."');
    expect(msg).toContain("UNKNOWN OR SKIPPED: revenue.repeat_customer_rate");
    expect(msg).toContain("ASKED (2, in order): 1.1, 4.2");
    expect(msg).toContain("CANDIDATES (choose exactly one): 1.2, 1.3");
    expect(msg).not.toContain("FEEDBACK");
  });

  it("appends retry feedback when present", () => {
    const msg = buildUserMessage({
      profileSummary: [],
      unknownOrSkipped: [],
      asked: [],
      candidateIds: ["1.1"],
      feedback: 'previous choice "9.9" invalid',
    });
    expect(msg).toContain("(empty — this is the first question)");
    expect(msg).toContain('FEEDBACK: previous choice "9.9" invalid');
  });
});
