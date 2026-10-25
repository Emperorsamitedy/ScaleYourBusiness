// M-2: the recalibration comparison on fake model outputs — topic
// matching, severity shifts, grounding validity, refusals, totals and the
// rendered report. Pure; no model, no database.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import type { LlmCallRecord } from "../llm/cost-log";
import type { DiagnosisFinding } from "./findings";
import { DiagnosisRefusalError } from "./findings";
import type { ModelRun, PickRun } from "./recalibrate";
import {
  compareBusiness,
  comparePicks,
  estimateTokens,
  failedRun,
  grounding,
  matchFindings,
  MATCH_THRESHOLD,
  renderBusinessText,
  renderMarkdown,
  renderPicksText,
  similarity,
  sonnetTotals,
  toModelRun,
  totals,
} from "./recalibrate";

const f = (over: Partial<DiagnosisFinding>): DiagnosisFinding => ({
  area: "finance",
  title: "Fixed costs are unknown",
  detail: "d",
  evidence: ["costs.fixed_monthly"],
  severity: "high",
  confidence: 0.7,
  ...over,
});

const KEYS = new Set([
  "costs.fixed_monthly",
  "revenue.monthly_revenue",
  "offers.0.unit_cost",
  "marketing.channels",
  "ops.key_person",
]);

const call = (over: Partial<LlmCallRecord> = {}): LlmCallRecord => ({
  at: "2026-10-24T00:00:00.000Z",
  event: "llm_call",
  workload: "diagnosis",
  account_id: "a",
  model: "claude-opus-4-8",
  duration_ms: 1,
  input_tokens: 4_000,
  output_tokens: 2_500,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cost_eur: 0.08,
  ...over,
});

function run(model: string, findings: DiagnosisFinding[], over: Partial<ModelRun> = {}): ModelRun {
  return {
    model,
    refusal: null,
    error: null,
    stop_reason: "end_turn",
    returned: findings.length,
    findings,
    rejected: [],
    summary: "One. Two. Three.",
    input_tokens: 4_000,
    output_tokens: 2_000,
    cost_eur: 0.07,
    ...over,
  };
}

describe("similarity and matching by topic", () => {
  it("the same area and the same evidence is the same topic", () => {
    const a = f({});
    const b = f({ title: "You don't know your fixed costs" });
    expect(similarity(a, b)).toBeGreaterThan(0.7);
    expect(matchFindings([a], [b]).pairs).toHaveLength(1);
  });

  it("the same area alone is not enough", () => {
    const a = f({ title: "Fixed costs are unknown" });
    const b = f({ title: "Late invoices", evidence: ["revenue.monthly_revenue"] });
    expect(similarity(a, b)).toBeLessThan(MATCH_THRESHOLD);
    const m = matchFindings([a], [b]);
    expect(m.pairs).toHaveLength(0);
    expect(m.only_a).toEqual([a]);
    expect(m.only_b).toEqual([b]);
  });

  it("a different area matches only on largely the same evidence", () => {
    const a = f({ area: "operations", evidence: ["ops.key_person"], title: "Key-person risk" });
    const b = f({ area: "finance", evidence: ["ops.key_person"], title: "One person runs it all" });
    expect(matchFindings([a], [b]).pairs).toHaveLength(1);
    const c = f({
      area: "marketing",
      evidence: ["ops.key_person", "marketing.channels", "x", "y"],
    });
    expect(similarity(a, c)).toBe(0);
  });

  it("pairs best-first, each finding used once", () => {
    const a1 = f({ title: "Unit cost unknown", evidence: ["offers.0.unit_cost"] });
    const a2 = f({ title: "Fixed costs unknown", evidence: ["costs.fixed_monthly"] });
    const b1 = f({
      title: "Fixed costs unknown",
      evidence: ["costs.fixed_monthly", "offers.0.unit_cost"],
    });
    const b2 = f({ title: "Unit cost unknown", evidence: ["offers.0.unit_cost"] });
    const m = matchFindings([a1, a2], [b1, b2]);
    expect(m.pairs).toHaveLength(2);
    expect(m.pairs.find((p) => p.a === a1)?.b).toBe(b2);
    expect(m.pairs.find((p) => p.a === a2)?.b).toBe(b1);
  });

  it("records severity shifts: positive means the second model calls it less severe", () => {
    const m = matchFindings([f({ severity: "critical" })], [f({ severity: "medium" })]);
    expect(m.pairs[0]?.severity_shift).toBe(2);
    expect(
      matchFindings([f({ severity: "low" })], [f({ severity: "high" })]).pairs[0]?.severity_shift,
    ).toBe(-2);
  });
});

describe("toModelRun: the app's own checks on each answer", () => {
  const answer = (findings: unknown[]) =>
    JSON.stringify({ summary: "First. Second. Third. Fourth.", findings });

  it("keeps grounded findings severest first and counts the rejected", () => {
    const r = toModelRun({
      model: "claude-opus-5-5",
      text: answer([
        f({ severity: "medium", title: "Medium one" }),
        f({ severity: "critical", title: "Critical one" }),
        f({ title: "Invented", evidence: ["made.up"] }),
      ]),
      stop_reason: "end_turn",
      calls: [call({ model: "claude-opus-5-5", cache_read_input_tokens: 100 })],
      fact_keys: KEYS,
    });
    expect(r.returned).toBe(3);
    expect(r.findings.map((x) => x.title)).toEqual(["Critical one", "Medium one"]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.reason).toMatch(/not in the snapshot: made.up/);
    expect(r.summary).toBe("First. Second. Third.");
    expect(r.input_tokens).toBe(4_100);
    expect(r.cost_eur).toBeCloseTo(0.08, 9);
    expect(grounding(r)).toMatchObject({ returned: 3, kept: 2, rejected: 1 });
    expect(grounding(r).valid_rate).toBeCloseTo(2 / 3, 9);
  });

  it("calls a cut-off answer what it is", () => {
    const r = toModelRun({
      model: "claude-opus-5-5",
      text: '{"summary":"Half',
      stop_reason: "max_tokens",
      calls: [call()],
      fact_keys: KEYS,
    });
    expect(r.error).toBe("cut off at max_tokens");
    expect(r.findings).toEqual([]);
  });

  it("a refusal is counted as a refusal, with its cost", () => {
    const r = failedRun(
      "claude-opus-5-5",
      new DiagnosisRefusalError("diagnosis", "claude-opus-5-5", "bio"),
      [call({ cost_eur: 0.01 })],
    );
    expect(r.refusal).toBe("bio");
    expect(r.error).toBeNull();
    expect(r.stop_reason).toBe("refusal");
    expect(r.cost_eur).toBeCloseTo(0.01, 9);
    const other = failedRun("claude-opus-5-5", new Error("529 overloaded"), []);
    expect(other.refusal).toBeNull();
    expect(other.error).toBe("529 overloaded");
  });

  it("grounding of an empty answer is vacuously valid", () => {
    expect(grounding(run("m", [])).valid_rate).toBe(1);
  });
});

describe("the comparison, totals and the report", () => {
  const a = run("claude-opus-4-8", [
    f({ severity: "critical" }),
    f({ area: "operations", title: "Key-person risk", evidence: ["ops.key_person"] }),
  ]);
  const b = run(
    "claude-opus-5-5",
    [
      f({ severity: "high", title: "You don't know your fixed costs" }),
      f({ area: "marketing", title: "One channel only", evidence: ["marketing.channels"] }),
    ],
    {
      rejected: [{ raw: {}, reason: '"x" · empty evidence' }],
      cost_eur: 0.05,
      output_tokens: 1_500,
    },
  );
  const c = compareBusiness({ label: "Ember | Oak", profile_id: "p1", snapshot_id: "s1", a, b });
  const refused = compareBusiness({
    label: "Second",
    profile_id: "p2",
    snapshot_id: "s2",
    a: run("claude-opus-4-8", [f({})]),
    b: failedRun("claude-opus-5-5", new DiagnosisRefusalError("diagnosis", "m", "bio"), []),
  });

  it("lines up topics, severity changes and what only one model saw", () => {
    expect(c.match.pairs).toHaveLength(1);
    expect(c.severity_changes).toHaveLength(1);
    expect(c.severity_changes[0]?.a.severity).toBe("critical");
    expect(c.severity_changes[0]?.b.severity).toBe("high");
    expect(c.match.only_a.map((x) => x.title)).toEqual(["Key-person risk"]);
    expect(c.match.only_b.map((x) => x.title)).toEqual(["One channel only"]);
    expect(c.grounding.b).toMatchObject({ returned: 3, kept: 2, rejected: 1 });
  });

  it("totals add up across businesses, refusals counted per model", () => {
    const t = totals([c, refused]);
    expect(t.businesses).toBe(2);
    expect(t.findings).toEqual({ a: 3, b: 2 });
    expect(t.matched).toBe(1);
    expect(t.severity_changes).toBe(1);
    expect(t.rejected).toEqual({ a: 0, b: 1 });
    expect(t.refusals).toEqual({ a: 0, b: 1 });
    expect(t.cost_eur.a).toBeCloseTo(0.14, 9);
    expect(t.tokens.b.output).toBe(1_500);
  });

  it("prints a side-by-side for the terminal", () => {
    const text = renderBusinessText(c);
    expect(text).toContain("claude-opus-4-8: 2 findings · grounding 2/2 valid");
    expect(text).toContain("claude-opus-5-5: 2 findings · grounding 2/3 valid");
    expect(text).toContain("(critical → high)");
    expect(text).toContain("− [operations/high] Key-person risk  (only claude-opus-4-8)");
    expect(text).toContain("✗ claude-opus-5-5 rejected:");
    expect(renderBusinessText(refused)).toContain("REFUSED (bio)");
  });

  it("writes markdown with escaped cells and one section per business", () => {
    const md = renderMarkdown({
      generated_at: "2026-10-24T12:00:00.000Z",
      models: { a: "claude-opus-4-8", b: "claude-opus-5-5" },
      rows: [c, refused],
    });
    expect(md).toMatch(/^# Diagnosis recalibration: claude-opus-4-8 vs claude-opus-5-5/);
    expect(md).toContain("| Refusals | 0 | 1 |");
    expect(md).toContain("## Ember \\| Oak");
    expect(md).toContain(
      "| finance | Fixed costs are unknown | You don't know your fixed costs | critical → high |",
    );
    expect(md).toContain("| marketing | — | One channel only | high |");
    expect(md).toContain("| Outcome | 1 findings | REFUSED (bio) |");
  });
});

describe("--sonnet: the interviewer's pick", () => {
  const pick = (over: Partial<PickRun>): PickRun => ({
    model: "claude-sonnet-5",
    question_id: "1.3",
    reason: "r",
    fallback: false,
    error: null,
    calls: 1,
    cache_read_input_tokens: 0,
    cost_eur: 0.01,
    ...over,
  });

  it("same pick, different pick, and a completed interview", () => {
    const same = comparePicks({
      label: "A",
      profile_id: "p",
      candidates: 4,
      a: pick({}),
      b: pick({ model: "claude-sonnet-5-5", cache_read_input_tokens: 9_000 }),
    });
    const diff = comparePicks({
      label: "B",
      profile_id: "q",
      candidates: 4,
      a: pick({}),
      b: pick({ model: "claude-sonnet-5-5", question_id: "2.1", fallback: true }),
    });
    const done = comparePicks({
      label: "C",
      profile_id: "r",
      candidates: 0,
      a: pick({ question_id: null, calls: 0, cost_eur: 0 }),
      b: pick({ model: "claude-sonnet-5-5", question_id: null, calls: 0, cost_eur: 0 }),
    });
    expect([same.same, diff.same, done.same]).toEqual([true, false, false]);
    const report = {
      models: { a: "claude-sonnet-5", b: "claude-sonnet-5-5" },
      rows: [same, diff, done],
    };
    const t = sonnetTotals(report);
    expect(t.agreed).toBe(1);
    expect(t.fallbacks).toEqual({ a: 0, b: 1 });
    expect(t.cache_read.b).toBe(9_000);
    const text = renderPicksText(report);
    expect(text).toContain("claude-sonnet-5-5 2.1 (fallback) · DIFFERENT");
    expect(text).toContain("interview complete");
    expect(text).toContain("TOTAL: same pick on 1/3");
  });
});

describe("the estimate", () => {
  it("over-counts on purpose: 3 characters a token", () => {
    expect(estimateTokens(30_000)).toBe(10_000);
    expect(estimateTokens(1)).toBe(1);
  });
});
