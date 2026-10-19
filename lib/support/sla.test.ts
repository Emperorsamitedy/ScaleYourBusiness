// P4-11 — the reply-time arithmetic, pure, tested at its boundaries both ways.

import { describe, expect, it } from "vitest";
import { durationText, handoverTiming, slaState, slaWords } from "./sla";

const H = 3_600_000;
const since = "2026-10-19T08:00:00.000Z";
const at = (ms: number) => new Date(new Date(since).getTime() + ms);

describe("slaState — clock hours against the owner's stated reply time", () => {
  it("with no reply time set, says so and invents nothing", () => {
    const s = slaState(since, at(30 * H), null);
    expect(s).toEqual({ flag: "unset", waited_ms: 30 * H, left_ms: null, over_ms: null });
    expect(slaWords(s)).toEqual({ flag: "No reply time set", detail: "" });
  });

  it("IN TIME while more than a quarter is left; DUE SOON at exactly a quarter", () => {
    // 24 h: a quarter is 6 h, so DUE SOON from 18 h waited.
    expect(slaState(since, at(18 * H - 1), 24).flag).toBe("in_time");
    expect(slaState(since, at(18 * H), 24).flag).toBe("due_soon");
    expect(slaState(since, at(0), 24)).toMatchObject({ flag: "in_time", left_ms: 24 * H });
  });

  it("DUE SOON up to the last millisecond; OVERDUE the moment no time is left", () => {
    expect(slaState(since, at(24 * H - 1), 24)).toMatchObject({ flag: "due_soon", left_ms: 1 });
    expect(slaState(since, at(24 * H), 24)).toMatchObject({
      flag: "overdue",
      over_ms: 0,
      left_ms: null,
    });
    expect(slaState(since, at(26 * H + 30 * 60_000), 24)).toMatchObject({
      flag: "overdue",
      over_ms: 2.5 * H,
    });
  });

  it("a one-hour reply time: due soon in the last fifteen minutes", () => {
    expect(slaState(since, at(45 * 60_000 - 1), 1).flag).toBe("in_time");
    expect(slaState(since, at(45 * 60_000), 1).flag).toBe("due_soon");
  });

  it("a clock running behind the ticket never shows negative waiting", () => {
    expect(slaState(since, at(-5 * 60_000), 24)).toMatchObject({ flag: "in_time", waited_ms: 0 });
  });

  it("clock hours, not business hours: Friday 18:00 + 24 h is overdue on Saturday 18:00", () => {
    expect(slaState("2026-10-16T18:00:00Z", new Date("2026-10-17T18:00:00Z"), 24).flag).toBe(
      "overdue",
    );
  });
});

describe("durationText and slaWords — figures with units", () => {
  it("minutes, hours and minutes, days and hours", () => {
    expect(durationText(0)).toBe("0 min");
    expect(durationText(59 * 60_000 + 59_999)).toBe("59 min");
    expect(durationText(H)).toBe("1 h");
    expect(durationText(3 * H + 20 * 60_000)).toBe("3 h 20 min");
    expect(durationText(47 * H + 59 * 60_000)).toBe("47 h 59 min");
    expect(durationText(48 * H)).toBe("2 d");
    expect(durationText(52 * H)).toBe("2 d 4 h");
  });

  it("words the flag with the time left or over", () => {
    expect(slaWords(slaState(since, at(20 * H), 24))).toEqual({
      flag: "Due soon",
      detail: "4 h left",
    });
    expect(slaWords(slaState(since, at(2 * H), 24))).toEqual({
      flag: "In time",
      detail: "22 h left",
    });
    expect(slaWords(slaState(since, at(30 * H), 24))).toEqual({
      flag: "Overdue",
      detail: "6 h over",
    });
  });
});

describe("handoverTiming — the chat promises only what the owner stated", () => {
  it("states the owner's reply time, or promises nothing", () => {
    expect(handoverTiming(24)).toBe("A person usually replies within 24 hours.");
    expect(handoverTiming(1)).toBe("A person usually replies within 1 hour.");
    expect(handoverTiming(null)).toBe("A person will reply; I can't promise when.");
  });
});
