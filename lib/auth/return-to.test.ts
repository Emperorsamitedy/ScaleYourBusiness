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

describe("returnPath — TASKS-IDEAS: back to the idea after signing in", () => {
  it("takes a shared check exactly as written (tokens are case-sensitive), and the idea pages", () => {
    expect(returnPath("/i/NiMTSTnoilFAYm1K")).toBe("/i/NiMTSTnoilFAYm1K");
    expect(returnPath("/idea")).toBe("/idea");
    expect(returnPath("/idea/mine")).toBe("/idea/mine");
  });

  it("refuses anything that only looks like one", () => {
    expect(returnPath("/i/short")).toBeNull();
    expect(returnPath("/i/abc/../../admin")).toBeNull();
    expect(returnPath("//evil.example/i/NiMTSTnoilFAYm1K")).toBeNull();
    expect(returnPath("/i/NiMTSTnoilFAYm1K?x=https://evil.example")).toBeNull();
    expect(returnPath("/idea/other")).toBeNull();
  });
});
