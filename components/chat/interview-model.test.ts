// The interview with Lex: how a question is answered in the conversation,
// and what goes back to the interview's own endpoint (interview-model.ts).

import { describe, expect, it } from "vitest";
import type { IntakeQuestion } from "../../lib/intake/types";
import { answerKind, answerWords, choicesOf, pickedAnswer, typedAnswer } from "./interview-model";

const q = (input_type: IntakeQuestion["input_type"], options: [string, string][] = []) => ({
  input_type,
  options: options.map(([code, label]) => ({ code, label })),
});
const WORDS = { yes: "Yes", no: "No" };
const SAID = { unknown: "I don't know", skipped: "Skipped for now" };

describe("how a question is answered in the conversation", () => {
  it("presses for a choice, picks for several, types for the rest", () => {
    expect(answerKind(q("single_select"))).toBe("choice");
    expect(answerKind(q("boolean"))).toBe("choice");
    expect(answerKind(q("multi_select"))).toBe("many");
    expect(answerKind(q("text"))).toBe("words");
    expect(answerKind(q("long_text"))).toBe("words");
    expect(answerKind(q("number"))).toBe("figure");
    expect(answerKind(q("money"))).toBe("amount");
  });

  it("sends a date, a table of rows and a file to the form, which has the control for them", () => {
    expect(answerKind(q("date"))).toBe("form");
    expect(answerKind(q("entity_list"))).toBe("form");
    expect(answerKind(q("file"))).toBe("form");
  });
});

describe("the buttons of a question", () => {
  it("are its options, each sending its own code", () => {
    expect(
      choicesOf(
        q("single_select", [
          ["retail", "Retail shop"],
          ["cafe", "Café"],
        ]),
        WORDS,
      ),
    ).toEqual([
      { id: "retail", label: "Retail shop", wire: "retail" },
      { id: "cafe", label: "Café", wire: "cafe" },
    ]);
  });

  it("are Yes and No for a yes-or-no question, sending true and false", () => {
    expect(choicesOf(q("boolean"), WORDS)).toEqual([
      { id: "yes", label: "Yes", wire: true },
      { id: "no", label: "No", wire: false },
    ]);
  });
});

describe("a typed answer", () => {
  it("is the words as typed, trimmed", () => {
    expect(typedAnswer("words", "  Harbour Lane Bakery ")).toEqual({
      ok: true,
      action: { kind: "value", wire: "Harbour Lane Bakery" },
    });
  });

  it("is a number for a figure, however the person writes it", () => {
    expect(typedAnswer("figure", "12")).toEqual({ ok: true, action: { kind: "value", wire: 12 } });
    expect(typedAnswer("figure", "12,5")).toEqual({
      ok: true,
      action: { kind: "value", wire: 12.5 },
    });
    expect(typedAnswer("figure", "1 234")).toEqual({
      ok: true,
      action: { kind: "value", wire: 1234 },
    });
  });

  it("is a decimal amount for money: the server turns it into minor units (rule 1)", () => {
    expect(typedAnswer("amount", "1,234.50")).toEqual({
      ok: true,
      action: { kind: "value", wire: { amount_major: 1234.5 } },
    });
    expect(typedAnswer("amount", "34")).toEqual({
      ok: true,
      action: { kind: "value", wire: { amount_major: 34 } },
    });
  });

  it("is never guessed: nothing typed, not a number, or a figure that reads two ways", () => {
    expect(typedAnswer("words", "   ")).toEqual({ ok: false, reason: "empty" });
    expect(typedAnswer("figure", "")).toEqual({ ok: false, reason: "empty" });
    expect(typedAnswer("figure", "about twelve")).toEqual({ ok: false, reason: "unreadable" });
    // Twelve hundred, or one point two?
    expect(typedAnswer("amount", "1.200")).toEqual({ ok: false, reason: "unclear" });
    expect(typedAnswer("figure", "12,000")).toEqual({ ok: false, reason: "unclear" });
    // A kind that is not typed at all.
    expect(typedAnswer("choice", "yes")).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("several options picked", () => {
  it("go back as their codes, and nothing picked is no answer", () => {
    expect(pickedAnswer(["a", "c"])).toEqual({ kind: "value", wire: ["a", "c"] });
    expect(pickedAnswer([])).toBeNull();
  });
});

describe("the answer the conversation keeps beside its question", () => {
  const choices = choicesOf(
    q("single_select", [
      ["retail", "Retail shop"],
      ["cafe", "Café"],
    ]),
    WORDS,
  );

  it("is the option's own words, not its code", () => {
    expect(answerWords({ kind: "value", wire: "cafe" }, choices, "", SAID)).toBe("Café");
    expect(answerWords({ kind: "value", wire: ["retail", "cafe"] }, choices, "", SAID)).toBe(
      "Retail shop, Café",
    );
    expect(
      answerWords({ kind: "value", wire: true }, choicesOf(q("boolean"), WORDS), "", SAID),
    ).toBe("Yes");
  });

  it("is what was typed, and says so when a question was skipped or not known", () => {
    expect(answerWords({ kind: "value", wire: 34 }, [], " 34 ", SAID)).toBe("34");
    expect(answerWords({ kind: "unknown" }, choices, "", SAID)).toBe("I don't know");
    expect(answerWords({ kind: "skip" }, choices, "", SAID)).toBe("Skipped for now");
  });
});
