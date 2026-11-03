// L-4b: a blindspot's label, arithmetic and fix, and the site note, are
// "blindspotsWords" messages. English is held to the spec's labels and the
// finder's own sentences; a fake translator shows every one goes through
// the catalogue with its counts in the reader's locale.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import type { Tr } from "../i18n/tr";
import { CHECKS, NO_WEBSITE_REASON, UNREADABLE_REASON, checkLabel, siteNote } from "./checks";
import type { CodeDemand } from "./demand";
import { rankBlindspots } from "./finder";
import { englishTr } from "../i18n/tr";

const fake: Tr = (k, v) => `[${k}${v ? " " + JSON.stringify(v) : ""}]`;
const english = { tr: englishTr("blindspotsWords"), locale: "en" as const };

const demand = (over: Partial<CodeDemand>): CodeDemand => ({
  support_asked: 0,
  support_unanswered: 0,
  site_searches: 0,
  google_impressions: 0,
  google_clicks: 0,
  ...over,
});
const args = {
  codes: ["booking"],
  shown: { booking: null },
  demand: new Map([
    [
      "booking",
      demand({
        support_asked: 3,
        support_unanswered: 1,
        google_impressions: 1_500,
        google_clicks: 2,
      }),
    ],
  ]),
  competitorShows: new Map([["booking", 2]]),
  competitorsChecked: 4,
};

describe("English is what the finder always said", () => {
  it("labels every check as the spec does", () => {
    for (const [code, def] of Object.entries(CHECKS.checks))
      expect(checkLabel(code)).toBe(def.label.en);
    expect(checkLabel("not_a_check")).toBe("not_a_check");
  });
  it("spells out the arithmetic and the fix", () => {
    const [b] = rankBlindspots(args).blindspots;
    expect(b?.arithmetic).toBe(
      "not found on your site; asked 3 time(s) in your support chat, 1 left unanswered; 1500 Google search impression(s), 2 click(s); 2 of 4 competitor(s) we checked show it",
    );
    expect(b?.fix).toBe(
      "a website change through the approval queue, or an answer in your support assistant",
    );
  });
  it("words the site note from its kind, never from the screen matching a sentence", () => {
    expect(siteNote(NO_WEBSITE_REASON, english)).toEqual({
      kind: "no_site",
      note: NO_WEBSITE_REASON,
    });
    expect(siteNote(`${UNREADABLE_REASON}: timeout`, english)).toEqual({
      kind: "unreadable",
      note: "the website couldn't be read: timeout",
    });
    expect(siteNote("boom", english)).toEqual({ kind: "error", note: "boom" });
  });
});

describe("another language goes through the translator", () => {
  it("words the label, the arithmetic and the fix, counts in German", () => {
    const [b] = rankBlindspots(args, { tr: fake, locale: "de-DE" }).blindspots;
    expect(b?.label).toBe("[check.booking]");
    expect(b?.fix).toBe("[fix.default]");
    expect(b?.arithmetic.startsWith("[arithmetic.notFound")).toBe(true);
    expect(b?.arithmetic).toContain('\\"n\\":\\"1.500\\"');
    expect(b?.arithmetic).not.toMatch(/time\(s\)|your site| competitor/);
    expect(siteNote(`${UNREADABLE_REASON}: timeout`, { tr: fake }).note).toBe(
      '[siteNote.unreadable {"detail":"timeout"}]',
    );
  });
});
