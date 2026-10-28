import { describe, expect, it } from "vitest";
import { watchingUntil } from "./watch-words";

describe("rule 15 — the watching note, in the owner's words", () => {
  it("names the day the watch ends, from a timestamp or a date", () => {
    expect(watchingUntil("2026-11-06T09:30:00.000Z")).toBe(
      "I'm watching until 6 Nov, and I propose nothing before then.",
    );
    expect(watchingUntil("2026-11-06")).toBe(
      "I'm watching until 6 Nov, and I propose nothing before then.",
    );
  });

  it("never shows an ISO date or a rule number", () => {
    const note = watchingUntil("2027-01-04T00:00:00.000Z");
    expect(note).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(note).not.toMatch(/rule \d+/);
    expect(note).toContain("4 Jan");
  });
});
