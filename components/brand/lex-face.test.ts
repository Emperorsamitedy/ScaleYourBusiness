import { describe, expect, it } from "vitest";
import { lexState } from "./LexFace";

describe("what Lex's face shows", () => {
  it("is idle when nothing is happening", () => {
    expect(lexState({})).toBe("idle");
    expect(lexState({ stopped: false, listening: false, working: false })).toBe("idle");
  });

  it("shows the work while Lex answers", () => {
    expect(lexState({ working: true })).toBe("working");
  });

  it("listens before it works: the microphone is the owner's turn", () => {
    expect(lexState({ listening: true, working: true })).toBe("listening");
  });

  // Rule 15: stopped is said everywhere, and nothing may look busy under it.
  it("is stopped above everything else", () => {
    expect(lexState({ stopped: true })).toBe("stopped");
    expect(lexState({ stopped: true, working: true, listening: true })).toBe("stopped");
  });
});
