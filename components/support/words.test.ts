// L-3c: the support desk's catalogue says in English exactly what the
// code's own words say, and its figures and times follow the reader's locale.

// The server constants' modules open the database module on import.
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { englishTr } from "../../lib/i18n/tr";
import { GIVEN_IN_CHAT, SENDER_NOT_VERIFIED } from "../../lib/support/email-tickets";
import { SUPPORT_EMAIL_BODY_MAX_CHARS } from "../../lib/support/inbound";
import { durationText, slaState, slaWords } from "../../lib/support/sla";
import {
  EMAIL_KEPT_CHARS,
  TICKET_REASONS,
  dayWord,
  durationWords,
  reasonWord,
  senderNoteWord,
  slaFlagWords,
  waitingTitle,
  whenShort,
} from "./support-view";

const tr = englishTr("support");

describe("the support desk's English is the code's own words", () => {
  it("words a duration exactly as lib/support/sla does", () => {
    for (const minutes of [
      0,
      1,
      45,
      59,
      60,
      61,
      200,
      47 * 60 + 59,
      48 * 60,
      52 * 60,
      30 * 24 * 60,
    ]) {
      const ms = minutes * 60_000;
      expect(durationWords(ms), String(minutes)).toBe(durationText(ms));
    }
  });

  it("words every reply-time flag exactly as slaWords does", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    for (const [since, hours] of [
      ["2026-10-18T09:00:00Z", 24],
      ["2026-10-18T09:00:00Z", 48],
      ["2026-10-19T03:00:00Z", 10],
      ["2026-10-18T09:00:00Z", null],
    ] as const) {
      const state = slaState(since, now, hours);
      expect(slaFlagWords(state)).toEqual(slaWords(state));
    }
  });

  it("knows the server's sender notes and how much of an email is kept", () => {
    expect(senderNoteWord(SENDER_NOT_VERIFIED)).toBe(SENDER_NOT_VERIFIED);
    expect(senderNoteWord(GIVEN_IN_CHAT)).toBe(GIVEN_IN_CHAT);
    expect(senderNoteWord("something else")).toBe("something else");
    expect(EMAIL_KEPT_CHARS).toBe(SUPPORT_EMAIL_BODY_MAX_CHARS);
    expect(tr("emails.truncated", { chars: "20,000" })).toBe(
      "This email was longer than I keep; I kept the first 20,000 characters.",
    );
  });

  it("names every hand-over reason, and counts who is waiting in words up to nine", () => {
    for (const r of TICKET_REASONS) expect(reasonWord(r)).not.toContain("support.");
    expect(reasonWord("customer_asked")).toBe("asked for a person");
    expect(waitingTitle(9)).toBe("Nine waiting for you");
    expect(waitingTitle(10)).toBe("10 waiting for you");
  });
});

describe("the support desk's figures and times in the reader's locale", () => {
  it("groups a duration's figures the reader's way", () => {
    const ms = 1_234 * 24 * 3_600_000;
    expect(durationWords(ms)).toBe("1,234 d");
    expect(durationWords(ms, tr, "de-DE")).toBe("1.234 d");
  });

  it("writes dates and times in the reader's language", () => {
    const now = new Date("2026-10-17T15:00:00");
    expect(whenShort("2026-08-02T10:00:00", now, "de-DE")).toBe("2. Aug.");
    expect(whenShort("2026-08-02T10:00:00", now, "fr-FR")).toBe("2 août");
    expect(dayWord("2026-10-02T10:00:00")).toBe("02 Oct");
    expect(dayWord("2026-10-02T10:00:00", "zh-Hans")).toBe("10月02日");
  });
});
