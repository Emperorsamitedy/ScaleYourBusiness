// The shell's small rules (docs/DASHBOARD-OVERHAUL.md B2, B7, D2), each
// with a case that holds and a case that does not.

import { describe, expect, it } from "vitest";
import { chipQuestions } from "../chat/ChatScreen";
import { inlineComposer } from "./LexPanel";
import { leavesPage } from "./RouteProgress";

describe("the loading bar", () => {
  const here = { origin: "http://localhost:3000", pathname: "/watch" };

  it("starts for a link to another screen of the app", () => {
    expect(leavesPage({ href: "/cash" }, here)).toBe(true);
    expect(leavesPage({ href: "http://localhost:3000/proposals?tab=made" }, here)).toBe(true);
  });

  it("stays away for the same screen, another site, a new tab or a download", () => {
    expect(leavesPage({ href: "/watch?focus=revenue" }, here)).toBe(false);
    expect(leavesPage({ href: "/watch#signals" }, here)).toBe(false);
    expect(leavesPage({ href: "https://example.com/cash" }, here)).toBe(false);
    expect(leavesPage({ href: "/cash", target: "_blank" }, here)).toBe(false);
    expect(leavesPage({ href: "/api/statement.pdf", download: true }, here)).toBe(false);
    expect(leavesPage({ href: "http://[bad" }, here)).toBe(false);
  });
});

describe("where Ask Lex lands", () => {
  it("uses the page's own composer on Home and on the conversation page", () => {
    expect(inlineComposer("/home")).toBe("home-ask");
    expect(inlineComposer("/chat")).toBe("ak-input");
  });

  it("opens the sheet everywhere else", () => {
    expect(inlineComposer("/watch")).toBeNull();
    expect(inlineComposer("/homework")).toBeNull(); // a path that only starts alike
    expect(inlineComposer("/settings/team")).toBeNull();
  });
});

describe("the first-question chips", () => {
  it("reads Home's three questions in their order", () => {
    const messages = {
      home: { ask: { chip: { first: "What should I fix first?", today: "What needs me today?" } } },
    };
    expect(chipQuestions(messages)).toEqual(["What needs me today?", "What should I fix first?"]);
  });

  it("shows none where the catalogue has none, rather than a key or an empty button", () => {
    expect(chipQuestions({})).toEqual([]);
    expect(chipQuestions({ home: { ask: {} } })).toEqual([]);
    expect(chipQuestions({ home: { ask: { chip: { today: "", sales: 3 } } } })).toEqual([]);
    expect(chipQuestions(null)).toEqual([]);
  });
});
