// Idea 53 (I-53.5): the way back after sign-in is the queue, a card, an idea
// page or one of the app's own screens, and nothing else.

import { describe, expect, it } from "vitest";
import { isIdeaReturn, returnPath, signInPath } from "./return-to";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("isIdeaReturn", () => {
  it("knows a shared check and the check itself", () => {
    expect(isIdeaReturn("/i/AbCdEfGh1234")).toBe(true);
    expect(isIdeaReturn("/idea")).toBe(true);
  });

  it("is false for a kept idea, a card, another site and nothing at all", () => {
    for (const raw of [
      "/idea/mine",
      "/proposals",
      "https://evil.example/idea",
      "/i/short",
      "",
      null,
      undefined,
    ]) {
      expect(isIdeaReturn(raw)).toBe(false);
    }
  });
});

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

describe("returnPath — the app's own screens (2026-11-20)", () => {
  it("takes a screen of the app by its exact address", () => {
    expect(returnPath("/customers")).toBe("/customers");
    expect(returnPath("/profile")).toBe("/profile");
    expect(returnPath("/settings/team")).toBe("/settings/team");
    expect(returnPath("/chat")).toBe("/chat");
    expect(returnPath(" /Cash ")).toBe("/cash");
  });

  it("refuses what is not a screen, and a screen with anything after it", () => {
    for (const raw of [
      "/ops",
      "/api/chat",
      "/customers?x=https://evil.example",
      "/customers/../ops",
      "/customers/",
      "//evil.example/customers",
      "https://evil.example/customers",
      "/intake", // entered from Home, never returned to
      "/login",
    ]) {
      expect(returnPath(raw), String(raw)).toBeNull();
    }
  });
});

describe("where a signed-out visitor goes to sign in", () => {
  it("carries the way back for a screen of the app", () => {
    expect(signInPath("/customers")).toBe("/login?next=%2Fcustomers");
    expect(signInPath("/profile?tab=charts")).toBe("/login?next=%2Fprofile");
    expect(signInPath(`/proposals/${ID}`)).toBe(`/login?next=%2Fproposals%2F${ID}`);
  });

  it("is plain sign-in for anywhere else", () => {
    expect(signInPath("/ops")).toBe("/login");
    expect(signInPath("/settings/unknown")).toBe("/login");
    expect(signInPath("")).toBe("/login");
  });
});
