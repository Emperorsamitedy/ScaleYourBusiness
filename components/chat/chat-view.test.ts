import { describe, expect, it } from "vitest";
import type { Turn } from "./chat-view";
import { earlierQuestions, latestQuestion, paragraphs, stamp } from "./chat-view";

const t = (id: string, role: Turn["role"], text: string, at = "2026-10-17 12:10:00+00"): Turn => ({
  id,
  role,
  text,
  at,
  intent: null,
});

describe("chat view", () => {
  const turns = [
    t("1", "owner", "Which mugs break in transit?"),
    t("2", "system", "The fragile ones."),
    t("3", "owner", "What's my best month ever?"),
    t("4", "system", "October."),
    t("5", "owner", "Why did October get worse?"),
  ];

  it("titles the sheet with the latest question, and nothing when there is none", () => {
    expect(latestQuestion(turns)).toBe("Why did October get worse?");
    expect(latestQuestion([])).toBeNull();
    expect(latestQuestion([t("2", "system", "Hello")])).toBeNull();
  });

  it("lists earlier questions newest first, without the title's", () => {
    expect(earlierQuestions(turns).map((q) => q.id)).toEqual(["3", "1"]);
    expect(earlierQuestions(turns, 1).map((q) => q.id)).toEqual(["3"]);
  });

  it("an unsent optimistic turn is never offered as an earlier question", () => {
    const withTmp = [...turns, t("tmp-1", "owner", "pending")];
    expect(latestQuestion(withTmp)).toBe("pending");
    expect(earlierQuestions(withTmp).map((q) => q.id)).toEqual(["5", "3", "1"]);
  });

  it("stamps today's turns with the time and older ones with the day", () => {
    const at = "2026-10-17T12:10:00Z";
    const today = stamp(at, Date.parse(at));
    expect(today).toMatch(/^\d\d:\d\d$/);
    expect(stamp(at, Date.parse("2026-11-02T12:00:00Z"))).toMatch(/^1[78] Oct \d\d:\d\d$/);
  });

  it("splits a reply into its paragraphs", () => {
    expect(paragraphs("One.\n\nTwo.\n\n\n  Three. ")).toEqual(["One.", "Two.", "Three."]);
  });
});
