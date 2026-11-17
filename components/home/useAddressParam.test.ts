import { describe, expect, it } from "vitest";
import { withParam } from "./useAddressParam";

// docs/DASHBOARD-OVERHAUL.md A3, C5: the open tab and the open decision live in the address.
describe("a value kept in the address", () => {
  it("sets one value and keeps the others and the hash", () => {
    expect(withParam("/home", "tab", "activity")).toBe("/home?tab=activity");
    expect(withParam("/home?tab=made#top", "review", "abc")).toBe("/home?tab=made&review=abc#top");
    expect(withParam("/home?tab=made", "tab", "needs")).toBe("/home?tab=needs");
  });

  it("removes a value on null or empty, leaving a clean address", () => {
    expect(withParam("/home?review=abc", "review", null)).toBe("/home");
    expect(withParam("/home?tab=made&review=abc", "review", "")).toBe("/home?tab=made");
    expect(withParam("/home", "review", null)).toBe("/home");
  });

  it("encodes what it is given rather than trusting it", () => {
    expect(withParam("/home", "review", "a b&c")).toBe("/home?review=a+b%26c");
  });
});
