import { describe, expect, it } from "vitest";
import { conversationWord, supportHeadline, waitingTitle, whenShort } from "./support-view";

describe("supportHeadline and waitingTitle", () => {
  it("states the rule only when there is something approved to say", () => {
    expect(supportHeadline(3)).toBe("The assistant only says what you approved.");
    expect(supportHeadline(0)).toBe("Nothing approved yet, so every question comes to you.");
  });

  it("counts who is waiting in words", () => {
    expect(waitingTitle(0)).toBe("Nobody waiting for you");
    expect(waitingTitle(1)).toBe("One waiting for you");
    expect(waitingTitle(12)).toBe("12 waiting for you");
  });
});

describe("conversationWord", () => {
  it("puts an open ticket first, whatever the conversation says", () => {
    expect(conversationWord("escalated", { status: "open", reason: "no_answer" })).toEqual({
      word: "waiting for you",
      tone: "drift",
    });
    expect(conversationWord("escalated", { status: "answered", reason: "no_answer" }).tone).toBe(
      "ok",
    );
  });

  it("falls back to the conversation's own status", () => {
    expect(conversationWord("open", null).word).toBe("open");
    expect(conversationWord("escalated", null).word).toBe("handed to you");
  });
});

describe("whenShort", () => {
  const now = new Date("2026-10-17T15:00:00");
  it("shows a time today and a date long ago", () => {
    expect(whenShort("2026-10-17T13:52:00", now)).toBe("13:52");
    expect(whenShort("2026-08-02T10:00:00", now)).toBe("2 Aug");
  });
});

describe("replyStateWord (P4-10)", () => {
  it("says an unknown send is unconfirmed, never in progress, and only a sent reply is sent", async () => {
    const { replyStateWord } = await import("./support-view");
    expect(replyStateWord("sending")).toEqual({
      word: "unconfirmed · may have sent",
      tone: "alarm",
    });
    expect(replyStateWord("approved").word).toBe("approved · not sent");
    expect(replyStateWord("sent")).toEqual({ word: "sent", tone: "ok" });
    expect(replyStateWord("failed").word).toBe("not sent");
  });
});
