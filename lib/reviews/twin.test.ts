// I-45a — the same Google review by email and from Google's API. Pure: each
// rule of isTwin with a case that matches and one that doesn't.

import { describe, expect, it } from "vitest";
import { TWIN_MIN_PREFIX, TWIN_WINDOW_DAYS, isTwin } from "./twin";

const AT = "2026-10-30T10:00:00.000Z";
const later = (days: number) => new Date(Date.parse(AT) + days * 86_400_000).toISOString();
const words = "Waited 40 minutes past my appointment and nobody said sorry. I won't be back.";
const api = { stars: 2, text: words, reviewer: "Aoife Murphy", reviewed_at: AT };

describe("I-45a — isTwin", () => {
  it("the same words and stars within the window are one review; outside it, two", () => {
    expect(isTwin(api, { ...api, reviewer: "Aoife M.", reviewed_at: later(1) })).toBe(true);
    expect(isTwin(api, { ...api, reviewed_at: later(TWIN_WINDOW_DAYS + 1) })).toBe(false);
  });

  it("different stars are two reviews, and no stars on either side is never a twin", () => {
    expect(isTwin(api, { ...api, stars: 3 })).toBe(false);
    expect(isTwin({ ...api, stars: null }, { ...api, stars: null })).toBe(false);
  });

  it("a notification's cut-short words match their start; a short or different start doesn't", () => {
    const cut = `${words.slice(0, 50)}…`;
    expect(isTwin(api, { ...api, text: cut })).toBe(true);
    expect(isTwin(api, { ...api, text: `${words.slice(0, TWIN_MIN_PREFIX - 5)}…` })).toBe(false);
    expect(isTwin(api, { ...api, text: "The colour faded within a week and nobody called." })).toBe(
      false,
    );
    // Spacing and case don't make two reviews.
    expect(isTwin(api, { ...api, text: `  ${words.toUpperCase().replace(/ /g, "  ")} ` })).toBe(
      true,
    );
  });

  it("words on one side only are two reviews", () => {
    expect(isTwin(api, { ...api, text: null })).toBe(false);
  });

  it("with no words on either side, only the same first name matches", () => {
    const bare = { ...api, text: null };
    expect(isTwin(bare, { ...bare, reviewer: "aoife m." })).toBe(true);
    expect(isTwin(bare, { ...bare, reviewer: "Ben" })).toBe(false);
    expect(isTwin({ ...bare, reviewer: null }, { ...bare, reviewer: null })).toBe(false);
  });
});
