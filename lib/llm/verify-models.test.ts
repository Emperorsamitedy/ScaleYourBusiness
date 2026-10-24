// M-1's judging logic on recorded fake responses: every check has a
// passing case and at least one failing one, and every check fails when
// the response or the logged cost line names a model other than Haiku 5.5.

import { describe, expect, it } from "vitest";
import type { Exchange, LoggedCall, Observation } from "./verify-models";
import {
  costCeilingEur,
  formatVerdict,
  judgeCacheRead,
  judgeDiscovery,
  judgeJsonWithinCap,
  judgeLimits,
  judgeOneSearch,
  judgeParser,
  judgeParserTokenCount,
  judgeRoomToFinish,
  PLANNED_CALLS,
  summarize,
} from "./verify-models";

/** A recorded response, as the tape stores it. */
function exchange(over: {
  model?: string;
  stop_reason?: string;
  max_tokens?: number;
  output_tokens?: number;
  cache_creation?: number;
  cache_read?: number;
  searches?: number;
}): Exchange {
  return {
    max_tokens: over.max_tokens ?? 1_000,
    response: {
      model: over.model ?? "claude-haiku-5-5",
      stop_reason: over.stop_reason ?? "end_turn",
      usage: {
        input_tokens: 700,
        output_tokens: over.output_tokens ?? 90,
        cache_creation_input_tokens: over.cache_creation ?? 0,
        cache_read_input_tokens: over.cache_read ?? 0,
        server_tool_use: { web_search_requests: over.searches ?? 0 },
      },
    },
  };
}
const line = (model = "claude-haiku-5-5"): LoggedCall => ({
  model,
  workload: "parser",
  cost_eur: 0.0001,
});
const obs = (exchanges: Exchange[], logged = exchanges.map(() => line())): Observation => ({
  exchanges,
  logged,
  error: null,
});

describe("what every check asserts", () => {
  it("fails when the response names another model", () => {
    const v = judgeOneSearch(obs([exchange({ model: "claude-haiku-4-5", searches: 1 })]), 3);
    expect(v.pass).toBe(false);
    expect(v.failures.join()).toMatch(/names claude-haiku-4-5/);
  });
  it("fails when the logged cost line names another model, or is missing", () => {
    const e = exchange({ searches: 1 });
    expect(judgeOneSearch(obs([e], [line("claude-haiku-4-5")]), 1).pass).toBe(false);
    expect(judgeOneSearch(obs([e], []), 1).failures.join()).toMatch(/0 cost line/);
  });
  it("fails when the app's function threw, and says what it threw", () => {
    const v = judgeOneSearch({ ...obs([]), error: "the model declined (cyber)" }, 0);
    expect(v.pass).toBe(false);
    expect(v.failures).toContain("the app's function threw: the model declined (cyber)");
  });
  it("prints the measured facts: stop_reason, output against cap, model, cost", () => {
    const v = judgeOneSearch(obs([exchange({ searches: 1, output_tokens: 42 })]), 4);
    const text = formatVerdict(v);
    expect(text).toMatch(/^5\. PASS {2}web search/);
    expect(text).toContain("stop_reason end_turn");
    expect(text).toContain("output 42/1000 tokens");
    expect(text).toContain("model claude-haiku-5-5");
    expect(text).toContain("logged €0.00010 over 1 call(s)");
  });
});

describe("1. classify + support intent", () => {
  const two = () => obs([exchange({}), exchange({ output_tokens: 30 })]);
  it("passes on end_turn, complete JSON, inside 1,000", () => {
    expect(judgeJsonWithinCap(two(), [true, true]).pass).toBe(true);
  });
  it("fails on max_tokens, a bigger cap, or JSON the app could not read", () => {
    expect(
      judgeJsonWithinCap(obs([exchange({ stop_reason: "max_tokens" }), exchange({})]), [true, true])
        .pass,
    ).toBe(false);
    expect(
      judgeJsonWithinCap(obs([exchange({ max_tokens: 2_000 }), exchange({})]), [true, true]).pass,
    ).toBe(false);
    expect(judgeJsonWithinCap(two(), [true, false]).pass).toBe(false);
    expect(judgeJsonWithinCap(obs([exchange({})]), [true]).pass).toBe(false); // one call, not two
  });
});

describe("2. change intent twice", () => {
  it("passes when the second call reads from cache", () => {
    const v = judgeCacheRead(
      obs([exchange({ cache_creation: 780 }), exchange({ cache_read: 780 })]),
    );
    expect(v.pass).toBe(true);
    expect(v.facts).toContain("call 2 cache_read_input_tokens 780");
  });
  it("fails when it reads nothing", () => {
    expect(judgeCacheRead(obs([exchange({}), exchange({})])).pass).toBe(false);
  });
});

describe("3. parser prompt token count", () => {
  it("passes below 512, fails at or above it or on an error", () => {
    expect(judgeParserTokenCount(431, null).pass).toBe(true);
    expect(judgeParserTokenCount(512, null).pass).toBe(false);
    expect(judgeParserTokenCount(null, "401 invalid x-api-key").pass).toBe(false);
    expect(judgeParserTokenCount(null, null).pass).toBe(false);
  });
});

describe("4. discovery", () => {
  const ok = { ok: true, candidates: 3, detail: null };
  it("passes on 1–3 searches, readable JSON, under 4,000 output", () => {
    const v = judgeDiscovery(
      obs([exchange({ searches: 2, max_tokens: 4_000, output_tokens: 1_900 })]),
      ok,
    );
    expect(v.pass).toBe(true);
    expect(v.facts).toContain("searches 2 (cap 3)");
  });
  it("fails on no search, too many, 4,000 output, or unreadable JSON", () => {
    const d = (o: Parameters<typeof exchange>[0]) =>
      obs([exchange({ max_tokens: 4_000, searches: 1, ...o })]);
    expect(judgeDiscovery(d({ searches: 0 }), ok).pass).toBe(false);
    expect(judgeDiscovery(d({ searches: 4 }), ok).pass).toBe(false);
    expect(judgeDiscovery(d({ output_tokens: 4_000 }), ok).pass).toBe(false);
    expect(judgeDiscovery(d({}), { ok: false, candidates: 0, detail: "no JSON" }).pass).toBe(false);
  });
});

describe("5. one web search", () => {
  it("passes on exactly one, fails on zero or two", () => {
    expect(judgeOneSearch(obs([exchange({ searches: 1 })]), 5).pass).toBe(true);
    expect(judgeOneSearch(obs([exchange({ searches: 0 })]), 0).pass).toBe(false);
    expect(judgeOneSearch(obs([exchange({ searches: 2 })]), 5).pass).toBe(false);
  });
});

describe("6. FAQ and prices finish inside their caps", () => {
  const read = [
    { label: "clusters", ok: true, count: 10 },
    { label: "offers", ok: true, count: 48 },
  ];
  it("passes when both end at end_turn and both answers read", () => {
    const v = judgeRoomToFinish(
      obs([exchange({ max_tokens: 6_000 }), exchange({ max_tokens: 3_000 })]),
      read,
    );
    expect(v.pass).toBe(true);
    expect(v.facts).toContain("offers 48");
  });
  it("fails when either hits max_tokens or does not read", () => {
    const cut = obs([exchange({ stop_reason: "max_tokens", max_tokens: 6_000 }), exchange({})]);
    expect(judgeRoomToFinish(cut, read).failures.join()).toMatch(/hit max_tokens \(6000\)/);
    expect(
      judgeRoomToFinish(obs([exchange({}), exchange({})]), [
        read[0]!,
        { label: "offers", ok: false, count: 0 },
      ]).pass,
    ).toBe(false);
  });
});

describe("7. hard limits", () => {
  const expected = ["no_discounts", "no_paid_ads", "no_cold_outreach", "other"];
  it("passes on the same set of codes, in any order, duplicates folded", () => {
    const got = ["other", "no_cold_outreach", "no_discounts", "no_discounts", "no_paid_ads"];
    expect(judgeLimits(obs([exchange({ max_tokens: 3_000 })]), got, expected).pass).toBe(true);
  });
  it("fails on a missing or an extra code", () => {
    const e = obs([exchange({})]);
    expect(judgeLimits(e, ["no_discounts", "no_paid_ads", "other"], expected).pass).toBe(false);
    expect(judgeLimits(e, [...expected, "no_new_platforms"], expected).pass).toBe(false);
  });
});

describe("8. the parser's sentence", () => {
  const want = { amount_minor: 450_000_000, currency: "HUF", hedge: "about" };
  const good = {
    money: { amount_minor: 450_000_000, currency: "HUF" },
    is_estimate: true,
    wording: "about",
    db_models: ["claude-haiku-5-5"],
    db_error: null,
  };
  it("passes on Money(450 000 000 fillér, HUF), the hedge kept, llm_calls naming Haiku 5.5", () => {
    const v = judgeParser(obs([exchange({ max_tokens: 2_000 })]), good, want);
    expect(v.pass).toBe(true);
    expect(v.facts).toContain("Money(450000000, HUF)");
  });
  it("fails on a wrong amount, a lost hedge, or llm_calls naming another model", () => {
    const e = obs([exchange({})]);
    expect(
      judgeParser(e, { ...good, money: { amount_minor: 4_500_000, currency: "HUF" } }, want).pass,
    ).toBe(false);
    expect(judgeParser(e, { ...good, is_estimate: false }, want).pass).toBe(false);
    expect(judgeParser(e, { ...good, wording: "roughly" }, want).pass).toBe(false);
    expect(judgeParser(e, { ...good, db_models: ["claude-haiku-4-5"] }, want).pass).toBe(false);
    expect(judgeParser(e, { ...good, db_models: [] }, want).pass).toBe(false);
    expect(judgeParser(e, { ...good, db_error: "ECONNREFUSED" }, want).pass).toBe(false);
  });
});

describe("the cost ceiling printed before anything is spent", () => {
  it("is pennies, and grows with the plan", () => {
    const ceiling = costCeilingEur();
    expect(ceiling).toBeGreaterThan(0.01);
    expect(ceiling).toBeLessThan(0.1);
    expect(costCeilingEur([...PLANNED_CALLS, PLANNED_CALLS[0]!])).toBeGreaterThan(ceiling);
  });
  it("counts the searches: four of them are $0.04 on their own", () => {
    const searchesOnly = PLANNED_CALLS.map((c) => ({ ...c, input_tokens: 0, max_tokens: 0 }));
    expect(costCeilingEur(searchesOnly)).toBeCloseTo(0.04 * 0.92, 9);
  });
  it("summarize counts passes and failures", () => {
    const pass = judgeParserTokenCount(10, null);
    const fail = judgeParserTokenCount(900, null);
    expect(summarize([pass, fail, pass])).toEqual({ passed: 2, failed: 1 });
  });
});
