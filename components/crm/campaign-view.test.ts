// P4-15 - the campaign send as the owner reads it: one sentence, the gate
// in words, the counts with nothing estimated, unknowns said plainly.
// P4-17 - and once it has gone out, the readback: numbers with units, the
// verdict as a word, and what wasn't measured, said.

import { describe, expect, it } from "vitest";
import type { ReadbackView, SendCounts, SendView } from "./campaign-view";
import {
  countRows,
  measuredSentence,
  phaseFlag,
  readbackFlag,
  readbackRows,
  refusalLines,
  sendSentence,
  unknownLine,
} from "./campaign-view";

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

describe("P4-15 - the campaign's send, in words", () => {
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
    ).toBe("Sent to 1 customer on 19 Oct 2026. A sent email can't be recalled.");
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

/* ── P4-17: the readback ── */

const readback = (over: Partial<ReadbackView> = {}): ReadbackView => ({
  verdict: "helped",
  kind: "winback",
  lift_pp: 30,
  controlled: true,
  arithmetic: "…",
  sent_on: "2026-09-01",
  delivery: {
    sent: 10,
    unknown: 0,
    delivered: 9,
    bounced: 1,
    complained: 0,
    unsubscribed: 1,
    harmed: 1,
  },
  recipients: {
    size: 10,
    erased: 0,
    measured: 10,
    returned: 4,
    waiting: 0,
    measured_through: "2026-10-16T09:00:00.000Z",
  },
  comparison: {
    size: 10,
    erased: 0,
    measured: 10,
    returned: 1,
    waiting: 0,
    measured_through: "2026-10-16T09:00:00.000Z",
  },
  delivery_reported: true,
  replies_to: "hello@emberworks.test",
  ...over,
});

describe("P4-17 - the readback as the owner reads it", () => {
  it("counts and rates with units, replies said to be uncounted, the lift in points", () => {
    const rows = readbackRows(readback());
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by.sent).toMatchObject({ count: "10 emails" });
    expect(by.delivered).toMatchObject({ count: "9 emails", rate: "90.0%" });
    expect(by.bounced).toMatchObject({ count: "1 email", rate: "10.0%" });
    expect(by.unsubscribed).toMatchObject({ count: "1 person", rate: "10.0%" });
    expect(by["marked as spam"]).toMatchObject({ count: "0 people", rate: "0.0%" });
    expect(by.replied).toMatchObject({ count: "not counted" });
    expect(by["bought again since"]).toMatchObject({ count: "4 of 10 measured", rate: "40.0%" });
    expect(by["lapsed customers not emailed, bought again"]).toMatchObject({ rate: "10.0%" });
    expect(by.difference).toMatchObject({ count: "+30.0 points" });
  });

  it("without the delivery webhook, delivery and spam reports say so instead of showing zero", () => {
    const by = Object.fromEntries(
      readbackRows(readback({ delivery_reported: false, lift_pp: null })).map((r) => [r.label, r]),
    );
    expect(by.delivered).toMatchObject({ count: "not reported", rate: "-" });
    expect(by["marked as spam"]).toMatchObject({ count: "not reported" });
    expect(by.difference).toBeUndefined();
  });

  it("one first-person sentence on what was measured and what wasn't", () => {
    const s = measuredSentence(readback());
    expect(s).toMatch(/^I counted delivery, bounces and spam reports/);
    expect(s).toContain("purchases from your customer export of 16 Oct 2026");
    expect(s).toContain("I don't count opens");
    expect(s).toContain("replies, which go straight to you at hello@emberworks.test");
    expect(s).toContain("isn't a controlled test");
    const none = measuredSentence(
      readback({
        delivery_reported: false,
        controlled: false,
        recipients: { ...readback().recipients, measured: 0, measured_through: null },
        comparison: { ...readback().comparison, measured: 0, measured_through: null },
      }),
    );
    expect(none).toContain("purchases from your next customer export, once it comes in");
    expect(none).toContain("the email service's webhook isn't set up yet");
    expect(none).not.toContain("controlled");
  });

  it("the verdict is a worded flag, alarm only for backfired", () => {
    expect(readbackFlag("helped")).toEqual({ word: "helped", tone: "ok" });
    expect(readbackFlag("backfired")).toEqual({ word: "backfired", tone: "alarm" });
    expect(readbackFlag("did_nothing").tone).toBe("low");
    expect(readbackFlag("too_early").word).toBe("too early to say");
    expect(readbackFlag("unmeasured").word).toBe("unmeasured");
  });
});
