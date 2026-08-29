import { describe, expect, it } from "vitest";
import { buildCallRecord, summarizeCalls } from "./cost-log";
import { costEur, UnknownModelError, USD_TO_EUR } from "./pricing";

describe("costEur", () => {
  it("prices uncached input, output, cache writes and cache reads distinctly", () => {
    // 1M of each bucket on Sonnet 5 intro pricing ($2 in / $10 out):
    // in 2 + write 2×1.25 + read 2×0.1 + out 10 = 14.70 USD
    const eur = costEur("claude-sonnet-5", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    expect(eur).toBeCloseTo(14.7 * USD_TO_EUR, 6);
  });

  it("makes a cached bank read 10x cheaper than an uncached one", () => {
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0 };
    const cached = costEur("claude-sonnet-5", { ...usage, cache_read_input_tokens: 25_000 });
    const uncached = costEur("claude-sonnet-5", {
      ...usage,
      cache_read_input_tokens: 0,
      input_tokens: 25_000,
    });
    expect(uncached / cached).toBeCloseTo(10, 6);
  });

  it("refuses an unpriced model — no silent free calls", () => {
    expect(() =>
      costEur("claude-nonexistent-9", {
        input_tokens: 1,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toThrow(UnknownModelError);
  });
});

describe("call records and summaries", () => {
  it("tags workload and account on every record and sums correctly", () => {
    const record = buildCallRecord({
      workload: "interviewer",
      account_id: "acct-1",
      model: "claude-sonnet-5",
      duration_ms: 900,
      usage: {
        input_tokens: 1200,
        output_tokens: 60,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 25_000,
      },
    });
    expect(record.workload).toBe("interviewer");
    expect(record.account_id).toBe("acct-1");
    expect(record.cost_eur).toBeGreaterThan(0);

    const summary = summarizeCalls([record, record]);
    expect(summary.calls).toBe(2);
    expect(summary.cache_read_input_tokens).toBe(50_000);
    expect(summary.cache_hit_rate).toBeCloseTo(50_000 / 52_400, 5);
    expect(summary.cost_eur).toBeCloseTo(record.cost_eur * 2, 9);
  });
});

describe("diagnosis model pricing (Session E)", () => {
  it("prices claude-opus-4-8 at $5/$25 per MTok", () => {
    const eur = costEur("claude-opus-4-8", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(eur).toBeCloseTo(30 * 0.92, 6);
  });
});
