// The shell's small rules (docs/DASHBOARD-OVERHAUL.md B2, B7, D2), each
// with a case that holds and a case that does not.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chipQuestions } from "../chat/ChatScreen";
import { arrivedUnseen, inlineComposer, staysOpen } from "./LexPanel";
import { leavesPage } from "./RouteProgress";
import { BAR_FIT_STEPS, firstFit } from "./useBarFit";

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

describe("Lex across screens (L4b)", () => {
  it("stays open beside the page on a wide screen", () => {
    expect(staysOpen("/cash", true)).toBe(true);
    expect(staysOpen("/settings/team", true)).toBe(true);
  });

  it("closes on a page that holds the conversation, and on a phone, where it covers the page", () => {
    expect(staysOpen("/home", true)).toBe(false);
    expect(staysOpen("/chat", true)).toBe(false);
    expect(staysOpen("/cash", false)).toBe(false);
  });
});

describe("an answer that came while Lex was closed (M2)", () => {
  it("is marked when the reply arrives with the conversation out of view", () => {
    expect(arrivedUnseen(true, false, false)).toBe(true);
  });

  it("is not marked while Lex is still answering, when nothing was asked, or when it was read as it came", () => {
    expect(arrivedUnseen(true, true, false)).toBe(false); // still answering
    expect(arrivedUnseen(false, false, false)).toBe(false); // nothing was asked
    expect(arrivedUnseen(true, false, true)).toBe(false); // open, or on Home: read as it came
  });
});

// 2026-11-20: when Lex's face came to every width, the phone's bar lost the
// "display: none" the two had shared, and its five links showed raw in the
// corner of every wide screen until this was noticed. The sheet is read as
// text here because nothing else would have caught it: every test passed.
describe("the phone's bar is a phone's (app/shell.css)", () => {
  /** The rules outside every @media and @keyframes block: what a wide screen gets. */
  function wideRules(css: string): { selectors: string[]; body: string }[] {
    const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules: { selectors: string[]; body: string }[] = [];
    let at = 0;
    while (at < plain.length) {
      const open = plain.indexOf("{", at);
      if (open === -1) break;
      const head = plain.slice(at, open).trim();
      let depth = 1;
      let end = open + 1;
      while (end < plain.length && depth > 0) {
        if (plain[end] === "{") depth += 1;
        else if (plain[end] === "}") depth -= 1;
        end += 1;
      }
      if (!head.startsWith("@")) {
        rules.push({
          selectors: head.split(",").map((s) => s.trim()),
          body: plain
            .slice(open + 1, end - 1)
            .replace(/\s+/g, " ")
            .trim(),
        });
      }
      at = end;
    }
    return rules;
  }
  const rules = wideRules(readFileSync("app/shell.css", "utf8"));

  it("is not drawn on a wide screen: its one rule there hides it", () => {
    const bar = rules.filter((r) => r.selectors.includes(".sx-bar"));
    expect(bar.map((r) => r.body)).toEqual(["display: none;"]);
  });

  it("shares that rule with nothing that a wide screen shows", () => {
    const bar = rules.find((r) => r.selectors.includes(".sx-bar"));
    expect(bar?.selectors).toEqual([".sx-bar"]);
    // The face is drawn on a wide screen, by a rule of its own.
    const face = rules.find((r) => r.selectors.includes(".sx-fab"));
    expect(face?.body).toContain("position: fixed");
  });

  it("would catch the slip (the check itself)", () => {
    const slipped = wideRules(".sx-bar,\n/* a note */\n.sx-fab { position: fixed; }");
    expect(slipped.filter((r) => r.selectors.includes(".sx-bar")).map((r) => r.body)).not.toEqual([
      "display: none;",
    ]);
    // A rule inside a phone's @media is not a wide screen's.
    expect(wideRules("@media (max-width: 759px) { .sx-bar { display: grid; } }")).toEqual([]);
  });
});

// 2026-11-20: the bar's folds were set at window widths measured in English. In
// Hungarian the same bar needs more room, and on every common laptop the stop
// hung past the right edge. The bar is measured now (useBarFit.ts).
describe("the bar folds until what it holds fits", () => {
  it("keeps everything written out while it fits", () => {
    expect(firstFit(() => true)).toBe(0);
  });

  it("folds one step at a time, and stops at the first step that fits", () => {
    const tried: number[] = [];
    const step = firstFit((n) => {
      tried.push(n);
      return n >= 2;
    });
    expect(step).toBe(2);
    expect(tried).toEqual([0, 1, 2]);
  });

  it("folds all the way when nothing fits, without trying past the last step", () => {
    const tried: number[] = [];
    expect(
      firstFit((n) => {
        tried.push(n);
        return false;
      }),
    ).toBe(BAR_FIT_STEPS);
    expect(tried).toEqual([0, 1, 2, 3, 4]);
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
