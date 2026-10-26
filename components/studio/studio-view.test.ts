import { describe, expect, it } from "vitest";
import { parseTerms, researchNotice, runningWords, studioHeadline, timeText } from "./studio-view";

const group = {
  page_name: "Saltmarsh Pottery",
  format: "video" as const,
  running_days: 143,
  active: true,
};

describe("the creative studio's words", () => {
  it("says when research isn't set up, or the Library can't show the niche", () => {
    expect(
      studioHeadline({ set_up: false, blocked: "x", last_read: null, groups: [] }, 0, "business"),
    ).toBe("Niche research isn't set up yet.");
    expect(
      studioHeadline(
        { set_up: true, blocked: "outside", last_read: null, groups: [] },
        0,
        "business",
      ),
    ).toBe("Meta's Ad Library can't show your niche's ads.");
  });

  it("states the longest-running concept once there is a read", () => {
    const last_read = {
      id: "r",
      read_at: "2026-10-26T10:00:00.000Z",
      country: "IE",
      terms: ["mug"],
      ads_read: 6,
      requests: 7,
      refresh_from: "2026-10-27T10:00:00.000Z",
      refresh_allowed: false,
    };
    expect(
      studioHeadline(
        { set_up: true, blocked: null, last_read, groups: [group as never] },
        0,
        "studio",
      ),
    ).toBe("Saltmarsh Pottery's video has run 143 days — the longest-running concept I found.");
    expect(
      studioHeadline({ set_up: true, blocked: null, last_read: null, groups: [] }, 2, "studio"),
    ).toBe("2 briefs written; I haven't read your niche's ads yet.");
  });

  it("words running time and state", () => {
    expect(runningWords({ running_days: 1, active: false })).toEqual({
      days: "1 day",
      word: "STOPPED",
    });
    expect(runningWords({ running_days: 143, active: true })).toEqual({
      days: "143 days",
      word: "LIVE",
    });
  });

  it("reads typed terms, at most two", () => {
    expect(parseTerms(" mug , pottery class, x, bowls ")).toEqual(["mug", "pottery class"]);
    expect(parseTerms("")).toEqual([]);
  });

  it("words the research outcome", () => {
    expect(researchNotice({ status: "read", why: null, fresh: false })).toMatch(/still fresh/);
    expect(researchNotice({ status: "cooldown", why: "once a day", fresh: false })).toBe(
      "once a day",
    );
    expect(timeText("2026-10-27T09:05:00.000Z")).toBe("27 Oct, 09:05 UTC");
  });
});
