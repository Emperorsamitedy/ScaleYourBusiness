// L-3c: the chat and mode screens' catalogue says in English exactly what
// the code always said, and their dates follow the reader's locale.

import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { englishTr } from "../../lib/i18n/tr";
import type { ChangeCardView } from "./chat-view";
import { cardFlag, cardKicker, stamp } from "./chat-view";
import type { ModeDecision } from "../mode/mode-view";
import { chosenLine, dayMonth, headline } from "../mode/mode-view";

const card = (over: Partial<ChangeCardView> = {}): ChangeCardView => ({
  id: "c1",
  reply_id: "r1",
  status: "prepared",
  summary: "Set your Saturday opening hours",
  current: null,
  proposed: null,
  link: "/profile",
  screen: "Fact sheet",
  confirm: "Make this change",
  prepare: "direct",
  result: null,
  ...over,
});

const decision: ModeDecision = {
  mode: "watching",
  watch_weeks: 4,
  decided_at: "2026-09-29 10:00:00+00",
  reasons: [],
  reasoning: "stored",
  review_at: "2026-10-27 10:00:00+00",
  owner_override: { kind: "shorten", from_weeks: 8, to_weeks: 1, at: "2026-10-03 09:00:00+00" },
};

describe("the chat's English is the code's own words", () => {
  it("words every card state as before", () => {
    const tr = englishTr("chat");
    expect(cardKicker(card({ status: "queued" }), tr)).toBe("In your queue · Fact sheet");
    expect(cardKicker(card({ status: "stale" }))).toBe("Not made · Fact sheet");
    expect(cardKicker(card({ prepare: "proposal" }))).toBe("Drafted for your queue · Fact sheet");
    expect(cardFlag(card({ status: "applied" }), tr)?.word).toBe("Changed");
    expect(en.chat.meta.title).toBe("Ask me anything — ScaleX");
    expect(en.mode.meta.title).toBe("How I work — ScaleX");
  });

  it("agrees an override's week count at one, the only English that moved", () => {
    expect(chosenLine(decision)).toBe("Chosen 29 Sep · shortened to 1 week 3 Oct");
    expect(headline({ ...decision, owner_override: null })).toBe("Watching first, for 28 days.");
  });
});

describe("the chat's and mode's dates in the reader's locale", () => {
  it("writes the day and month the language's way, keeping the time", () => {
    const at = "2026-10-09T12:10:00Z";
    const now = Date.parse("2026-11-02T12:00:00Z");
    const local = new Date(at);
    const hm = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
    expect(stamp(at, now)).toBe(`${local.getDate()} Oct ${hm}`);
    expect(stamp(at, now, "de-DE")).toBe(`${local.getDate()}. Okt. ${hm}`);
    expect(stamp(at, now, "zh-Hans")).toBe(`10月${local.getDate()}日 ${hm}`);
  });

  it("says when the mode was chosen in the reader's writing", () => {
    const ms = Date.parse("2026-09-15T12:00:00Z");
    expect(dayMonth(ms)).toBe("15 Sep");
    expect(dayMonth(ms, "fr-FR")).toBe("15 sept.");
    expect(chosenLine({ ...decision, owner_override: null }, englishTr("mode"), "hu-HU")).toBe(
      "Chosen szept. 29.",
    );
  });
});
