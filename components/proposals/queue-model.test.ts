import { describe, expect, it } from "vitest";
import {
  activeChip,
  applyReasonChip,
  changeOf,
  chipPhrase,
  dayWord,
  effectRange,
  executeNotBefore,
  isTypingTarget,
  moveFocus,
  nextAfterDecision,
  reversibilityLabel,
  shortRef,
  signedMoney,
  stampText,
} from "./queue-model";

const NB = " ";

describe("changeOf — before → after only where both are stated", () => {
  it("reads text, numbers and money", () => {
    expect(changeOf({ before: "active", after: "paused" })).toEqual({
      before: "active",
      after: "paused",
    });
    expect(
      changeOf({
        before: { amount_minor: 2900, currency: "EUR" },
        after: { amount_minor: 3400, currency: "EUR" },
      }),
    ).toEqual({ before: "€29", after: "€34" });
  });

  it("refuses to invent a side that isn't there", () => {
    expect(changeOf({ before: "active" })).toBeNull();
    expect(changeOf({ rationale: "x" })).toBeNull();
    expect(changeOf(null)).toBeNull();
    expect(changeOf({ before: "", after: "paused" })).toBeNull();
  });
});

describe("effectRange — a range, never a point", () => {
  const eur = (m: number) => ({
    statement: "s",
    profit_delta_monthly: { amount_minor: m, currency: "EUR" },
  });

  it("orders the ends and signs them", () => {
    const r = effectRange(eur(34000), eur(-12000));
    expect(r?.text).toBe("−€120 to +€340");
    expect(r?.low.amount_minor).toBe(-12000);
  });

  it("is null when an end is missing or currencies differ", () => {
    expect(effectRange(eur(100), { statement: "s", profit_delta_monthly: null })).toBeNull();
    expect(effectRange(undefined, eur(100))).toBeNull();
    expect(
      effectRange(eur(100), {
        statement: "s",
        profit_delta_monthly: { amount_minor: 100, currency: "HUF" },
      }),
    ).toBeNull();
  });

  it("signs money with a true minus and leaves zero unsigned", () => {
    expect(signedMoney({ amount_minor: 0, currency: "EUR" })).toBe("€0");
    expect(signedMoney({ amount_minor: -409000, currency: "HUF" })).toBe(`−4${NB}090 HUF`);
  });
});

describe("reversibilityLabel — absent means permanent", () => {
  it("names the level when one is declared", () => {
    const r = reversibilityLabel({ level: "moderate", if_you_change_your_mind: "Undo it." });
    expect(r.reversible).toBe(true);
    expect(r.word).toBe("REVERSIBLE · MODERATE TO UNDO");
    expect(r.note).toBe("Undo it.");
  });

  it("is IRREVERSIBLE when null or unrecognised", () => {
    expect(reversibilityLabel(null).word).toBe("IRREVERSIBLE");
    expect(reversibilityLabel({ level: "sometimes" }).reversible).toBe(false);
    expect(reversibilityLabel(undefined).note).toMatch(/permanent/);
  });
});

describe("dates and the stamp", () => {
  it("puts the weekday in a deadline", () => {
    expect(dayWord("2026-10-19T12:00:00Z", "UTC")).toBe("Monday 19 October");
  });

  it("stamps with the recorded time, or labels the device clock", () => {
    const id = "3f2a9c1b-0000-4000-8000-000000000000";
    expect(shortRef(id)).toBe("3f2a9c1b");
    expect(
      stampText(id, { decision: "approved", at: "2026-10-17T14:02:00Z", clientTime: false }, "UTC"),
    ).toBe("APPROVED 14:02 · ref 3f2a9c1b");
    expect(
      stampText(id, { decision: "rejected", at: "2026-10-17T09:05:00Z", clientTime: true }, "UTC"),
    ).toBe("DECLINED 09:05 (this device's clock) · ref 3f2a9c1b");
  });
});

describe("decline reason chips", () => {
  it("fills an empty reason", () => {
    expect(applyReasonChip("", "WRONG DATA")).toBe("Wrong data");
    expect(chipPhrase("NOT MY STRATEGY")).toBe("Not my strategy");
  });

  it("swaps the chip and keeps what the owner typed", () => {
    expect(applyReasonChip("Wrong data — the stock is off", "TOO RISKY")).toBe(
      "Too risky — the stock is off",
    );
    expect(applyReasonChip("Wrong timing", "TOO RISKY")).toBe("Too risky");
    expect(applyReasonChip("we're closed in August", "WRONG TIMING")).toBe(
      "Wrong timing — we're closed in August",
    );
  });

  it("knows which chip leads", () => {
    expect(activeChip("Too risky — x")).toBe("TOO RISKY");
    expect(activeChip("Too risky business")).toBeNull();
    expect(activeChip("")).toBeNull();
  });
});

describe("keyboard and advance", () => {
  it("ignores keys typed into fields", () => {
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "SECTION" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("moves J/K within the list without wrapping", () => {
    const ids = ["a", "b", "c"];
    expect(moveFocus(ids, "a", 1)).toBe("b");
    expect(moveFocus(ids, "c", 1)).toBe("c");
    expect(moveFocus(ids, "a", -1)).toBe("a");
    expect(moveFocus(ids, null, 1)).toBe("a");
    expect(moveFocus(ids, null, -1)).toBe("c");
    expect(moveFocus([], null, 1)).toBeNull();
  });

  it("advances to the next pending below, else above, else nothing", () => {
    const order = ["a", "b", "c", "d"];
    expect(nextAfterDecision(order, ["b"], new Set(["a", "c", "d"]))).toBe("c");
    expect(nextAfterDecision(order, ["d"], new Set(["a", "c"]))).toBe("c");
    expect(nextAfterDecision(order, ["b", "c"], new Set(["a"]))).toBe("a");
    expect(nextAfterDecision(order, ["a"], new Set())).toBeNull();
  });
});

describe("schedule", () => {
  it("sends nothing for now and a floor otherwise", () => {
    const now = Date.parse("2026-10-17T10:00:00Z");
    expect(executeNotBefore("now", now)).toBeNull();
    expect(executeNotBefore("tomorrow", now)).toBe("2026-10-18T10:00:00.000Z");
    expect(executeNotBefore("next_week", now)).toBe("2026-10-24T10:00:00.000Z");
    expect(executeNotBefore("bogus", now)).toBeNull();
  });
});
