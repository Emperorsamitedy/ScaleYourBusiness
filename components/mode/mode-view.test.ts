import { describe, expect, it } from "vitest";
import type { ModeDecision } from "./mode-view";
import { chosenLine, headline, humanise, watchDay } from "./mode-view";

const watching: ModeDecision = {
  mode: "watching",
  watch_weeks: 4,
  decided_at: "2026-09-29 10:00:00+00",
  reasons: ["~120 orders per month"],
  reasoning: "stored",
  review_at: "2026-10-27 10:00:00+00",
  owner_override: null,
};

describe("mode view", () => {
  it("states the current watch length in days", () => {
    expect(headline(watching)).toBe("Watching first, for 28 days.");
    expect(headline({ ...watching, watch_weeks: 8 })).toBe("Watching first, for 56 days.");
  });

  it("an instant decision acts right away", () => {
    expect(headline({ ...watching, mode: "instant", watch_weeks: null })).toBe(
      "Acting right away.",
    );
    expect(watchDay({ ...watching, mode: "instant", watch_weeks: null }, Date.now())).toBeNull();
  });

  it("counts the watch day the way the menu does, clamped to the window", () => {
    const now = Date.parse("2026-10-17T10:00:00Z");
    expect(watchDay(watching, now)).toEqual({ day: 18, of: 28 });
    expect(watchDay(watching, Date.parse("2026-12-01T00:00:00Z"))).toEqual({ day: 28, of: 28 });
    expect(watchDay(watching, Date.parse("2026-09-01T00:00:00Z"))).toEqual({ day: 1, of: 28 });
  });

  it("says when it was chosen, and any override on record", () => {
    expect(chosenLine(watching)).toBe("Chosen 29 Sep");
    expect(
      chosenLine({
        ...watching,
        owner_override: {
          kind: "extend",
          from_weeks: 4,
          to_weeks: 8,
          at: "2026-10-03 09:00:00+00",
        },
      }),
    ).toBe("Chosen 29 Sep · extended to 8 weeks 3 Oct");
  });

  it("reads long month counts as years", () => {
    expect(humanise("Operating for 40 months")).toBe("Operating for 3 years");
    expect(humanise("Operating for 5 months")).toBe("Operating for 5 months");
  });
});
