import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRefusalError, readAnswer, textOf } from "./answer";

const record = { account_id: "acct-1", workload: "parser", model: "claude-haiku-5-5" };

afterEach(() => vi.restoreAllMocks());

describe("reading the answer by block type (Haiku 5.5 thinks first)", () => {
  it("finds the text behind leading thinking blocks", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "redacted_thinking", data: "x" },
      { type: "text", text: '{"kind":"price_increase"}' },
    ];
    expect(textOf(content)).toBe('{"kind":"price_increase"}');
    expect(readAnswer({ stop_reason: "end_turn", content }, record)).toEqual({
      text: '{"kind":"price_increase"}',
      refusal: null,
    });
  });

  it("joins text split around a tool call, and is empty when only thinking came back", () => {
    expect(
      textOf([
        { type: "text", text: "a" },
        { type: "server_tool_use" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
    expect(textOf([{ type: "thinking" }])).toBe("");
  });
});

describe("a refusal is never data", () => {
  it("returns no text and the category, even when content holds text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const got = readAnswer(
      {
        stop_reason: "refusal",
        stop_details: { category: "general_harms" },
        content: [{ type: "text", text: '{"limits":[]}' }],
      },
      record,
    );
    expect(got).toEqual({ text: "", refusal: "general_harms" });
    const line = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({ event: "llm_refusal", account_id: "acct-1", workload: "parser" });
  });

  it("names a refusal without a category 'unspecified', and the error says what declined", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readAnswer({ stop_reason: "refusal", content: [] }, record).refusal).toBe("unspecified");
    const error = new ModelRefusalError(record, "cyber");
    expect(error.category).toBe("cyber");
    expect(error.message).toMatch(/declined.*claude-haiku-5-5.*parser.*cyber/);
  });
});
