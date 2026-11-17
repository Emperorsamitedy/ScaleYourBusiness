import { describe, expect, it } from "vitest";
import { readNowOutcome, tallied } from "./read-now";

// docs/DASHBOARD-OVERHAUL.md C2: "Read now" says what it read, and only that.
describe("Read now: what one answer counts as", () => {
  it("counts a connection as read only when the runner says it pulled it", () => {
    expect(readNowOutcome(true, { ok: true, skipped: null })).toBe("read");
    // The route answers 200 with ok false when the pull failed: that is no answer.
    expect(readNowOutcome(true, { ok: false, skipped: null })).toBe("silent");
    expect(readNowOutcome(true, {})).toBe("silent");
  });

  it("leaves out a connection the runner stood down on, as neither read nor silent", () => {
    expect(readNowOutcome(true, { ok: false, skipped: "imported" })).toBe("nothing");
    expect(readNowOutcome(true, { ok: false, skipped: "locked" })).toBe("nothing");
    expect(readNowOutcome(true, { ok: false, skipped: "" })).toBe("silent");
  });

  it("takes a refusal or an unreadable answer as no answer", () => {
    expect(readNowOutcome(false, { ok: true })).toBe("silent");
    expect(readNowOutcome(true, null)).toBe("silent");
  });

  it("tallies what was read and names what gave no answer, in order", () => {
    let tally = { read: 0, silent: [] as string[] };
    tally = tallied(tally, "Shopify", "read");
    tally = tallied(tally, "Bookings", "nothing");
    tally = tallied(tally, "Stripe", "silent");
    tally = tallied(tally, "Google Analytics", "silent");
    expect(tally).toEqual({ read: 1, silent: ["Stripe", "Google Analytics"] });
  });
});
