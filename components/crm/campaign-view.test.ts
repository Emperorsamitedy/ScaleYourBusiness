// P4-15 — the campaign send as the owner reads it: one sentence, the gate
// in words, the counts with nothing estimated, unknowns said plainly.

import { describe, expect, it } from "vitest";
import type { SendCounts, SendView } from "./campaign-view";
import { countRows, phaseFlag, refusalLines, sendSentence, unknownLine } from "./campaign-view";

const counts = (over: Partial<SendCounts> = {}): SendCounts => ({
  pending: 0,
  refused: 0,
  sending: 0,
  sent: 0,
  failed: 0,
  unknown: 0,
  unsubscribed: 0,
  total: 0,
  refused_by_reason: {},
  ...over,
});

const view = (over: Partial<SendView>): SendView => ({
  phase: "held",
  gates: [],
  counts: counts(),
  approved_at: null,
  subject: null,
  body_sha256: null,
  execution: null,
  ...over,
});

describe("P4-15 — the campaign's send, in words", () => {
  it("a held campaign names the gate holding it, first in order", () => {
    expect(
      sendSentence(
        view({
          gates: [
            { code: "law_review_missing", words: "Nobody has reviewed the email-law rules yet." },
            { code: "not_connected", words: "Campaign email isn't connected." },
          ],
        }),
        12,
      ),
    ).toBe("Approved, not sent. Nobody has reviewed the email-law rules yet.");
  });

  it("sent says how many, when, and that it can't be recalled", () => {
    expect(
      sendSentence(
        view({
          phase: "sent",
          counts: counts({ sent: 1 }),
          execution: {
            status: "succeeded",
            held_for: null,
            error: null,
            finished_at: "2026-10-19T09:00:00Z",
          },
        }),
        3,
      ),
    ).toBe("Sent to 1 customer on 2026-10-19. A sent email can't be recalled.");
    expect(sendSentence(view({ phase: "awaiting_approval" }), 1)).toMatch(
      /^Drafted for 1 customer\./,
    );
  });

  it("cobalt only while it is genuinely sending", () => {
    expect(phaseFlag("sending").tone).toBe("live");
    for (const p of ["sent", "held", "awaiting_approval", "awaiting_draft"] as const) {
      expect(phaseFlag(p).tone).not.toBe("live");
    }
  });

  it("counts leave out zeros (sent always shows), and unknown includes a send in flight", () => {
    expect(
      countRows(counts({ sent: 2, refused: 3, unknown: 1, sending: 1, unsubscribed: 1 })),
    ).toEqual([
      { label: "sent", n: 2 },
      { label: "refused at send", n: 3 },
      { label: "outcome unknown", n: 2 },
      { label: "unsubscribed since", n: 1 },
    ]);
    expect(countRows(counts())).toEqual([{ label: "sent", n: 0 }]);
  });

  it("refusals by reason, most first, in words", () => {
    expect(
      refusalLines(
        counts({ refused_by_reason: { consent_implied: 1, consent_unsure: 4, weird_code: 1 } }),
      ),
    ).toEqual(["consent unsure · 4", "consent only implied · 1", "weird_code · 1"]);
  });

  it("unknowns are said plainly, or not at all", () => {
    expect(unknownLine(counts())).toBeNull();
    expect(unknownLine(counts({ unknown: 1 }))).toMatch(/^1 email may have gone out/);
    expect(unknownLine(counts({ unknown: 2 }))).toMatch(/I won't send to those customers again/);
  });
});
