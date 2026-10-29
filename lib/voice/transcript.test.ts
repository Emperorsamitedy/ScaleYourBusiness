// Idea 50: spoken words merged into typed ones — spacing, capitals,
// interim versus final, and the owner's own text never changed.

import { describe, expect, it } from "vitest";
import type { ResultListLike } from "./transcript";
import { joinSpoken, mergeSpoken, spokenOf } from "./transcript";

/** A result list the way the browser hands one over. */
function results(...rows: [text: string, isFinal: boolean][]): ResultListLike {
  return rows.map(([transcript, isFinal]) => ({ isFinal, length: 1, 0: { transcript } }));
}

describe("joinSpoken", () => {
  it("starts an empty box with a capital and no leading space", () => {
    expect(joinSpoken("", "we sell coffee")).toBe("We sell coffee");
  });

  it("adds a space after typed words, and no capital mid-sentence", () => {
    expect(joinSpoken("We sell coffee", "and cakes")).toBe("We sell coffee and cakes");
  });

  it("capitalises after a full stop, a question mark or a new line", () => {
    expect(joinSpoken("We sell coffee.", "mostly to offices")).toBe(
      "We sell coffee. Mostly to offices",
    );
    expect(joinSpoken("Why?", "because")).toBe("Why? Because");
    expect(joinSpoken("Line one\n", "line two")).toBe("Line one\nLine two");
  });

  it("never lowercases what the browser heard, so names keep their capitals", () => {
    expect(joinSpoken("We run tours in", "Budapest")).toBe("We run tours in Budapest");
  });

  it("keeps the typed text exactly, trailing space included", () => {
    expect(joinSpoken("Hello ", "there")).toBe("Hello there");
    expect(joinSpoken("  indented", "text")).toBe("  indented text");
  });

  it("puts no space before spoken punctuation", () => {
    expect(joinSpoken("Coffee", ", tea")).toBe("Coffee, tea");
  });

  it("changes nothing for blank speech, and tidies the browser's spacing", () => {
    expect(joinSpoken("Typed", "   ")).toBe("Typed");
    expect(joinSpoken("", "  two   spaces ")).toBe("Two spaces");
  });

  it("leaves a piece starting with a number alone", () => {
    expect(joinSpoken("", "3 staff on weekends")).toBe("3 staff on weekends");
  });

  // The failing side of the rule: a typed lowercase start is the owner's, not ours to fix.
  it("does not touch a lowercase letter the owner typed", () => {
    expect(joinSpoken("we open at", "nine")).toBe("we open at nine");
  });
});

describe("spokenOf", () => {
  it("splits settled words from still-changing ones, skipping blanks", () => {
    expect(spokenOf(results(["we sell", true], [" ", true], [" coffee", false]))).toEqual({
      final: ["we sell"],
      interim: [" coffee"],
    });
  });

  it("reads an empty list as nothing heard", () => {
    expect(spokenOf(results())).toEqual({ final: [], interim: [] });
  });
});

describe("mergeSpoken", () => {
  it("replaces a guess with the final words instead of adding both", () => {
    const base = "Opening hours:";
    const guess = mergeSpoken(base, spokenOf(results(["nine to", false])));
    expect(guess).toBe("Opening hours: nine to");
    const settled = mergeSpoken(base, spokenOf(results(["nine to five", true])));
    expect(settled).toBe("Opening hours: nine to five");
  });

  it("joins several settled stretches in order, then the guess", () => {
    const text = mergeSpoken(
      "",
      spokenOf(results(["we sell coffee.", true], [" mostly beans", true], [" and", false])),
    );
    expect(text).toBe("We sell coffee. Mostly beans and");
  });
});
