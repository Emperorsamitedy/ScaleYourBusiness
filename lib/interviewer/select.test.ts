import { describe, expect, it } from "vitest";
import type { ApplicableQuestion } from "../resolver/applicability";
import { selectCandidates } from "./select";

function q(
  id: string,
  priority: ApplicableQuestion["priority"],
  writes_to = `x.${id}`,
): ApplicableQuestion {
  return {
    id,
    bank_version: "1.0.0",
    section: "identity",
    writes_to,
    priority,
    cost: 1,
    prompt: {},
    help_text: null,
    input: {},
    unlocks: null,
    already_answered: false,
  };
}

describe("P0-49 — deterministic tier gate", () => {
  const applicable = [q("c1", "core"), q("c2", "core"), q("i1", "important"), q("d1", "deep")];

  it("while any core question is open, only core questions are candidates", () => {
    const s = selectCandidates(applicable, new Set(), new Set());
    expect(s.tier).toBe("core");
    expect(s.candidates.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(s.open).toEqual({ core: 2, important: 1, deep: 1 });
  });

  it("important opens only when core is exhausted, deep only when both are", () => {
    const coreDone = selectCandidates(applicable, new Set(["x.c1", "x.c2"]), new Set());
    expect(coreDone.tier).toBe("important");
    expect(coreDone.candidates.map((c) => c.id)).toEqual(["i1"]);

    const deepOnly = selectCandidates(applicable, new Set(["x.c1", "x.c2", "x.i1"]), new Set());
    expect(deepOnly.tier).toBe("deep");
    expect(deepOnly.candidates.map((c) => c.id)).toEqual(["d1"]);
  });

  it("returns null tier when nothing is open — the interview is complete", () => {
    const done = selectCandidates(applicable, new Set(["x.c1", "x.c2", "x.i1", "x.d1"]), new Set());
    expect(done.tier).toBeNull();
    expect(done.candidates).toEqual([]);
  });
});

describe("P0-53 preconditions — the model never even sees these", () => {
  it("a question asked this session is not a candidate, even if still unanswered (skip case)", () => {
    const s = selectCandidates([q("c1", "core"), q("c2", "core")], new Set(), new Set(["c1"]));
    expect(s.candidates.map((c) => c.id)).toEqual(["c2"]);
  });

  it("a question whose target field is responded is not a candidate (multi-answer skip, P0-57 seam)", () => {
    const s = selectCandidates(
      [q("c1", "core", "identity.legal_name"), q("c2", "core")],
      new Set(["identity.legal_name"]),
      new Set(),
    );
    expect(s.candidates.map((c) => c.id)).toEqual(["c2"]);
  });

  it("an explicit unknown counts as responded — never re-asked across sessions", () => {
    const s = selectCandidates(
      [q("c1", "core", "revenue.repeat_customer_rate")],
      new Set(["revenue.repeat_customer_rate"]),
      new Set(),
    );
    expect(s.tier).toBeNull();
  });
});
