import { describe, expect, it } from "vitest";
import { GROW_TOOLS, TOOL_HALF, TOOL_HREF, toolFor, toolStatus } from "./grow-tools";

const counts = (by_module: Record<string, number>, support_open = 0) => ({
  by_module,
  support_open,
});

describe("Grow's tools", () => {
  it("names each tool's screen once, and finds the tool from the screen", () => {
    const hrefs = GROW_TOOLS.map((t) => TOOL_HREF[t]);
    expect(new Set(hrefs).size).toBe(GROW_TOOLS.length);
    expect(toolFor("/content")).toBe("posts");
    expect(toolFor("/support")).toBe("messages");
    expect(toolFor("/cash")).toBeNull(); // not one of Grow's
  });

  it("puts each tool in one half of Grow", () => {
    expect(TOOL_HALF.posts).toBe("bring");
    expect(TOOL_HALF.customers).toBe("keep");
    expect(GROW_TOOLS.every((t) => TOOL_HALF[t] === "bring" || TOOL_HALF[t] === "keep")).toBe(true);
  });
});

describe("a tool card's one figure", () => {
  it("counts what waits for the owner, and messages waiting for an answer", () => {
    expect(toolStatus("site", counts({ site: 1 }))).toEqual({ kind: "waiting", count: 1 });
    expect(toolStatus("deals", counts({ pipeline: 3 }))).toEqual({ kind: "waiting", count: 3 });
    expect(toolStatus("messages", counts({}, 4))).toEqual({ kind: "unanswered", count: 4 });
  });

  it("says nothing where nothing is counted, or before the counts are read", () => {
    expect(toolStatus("posts", counts({}))).toBeNull();
    expect(toolStatus("reviews", counts({ reviews: 2 }))).toBeNull(); // no counted figure of its own
    expect(toolStatus("messages", counts({}, 0))).toBeNull();
    expect(toolStatus("site", null)).toBeNull();
  });
});
