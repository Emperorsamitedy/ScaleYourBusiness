import { describe, expect, it } from "vitest";
import type { NextInput } from "./next-steps";
import { NEXT_HREF, knowsNothing, nextSteps } from "./next-steps";

const base: NextInput = { pending: 0, connections: 3, live: "live", buffer: true, goals: 2 };

// docs/DASHBOARD-OVERHAUL.md C8: up to three suggestions from what is already known.
describe("Home's next steps", () => {
  it("offers nothing while a decision waits, or while the count is unknown", () => {
    const gaps: NextInput = { pending: 2, connections: 0, live: null, buffer: false, goals: 0 };
    expect(nextSteps(gaps)).toEqual([]);
    expect(nextSteps({ ...gaps, pending: null })).toEqual([]);
    expect(nextSteps({ ...gaps, pending: 0 })).toEqual(["connect", "buffer", "goal"]);
  });

  it("offers nothing when nothing is missing", () => {
    expect(nextSteps(base)).toEqual([]);
  });

  it("asks for a first connection before analytics, and for analytics only once something is connected", () => {
    expect(nextSteps({ ...base, connections: 0, live: "not_connected" })).toEqual(["connect"]);
    expect(nextSteps({ ...base, live: "not_connected" })).toEqual(["analytics"]);
    expect(nextSteps({ ...base, live: "paused" })).toEqual([]); // paused is the owner's own choice
  });

  it("treats an unknown as unknown, never as a gap", () => {
    expect(
      nextSteps({ pending: 0, connections: null, live: null, buffer: null, goals: null }),
    ).toEqual([]);
    expect(nextSteps({ ...base, buffer: false })).toEqual(["buffer"]);
    expect(nextSteps({ ...base, goals: 0 })).toEqual(["goal"]);
  });

  // L8: a person who signs up lands on Home before any interview. Lex offers it
  // in the headline, once the count of facts is known and only when it is zero.
  it("knows a business that has told nothing yet, and never guesses it", () => {
    expect(knowsNothing(0)).toBe(true);
    expect(knowsNothing(1)).toBe(false);
    expect(knowsNothing(12)).toBe(false);
    expect(knowsNothing(null)).toBe(false);
    expect(knowsNothing(undefined)).toBe(false);
  });

  it("never offers more than asked, and every step has a screen", () => {
    const all: NextInput = { pending: 0, connections: 0, live: null, buffer: false, goals: 0 };
    expect(nextSteps(all, 2)).toEqual(["connect", "buffer"]);
    for (const step of nextSteps(all)) expect(NEXT_HREF[step]).toMatch(/^\//);
  });
});
