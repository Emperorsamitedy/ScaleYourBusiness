import { describe, expect, it } from "vitest";
import { attentionCount, attentionItems } from "./attention";

describe("what the bell lists", () => {
  it("lists what needs the owner, the most urgent first, each with where it lives", () => {
    const items = attentionItems({ pending: 2, needs_reconnect: 1, support_open: 3 });
    expect(items).toEqual([
      { key: "decisions", count: 2, href: "/proposals" },
      { key: "paused", count: 1, href: "/connections" },
      { key: "support", count: 3, href: "/support" },
    ]);
    expect(attentionCount(items)).toBe(6);
  });

  it("never lists a zero, and lists nothing before the counts have been read", () => {
    expect(attentionItems({ pending: 0, needs_reconnect: 0, support_open: 0 })).toEqual([]);
    expect(attentionItems({ pending: 0, needs_reconnect: 2, support_open: 0 })).toEqual([
      { key: "paused", count: 2, href: "/connections" },
    ]);
    expect(attentionItems(null)).toEqual([]);
    expect(attentionCount([])).toBe(0);
  });
});
