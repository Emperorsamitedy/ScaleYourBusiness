import { describe, expect, it } from "vitest";
import { businessProfileId, fieldId, threadId, utteranceId } from "./ids";
import { isoDateTime } from "./iso";
import type { CreateUtteranceInput } from "./utterance";
import {
  createUtterance,
  InvalidUtteranceError,
  isUtteranceIntent,
  UTTERANCE_INTENTS,
} from "./utterance";

function base(overrides: Partial<CreateUtteranceInput>): CreateUtteranceInput {
  return {
    id: utteranceId("utt_1"),
    profile_id: businessProfileId("prof_1"),
    thread_id: threadId("thread_1"),
    role: "owner",
    text: "we put prices up about 15% last month and it hasn't hurt sales",
    at: isoDateTime("2026-08-20T18:00:00Z"),
    cost_eur: 0.004,
    ...overrides,
  };
}

describe("UtteranceIntent", () => {
  it("carries all six intents from §2.2, distinctly", () => {
    expect(UTTERANCE_INTENTS).toHaveLength(6);
    expect(new Set(UTTERANCE_INTENTS).size).toBe(6);
    for (const i of UTTERANCE_INTENTS) expect(isUtteranceIntent(i)).toBe(true);
    expect(isUtteranceIntent("command")).toBe(false);
  });
});

describe("createUtterance", () => {
  it("accepts an owner turn with classified intent and extracted fields", () => {
    const u = createUtterance(
      base({ intent: "tell", extracted_fields: [fieldId("offers.price_change")] }),
    );
    expect(u.intent).toBe("tell");
    expect(u.extracted_fields).toHaveLength(1);
    expect(u.confirmed).toBe(false); // unconfirmed until the §3 loop runs
  });

  it("accepts a system turn — intent stays null", () => {
    const u = createUtterance(base({ role: "system", text: "Recording: prices up ~15%." }));
    expect(u.intent).toBeNull();
  });

  it("defaults to unclassified, no extractions, zero-history confirmed=false", () => {
    const u = createUtterance(base({}));
    expect(u.intent).toBeNull();
    expect(u.extracted_fields).toEqual([]);
    expect(u.confirmed).toBe(false);
  });

  it("rejects a system turn carrying intent — only owner turns are classified (§5)", () => {
    expect(() => createUtterance(base({ role: "system", intent: "ask" }))).toThrow(
      InvalidUtteranceError,
    );
  });

  it("rejects empty text", () => {
    expect(() => createUtterance(base({ text: "   " }))).toThrow(InvalidUtteranceError);
  });

  it("rejects a negative or non-finite cost — the §6 cap depends on it", () => {
    expect(() => createUtterance(base({ cost_eur: -0.01 }))).toThrow(InvalidUtteranceError);
    expect(() => createUtterance(base({ cost_eur: Number.NaN }))).toThrow(InvalidUtteranceError);
  });

  it("accepts a zero-cost message — cached turns can be free", () => {
    expect(createUtterance(base({ cost_eur: 0 })).cost_eur).toBe(0);
  });
});
