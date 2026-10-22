import { describe, expect, it } from "vitest";
import type { ChangeCardView, Turn } from "./chat-view";
import {
  canConfirm,
  cardFlag,
  cardKicker,
  cardsFor,
  earlierQuestions,
  latestQuestion,
  paragraphs,
  stamp,
  upsertCard,
} from "./chat-view";

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

describe("the change card (feature 33)", () => {
  const card = (over: Partial<ChangeCardView> = {}): ChangeCardView => ({
    id: "c1",
    reply_id: "r1",
    status: "prepared",
    summary: "Set your Saturday opening hours to 10:00–16:00",
    current: "09:00–14:00",
    proposed: "10:00–16:00",
    link: "/profile?focus=fact-presence.opening_hours",
    screen: "Fact sheet",
    confirm: "Make this change",
    prepare: "direct",
    result: null,
    ...over,
  });

  it("a reply carries its own cards; a question asked or answered draws none", () => {
    const cards = [
      card(),
      card({ id: "c2", status: "asked" }),
      card({ id: "c3", reply_id: "r2" }),
      card({ id: "c4", status: "superseded" }),
    ];
    expect(cardsFor("r1", cards).map((c) => c.id)).toEqual(["c1"]);
  });

  it("the button only while it is still a draft, and never on a link-only card", () => {
    expect(canConfirm(card())).toBe(true);
    expect(canConfirm(card({ status: "applied" }))).toBe(false);
    expect(canConfirm(card({ status: "link_only", confirm: null }))).toBe(false);
  });

  it("the worded result: changed, queued, or not changed — never before the click", () => {
    expect(cardFlag(card())).toBeNull();
    expect(cardFlag(card({ status: "applied" }))?.word).toBe("Changed");
    expect(cardFlag(card({ status: "queued", prepare: "proposal" }))?.word).toBe("In your queue");
    expect(cardFlag(card({ status: "stale" }))).toEqual({ word: "Not changed", tone: "drift" });
    expect(cardKicker(card())).toBe("Drafted, not yet made · Fact sheet");
    expect(cardKicker(card({ status: "link_only" }))).toBe("Yours to change · Fact sheet");
    expect(cardKicker(card({ status: "applied" }))).toBe("Made · Fact sheet");
  });

  it("a click's result replaces the card in place", () => {
    const after = upsertCard([card(), card({ id: "c9" })], card({ status: "applied" }));
    expect(after.map((c) => `${c.id}:${c.status}`)).toEqual(["c1:applied", "c9:prepared"]);
    expect(upsertCard([], card()).length).toBe(1);
  });
});
