import { describe, expect, it } from "vitest";
import { buildCallRecord, summarizeCalls } from "./cost-log";
import {
  costEur,
  costUsd,
  eurPerUsd,
  promptTokens,
  UnknownModelError,
  USD_TO_EUR,
  useEcbUsdRate,
  webSearchCostEur,
} from "./pricing";

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

describe("the 5.5 Sonnet and Opus (M-2 prep)", () => {
  const zero = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const mtok = (over: Partial<Record<keyof typeof zero, number>>) => ({ ...zero, ...over });

  it("prices claude-sonnet-5-5 like Sonnet 5: $2/$10, writes $2.50, reads $0.20", () => {
    expect(costEur("claude-sonnet-5-5", mtok({ input_tokens: 1e6 }))).toBeCloseTo(2 * 0.92, 9);
    expect(costEur("claude-sonnet-5-5", mtok({ output_tokens: 1e6 }))).toBeCloseTo(10 * 0.92, 9);
    expect(costEur("claude-sonnet-5-5", mtok({ cache_creation_input_tokens: 1e6 }))).toBeCloseTo(
      2.5 * 0.92,
      9,
    );
    expect(costEur("claude-sonnet-5-5", mtok({ cache_read_input_tokens: 1e6 }))).toBeCloseTo(
      0.2 * 0.92,
      9,
    );
  });

  it("prices claude-opus-5-5 at $4/$20, writes $5, reads $0.20 (0.05×, not 0.1×)", () => {
    expect(costEur("claude-opus-5-5", mtok({ input_tokens: 1e6 }))).toBeCloseTo(4 * 0.92, 9);
    expect(costEur("claude-opus-5-5", mtok({ output_tokens: 1e6 }))).toBeCloseTo(20 * 0.92, 9);
    expect(costEur("claude-opus-5-5", mtok({ cache_creation_input_tokens: 1e6 }))).toBeCloseTo(
      5 * 0.92,
      9,
    );
    expect(costEur("claude-opus-5-5", mtok({ cache_read_input_tokens: 1e6 }))).toBeCloseTo(
      0.2 * 0.92,
      9,
    );
  });

  it("records the model the call actually used", () => {
    const usage = mtok({ input_tokens: 1_000, output_tokens: 500 });
    const base = { workload: "diagnosis", account_id: "a", duration_ms: 1, usage };
    const old = buildCallRecord({ ...base, model: "claude-opus-4-8" });
    const next = buildCallRecord({ ...base, model: "claude-opus-5-5" });
    expect(old.model).toBe("claude-opus-4-8");
    expect(next.model).toBe("claude-opus-5-5");
    expect(next.cost_eur).toBeLessThan(old.cost_eur); // about 20 % cheaper
    expect(next.cost_eur / old.cost_eur).toBeCloseTo(0.8, 9);
  });
});

describe("web search fees (review 2026-10-23, finding 9)", () => {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  it("adds $10 per 1,000 searches to the call's cost", () => {
    const base = { workload: "research_search", account_id: "a", model: "claude-haiku-5-5" };
    const none = buildCallRecord({ ...base, duration_ms: 1, usage });
    const three = buildCallRecord({ ...base, duration_ms: 1, usage, web_search_requests: 3 });
    expect(none.cost_eur).toBe(0);
    expect(three.cost_eur).toBeCloseTo(0.03 * USD_TO_EUR, 9);
    expect(webSearchCostEur(-1)).toBe(0);
    expect(webSearchCostEur(Number.NaN)).toBe(0);
  });
});

describe("Haiku 5.5's two rate cards, chosen by prompt length (2026-10-24)", () => {
  const usage = (input: number, output: number, write = 0, read = 0) => ({
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: write,
    cache_read_input_tokens: read,
  });

  it("bills a prompt of 100K tokens or fewer at $0.10 in / $0.50 out", () => {
    // 100,000 in at $0.10/M = $0.01; 10,000 out at $0.50/M = $0.005.
    expect(costEur("claude-haiku-5-5", usage(100_000, 10_000))).toBeCloseTo(0.015 * USD_TO_EUR, 9);
  });

  it("bills a longer prompt at $0.50 in / $2.50 out, output included", () => {
    // 100,001 in at $0.50/M = $0.0500005; 10,000 out at $2.50/M = $0.025.
    expect(costEur("claude-haiku-5-5", usage(100_001, 10_000))).toBeCloseTo(
      0.0750005 * USD_TO_EUR,
      9,
    );
  });

  it("puts the boundary at exactly 100,000: at it is short, one more is long", () => {
    const at = costEur("claude-haiku-5-5", usage(100_000, 0));
    const over = costEur("claude-haiku-5-5", usage(100_001, 0));
    expect(at).toBeCloseTo(0.01 * USD_TO_EUR, 9);
    expect(over).toBeCloseTo(0.0500005 * USD_TO_EUR, 9); // the long card, five times the rate
  });

  it("counts cache writes and reads toward the prompt length, at the card's multipliers", () => {
    // 1,000 uncached + 60,000 written + 40,000 read = 101,000: the long card.
    const u = usage(1_000, 2_000, 60_000, 40_000);
    expect(promptTokens(u)).toBe(101_000);
    // in 1,000×0.50 + write 60,000×0.50×1.25 + read 40,000×0.50×0.1 + out 2,000×2.50, per M
    const usd = (1_000 * 0.5 + 60_000 * 0.625 + 40_000 * 0.05 + 2_000 * 2.5) / 1_000_000;
    expect(costEur("claude-haiku-5-5", u)).toBeCloseTo(usd * USD_TO_EUR, 9);

    // The same mix under the line stays on the short card.
    const short = usage(1_000, 2_000, 59_000, 40_000);
    const shortUsd = (1_000 * 0.1 + 59_000 * 0.125 + 40_000 * 0.01 + 2_000 * 0.5) / 1_000_000;
    expect(costEur("claude-haiku-5-5", short)).toBeCloseTo(shortUsd * USD_TO_EUR, 9);
  });

  it("makes a cached read 10x cheaper than uncached on Haiku 5.5 too", () => {
    const cached = costEur("claude-haiku-5-5", usage(0, 0, 0, 20_000));
    const uncached = costEur("claude-haiku-5-5", usage(20_000, 0));
    expect(uncached / cached).toBeCloseTo(10, 6);
  });

  it("keeps Haiku 4.5 priced at $1/$5 at any length, for the rows it already wrote", () => {
    expect(costEur("claude-haiku-4-5", usage(1_000_000, 1_000_000))).toBeCloseTo(6 * USD_TO_EUR, 6);
    expect(costEur("claude-haiku-4-5", usage(200_000, 0)) * 5).toBeCloseTo(
      costEur("claude-haiku-4-5", usage(1_000_000, 0)),
      9,
    );
  });

  it("logs the model and the card's cost on the call record", () => {
    const record = buildCallRecord({
      workload: "parser",
      account_id: "acct-1",
      model: "claude-haiku-5-5",
      duration_ms: 5,
      usage: usage(2_000, 300),
    });
    expect(record.model).toBe("claude-haiku-5-5");
    // 2,000 × $0.10/M + 300 × $0.50/M = $0.00035
    expect(record.cost_eur).toBeCloseTo(0.00035 * USD_TO_EUR, 12);
  });
});

describe("D48 — the meter prices at the stored ECB rate", () => {
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  it("an ECB row (USD per 1 EUR) sets the rate; the fallback only when none is readable", () => {
    try {
      useEcbUsdRate({ per_eur: "1.2500", date: "2026-11-11" });
      expect(eurPerUsd()).toEqual({ rate: 0.8, date: "2026-11-11" });
      // Sonnet 5: 1M input = $2 → €1.60 at 1.25 USD per EUR
      expect(costEur("claude-sonnet-5", usage)).toBeCloseTo(1.6, 9);
      expect(costUsd("claude-sonnet-5", usage)).toBeCloseTo(2, 9);

      useEcbUsdRate({ per_eur: "not a rate", date: "2026-11-11" });
      expect(eurPerUsd()).toEqual({ rate: USD_TO_EUR, date: null });
      useEcbUsdRate(null);
      expect(costEur("claude-sonnet-5", usage)).toBeCloseTo(2 * USD_TO_EUR, 9);
    } finally {
      useEcbUsdRate(null);
    }
  });
});
