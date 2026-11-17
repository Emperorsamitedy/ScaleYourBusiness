import { describe, expect, it } from "vitest";
import type { MadeProposal } from "./made-model";
import { madeRows, previewOf } from "./made-model";

const p = (id: string, status: string, over: Partial<MadeProposal> = {}): MadeProposal => ({
  id,
  status,
  action: { summary: id },
  created_at: "2026-11-17 09:00:00+00",
  ...over,
});

// docs/DASHBOARD-OVERHAUL.md C7: everything Lex drafted, with its state.
describe("Home's Made list", () => {
  it("puts what waits first, then the rest newest first", () => {
    const rows = madeRows([
      p("old", "approved", { decided_at: "2026-11-10 09:00:00+00" }),
      p("ran", "executed", { decided_at: "2026-11-16 09:00:00+00" }),
      p("wait-a", "pending", { created_at: "2026-11-15 09:00:00+00" }),
      p("wait-b", "pending", { created_at: "2026-11-17 09:00:00+00" }),
      p("held", "blocked", { created_at: "2026-11-12 09:00:00+00" }),
    ]);
    expect(rows.map((r) => `${r.proposal.id}:${r.state}`)).toEqual([
      "wait-b:waiting",
      "wait-a:waiting",
      "ran:done",
      "held:blocked",
      "old:approved",
    ]);
  });

  it("never lists more than asked, and leaves out a status it has no word for", () => {
    expect(madeRows([p("a", "pending"), p("b", "pending"), p("c", "pending")], 2)).toHaveLength(2);
    expect(madeRows([p("x", "mystery")])).toEqual([]);
    expect(madeRows([])).toEqual([]);
  });
});

describe("Home's Made list: one line of the thing itself", () => {
  it("reads a short before and after whole, and a long one as what it would become", () => {
    expect(previewOf(null, [{ before: "€24", after: "€26" }])).toBe("€24 → €26");
    const long = "dipped in our oatmeal speckle glaze. Every one is slightly different.";
    const after =
      "dipped in our oatmeal speckle glaze. Dishwasher and microwave safe. Every one is slightly different.";
    expect(previewOf({ find: long, replace: after }, [{ before: long, after }], 80)).toBe(
      `${after.slice(0, 79).trimEnd()}…`,
    );
  });

  it("falls back to what would be sent, the first answer or item, then the reason given", () => {
    expect(previewOf({ what: "One email,   in your voice." }, null)).toBe(
      "One email, in your voice.",
    );
    expect(
      previewOf({ entries: [{ question: "Q?", answer: "We glaze twice a week." }] }, null),
    ).toBe("We glaze twice a week.");
    expect(previewOf({ items: [{ brief: "A short vertical video." }] }, null)).toBe(
      "A short vertical video.",
    );
    expect(previewOf({ rationale: "It sells out." }, null)).toBe("It sells out.");
  });

  it("says nothing when the proposal states nothing, rather than inventing a line", () => {
    expect(previewOf({}, null)).toBeNull();
    expect(previewOf("words", null)).toBeNull();
    expect(previewOf({ what: "   " }, [])).toBeNull();
  });
});
