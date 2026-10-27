import "dotenv/config";
import { describe, expect, it } from "vitest";
import type { BriefRead } from "./brief";
import { type ItemBrief, briefAudienceOf, briefInputOf, briefRefOf } from "./brief-links";

const ID = "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90";

const brief = (over: Partial<BriefRead["audience"]> = {}): BriefRead => ({
  id: ID,
  profile_id: "p",
  campaign: "Weekend classes",
  goal_id: null,
  created_at: "2026-10-26T10:00:00.000Z",
  model: "claude-sonnet-5",
  audience: {
    text: "Couples in Dublin looking for a weekend activity",
    countries: ["IE"],
    cites: [],
    ...over,
  },
  offer: { text: "A beginner class for two", cites: [] },
  hooks: [
    {
      index: 0,
      hook: "Your first bowl, in one afternoon",
      script: "Script one.",
      seconds: 20,
      cites: [],
      shots: [],
    },
    {
      index: 1,
      hook: "Date night, but muddy",
      script: "Script two.",
      seconds: 15,
      cites: [],
      shots: [],
    },
  ],
  disclosure: "Brief prepared with AI assistance.",
});

describe("Session K — an item's creative brief reaches the fallback and the ad", () => {
  it("reads the brief and hook an item's provenance names, and nothing else", () => {
    expect(briefRefOf({ brief_id: ID, hook_index: 1 })).toEqual({ brief_id: ID, hook_index: 1 });
    expect(briefRefOf({ brief_id: ID })).toEqual({ brief_id: ID, hook_index: null });
    // Not a uuid, not a string, or no provenance at all: no brief.
    expect(briefRefOf({ brief_id: "'; drop table" })).toBeNull();
    expect(briefRefOf({ brief_id: 7 })).toBeNull();
    expect(briefRefOf(null)).toBeNull();
  });

  it("the AI fallback gets the item's own hook and script, only when it names one", () => {
    const b = brief();
    const withHook: ItemBrief = { brief: b, hook: b.hooks[1]! };
    expect(briefInputOf(withHook)).toEqual({
      hook: "Date night, but muddy",
      script: "Script two.",
    });
    expect(briefInputOf({ brief: b, hook: null })).toBeNull();
    expect(briefInputOf(null)).toBeNull();
  });

  it("the ad gets the brief's country and its audience in words; an empty brief adds nothing", () => {
    expect(briefAudienceOf({ brief: brief(), hook: null })).toEqual({
      location: { country: "IE" },
      interests: "Couples in Dublin looking for a weekend activity",
    });
    expect(briefAudienceOf({ brief: brief({ countries: [] }), hook: null })).toEqual({
      interests: "Couples in Dublin looking for a weekend activity",
    });
    expect(briefAudienceOf({ brief: brief({ countries: [], text: "  " }), hook: null })).toBeNull();
    expect(briefAudienceOf(null)).toBeNull();
  });
});
