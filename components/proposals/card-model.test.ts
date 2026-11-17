// Idea 53 (I-53.5): what the single-proposal card says. Pure.

import { describe, expect, it } from "vitest";
import type { CardProposal } from "./card-model";
import { cardState, gainLine, limitLines, readsAsWords, undoLine, worstCase } from "./card-model";

const NOW = new Date("2026-11-10T09:00:00Z");

const base: CardProposal = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  status: "pending",
  action: { kind: "price_increase", summary: "Raise the espresso by 10%" },
  scenario: {
    downside_case: {
      statement: "fewer regulars",
      profit_delta_monthly: { amount_minor: -1_200_00, currency: "EUR" },
    },
    upside_case: {
      statement: "everyone stays",
      profit_delta_monthly: { amount_minor: 4_800_00, currency: "EUR" },
    },
  },
  reversibility: { level: "easy", if_you_change_your_mind: "set the old price back" },
  blocked_by_limit: null,
  expires_at: "2026-11-20T00:00:00.000Z",
  decided_at: null,
};

describe("cardState", () => {
  it("a pending proposal in its window can be decided", () => {
    expect(cardState(base, NOW)).toEqual({ kind: "decide" });
  });

  it("a pending one past its window reads as expired, with no buttons", () => {
    const s = cardState({ ...base, expires_at: "2026-11-10T09:00:00.000Z" }, NOW);
    expect(s).toMatchObject({ kind: "closed", word: "EXPIRED" });
  });

  it("an expired, approved, declined, changed or blocked one says so", () => {
    const at = "2026-11-09T14:02:00.000Z";
    expect(cardState({ ...base, status: "expired" }, NOW)).toMatchObject({ word: "EXPIRED" });
    expect(cardState({ ...base, status: "approved", decided_at: at }, NOW)).toMatchObject({
      kind: "closed",
      word: "APPROVED",
    });
    expect(cardState({ ...base, status: "executed", decided_at: at }, NOW)).toMatchObject({
      word: "DONE",
    });
    expect(cardState({ ...base, status: "rejected", decided_at: at }, NOW)).toMatchObject({
      word: "DECLINED",
    });
    expect(cardState({ ...base, status: "changes_requested", decided_at: at }, NOW)).toMatchObject({
      word: "CHANGES REQUESTED",
    });
    const blocked = cardState(
      { ...base, status: "blocked", blocked_by_limit: "13.5: never raise prices" },
      NOW,
    );
    expect(blocked).toMatchObject({ word: "HELD BACK" });
    expect(blocked.kind === "closed" && blocked.sentence).toBe(
      "I held this back myself: you said “never raise prices”. It isn't up for a decision.",
    );
  });
});

describe("the figures", () => {
  it("shows the gain as a range, never a point", () => {
    expect(gainLine(base)).toBe("−€1,200 – +€4,800");
  });

  it("shows no range when one end is missing or the currencies differ", () => {
    const { upside_case: _drop, ...downsideOnly } = base.scenario;
    void _drop;
    expect(gainLine({ ...base, scenario: downsideOnly })).toBeNull();
    expect(
      gainLine({
        ...base,
        scenario: {
          ...base.scenario,
          upside_case: {
            statement: "up",
            profit_delta_monthly: { amount_minor: 100, currency: "HUF" },
          },
        },
      }),
    ).toBeNull();
  });

  it("states the worst case with its money and words, or says none was forecast", () => {
    expect(worstCase(base)).toBe("−€1,200: fewer regulars");
    expect(worstCase({ ...base, scenario: {} })).toBe("No worst case was forecast for this one.");
  });

  it("says whether it can be undone", () => {
    expect(undoLine(base)).toMatchObject({ reversible: true, word: "REVERSIBLE · EASY TO UNDO" });
    expect(undoLine({ ...base, reversibility: null }).reversible).toBe(false);
  });

  it("keeps a figure on one line and stacks a sentence, each side named", () => {
    expect(readsAsWords({ before: "€38.00", after: "€41.40" })).toBe(false);
    expect(
      readsAsWords({
        before: "dipped in our oatmeal speckle glaze.",
        after: "dipped in our oatmeal speckle glaze. Dishwasher and microwave safe.",
      }),
    ).toBe(true);
    // The line itself: 48 characters still fit, one more does not.
    expect(readsAsWords({ before: "a".repeat(24), after: "b".repeat(24) })).toBe(false);
    expect(readsAsWords({ before: "a".repeat(24), after: "b".repeat(25) })).toBe(true);
  });
});

describe("limitLines", () => {
  it("names what it was checked against, and what it couldn't check", () => {
    const lines = limitLines([
      { quote: "never discount", enforcement: "auto" },
      { quote: "nothing that embarrasses the brand", enforcement: "manual" },
    ]);
    expect(lines).toEqual([
      "Checked against “never discount”: it doesn't go against it.",
      "I can't check “nothing that embarrasses the brand” for you: weigh this against it yourself.",
    ]);
  });

  it("speaks of several limits in the plural", () => {
    expect(
      limitLines([
        { quote: "never discount", enforcement: "auto" },
        { quote: "no cold email", enforcement: "auto" },
      ]),
    ).toEqual([
      "Checked against “never discount” and “no cold email”: it doesn't go against them.",
    ]);
  });

  it("says plainly when there was nothing to check against", () => {
    expect(limitLines(null)[0]).toMatch(/nothing to check it against/);
    expect(limitLines([])[0]).toMatch(/question 13\.5/);
  });
});
