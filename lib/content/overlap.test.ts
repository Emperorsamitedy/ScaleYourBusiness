// P3-51 — the copy check. Five words in a row shared with another
// business's ad is a borrowing; case, accents and punctuation don't
// launder one; shorter shared runs are the language, not copying.

import { describe, expect, it } from "vitest";
import { OVERLAP_RULES, borrowedIndex, findBorrowings, overlapWords } from "./overlap";

const index = borrowedIndex([
  {
    ref: "ad:1",
    text: "Every mug starts as a lump of clay on our wheel by the sea.\nFree EU shipping over €60. Shop now.",
  },
  { ref: "ad:2", text: "Café-quality crème, served fresh every morning." },
]);

describe("P3-51 — the n-gram copy check", () => {
  it("compares five words in a row", () => {
    expect(OVERLAP_RULES.n).toBe(5);
  });

  it("normalises case, accents and punctuation", () => {
    expect(overlapWords("Café-quality CRÈME!")).toEqual(["cafe", "quality", "creme"]);
  });

  it("catches a lifted line, merged into one phrase, with whose ad it came from", () => {
    expect(
      findBorrowings("Ours too: every mug starts as a lump of clay, honestly.", index),
    ).toEqual([{ phrase: "every mug starts as a lump of clay", ref: "ad:1" }]);
  });

  it("isn't fooled by capitals and punctuation", () => {
    expect(findBorrowings("CAFE QUALITY creme, served FRESH!", index)).toEqual([
      { phrase: "cafe quality creme served fresh", ref: "ad:2" },
    ]);
  });

  it("lets four shared words through — that's the language, not copying", () => {
    expect(
      findBorrowings("Every mug starts somewhere: ours on a wheel in Kilkenny.", index),
    ).toEqual([]);
    expect(findBorrowings("Free EU shipping over a hundred.", index)).toEqual([]);
  });

  it("an empty index finds nothing", () => {
    expect(findBorrowings("anything at all here today friend", borrowedIndex([]))).toEqual([]);
  });
});
