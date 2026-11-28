import { describe, expect, it } from "vitest";
import type { EntryAnswers } from "../entry/one-number";
import { entryWires, isEntryToken } from "./entry-wires";

const A: EntryAnswers = {
  sector: "cafe",
  country: "HU",
  revenue_band: "b2",
  employees: 4,
  channel: "word_of_mouth",
  operations: "x",
};

describe("entryWires: the free check's answers the interview can take", () => {
  it("carries the business type, the country by name and the team size", () => {
    expect(entryWires(A)).toEqual([
      { questionId: "1.2", wire: "cafe" },
      { questionId: "1.1b", wire: "Hungary" },
      { questionId: "1.6", wire: 4 },
    ]);
  });

  it("never carries the revenue band, the channel or the operations answer", () => {
    const ids = entryWires(A).map((w) => w.questionId);
    expect(ids).toHaveLength(3);
  });

  it("leaves out a team size that is not a whole number of people", () => {
    expect(entryWires({ ...A, employees: 0 }).map((w) => w.questionId)).toEqual(["1.2", "1.1b"]);
  });
});

describe("isEntryToken", () => {
  it("takes a share token and refuses anything else", () => {
    expect(isEntryToken("abcDEF12_-")).toBe(true);
    expect(isEntryToken("short")).toBe(false);
    expect(isEntryToken("../etc/passwd")).toBe(false);
    expect(isEntryToken(undefined)).toBe(false);
  });
});
