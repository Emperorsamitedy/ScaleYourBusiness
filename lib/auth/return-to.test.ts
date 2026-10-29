// Idea 53 (I-53.5): the way back after sign-in is the queue or a card, nothing else.

import { describe, expect, it } from "vitest";
import { returnPath } from "./return-to";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("returnPath", () => {
  it("takes the queue and one of its cards", () => {
    expect(returnPath("/proposals")).toBe("/proposals");
    expect(returnPath(`/proposals/${ID}`)).toBe(`/proposals/${ID}`);
  });

  it("refuses every other path and every other site", () => {
    for (const raw of [
      "https://evil.example/proposals",
      "//evil.example/proposals",
      "/proposals/../ops",
      `/proposals/${ID}?x=1`,
      "/profile",
      "/proposals/not-an-id",
      "",
      null,
      42,
    ]) {
      expect(returnPath(raw)).toBeNull();
    }
  });
});
