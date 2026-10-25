// M-1: the Haiku 5.5 move (PR #34) against the real API — the judging half.
//
// scripts/verify-models.ts runs the eight checks the PR listed, each
// through the app's own live LLM function with a real client, and records
// what came back: every API response the call made (via a tape on the
// client), and every llm_call line the app itself logged. This file turns
// those observations into numbered PASS/FAIL lines. It is pure, so the
// judging is unit-tested on recorded fake responses — no key needed.
//
// Every check also asserts the two things the move is about: the response
// names claude-haiku-5-5, and the cost line the app logged names it too.

import { costEur, webSearchCostEur } from "./pricing";

export const VERIFY_MODEL = "claude-haiku-5-5";

export interface ObservedResponse {
  model: string;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    server_tool_use?: { web_search_requests?: number | null } | null;
  };
}

/** One API call as the tape saw it: the cap it was sent with and the response. */
export interface Exchange {
  max_tokens: number;
  response: ObservedResponse;
}

/** One llm_call line the app logged (lib/llm/cost-log.ts). */
export interface LoggedCall {
  model: string;
  workload: string;
  cost_eur: number;
}

export interface Observation {
  exchanges: readonly Exchange[];
  logged: readonly LoggedCall[];
  /** What the app's own function threw, if it threw. */
  error: string | null;
}

export interface Verdict {
  n: number;
  title: string;
  pass: boolean;
  /** The measured facts, printed whether it passed or not. */
  facts: string[];
  failures: string[];
}

const searches = (e: Exchange): number =>
  e.response.usage.server_tool_use?.web_search_requests ?? 0;
const eur = (v: number): string => `€${v.toFixed(5)}`;

/** What every check asserts: no throw, the expected call count, Haiku 5.5 named and logged. */
function common(obs: Observation, expectedCalls: number): { facts: string[]; failures: string[] } {
  const facts: string[] = [];
  const failures: string[] = [];
  if (obs.error !== null) failures.push(`the app's function threw: ${obs.error}`);
  if (obs.exchanges.length !== expectedCalls) {
    failures.push(`expected ${expectedCalls} API call(s), saw ${obs.exchanges.length}`);
  }
  if (obs.exchanges.length > 0) {
    facts.push(`stop_reason ${obs.exchanges.map((e) => e.response.stop_reason).join(", ")}`);
    facts.push(
      `output ${obs.exchanges.map((e) => `${e.response.usage.output_tokens}/${e.max_tokens}`).join(", ")} tokens`,
    );
    const models = [...new Set(obs.exchanges.map((e) => e.response.model))];
    facts.push(`model ${models.join(", ")}`);
    for (const m of models) {
      if (m !== VERIFY_MODEL) failures.push(`the response names ${m}, not ${VERIFY_MODEL}`);
    }
  }
  const total = obs.logged.reduce((s, c) => s + c.cost_eur, 0);
  facts.push(`logged ${eur(total)} over ${obs.logged.length} call(s)`);
  if (obs.logged.length !== obs.exchanges.length) {
    failures.push(
      `${obs.exchanges.length} API call(s) but ${obs.logged.length} cost line(s) logged`,
    );
  }
  for (const c of obs.logged) {
    if (c.model !== VERIFY_MODEL) failures.push(`the cost line names ${c.model}`);
  }
  return { facts, failures };
}

function verdict(n: number, title: string, facts: string[], failures: string[]): Verdict {
  return { n, title, pass: failures.length === 0, facts, failures };
}

function endTurn(obs: Observation, failures: string[]): void {
  for (const [i, e] of obs.exchanges.entries()) {
    if (e.response.stop_reason !== "end_turn") {
      failures.push(`call ${i + 1} stopped at "${e.response.stop_reason}", not end_turn`);
    }
  }
}

/** 1. classify and support intent end at end_turn with complete JSON within 1,000 tokens. */
export function judgeJsonWithinCap(obs: Observation, completeJson: readonly boolean[]): Verdict {
  const { facts, failures } = common(obs, 2);
  endTurn(obs, failures);
  for (const [i, e] of obs.exchanges.entries()) {
    if (e.max_tokens > 1_000) failures.push(`call ${i + 1} was sent max_tokens ${e.max_tokens}`);
    if (e.response.usage.output_tokens > 1_000) {
      failures.push(`call ${i + 1} used ${e.response.usage.output_tokens} output tokens`);
    }
  }
  facts.push(`complete JSON ${completeJson.map((ok) => (ok ? "yes" : "no")).join(", ")}`);
  if (completeJson.length !== 2 || completeJson.some((ok) => !ok)) {
    failures.push("an answer was not complete JSON the app could read");
  }
  return verdict(
    1,
    "classify + support intent: end_turn, complete JSON, ≤1,000 tokens",
    facts,
    failures,
  );
}

/** 2. change-intent twice within 5 minutes: the second reads the prompt from cache. */
export function judgeCacheRead(obs: Observation): Verdict {
  const { facts, failures } = common(obs, 2);
  const [first, second] = obs.exchanges;
  if (first)
    facts.push(`call 1 cache write ${first.response.usage.cache_creation_input_tokens ?? 0}`);
  const read = second?.response.usage.cache_read_input_tokens ?? 0;
  facts.push(`call 2 cache_read_input_tokens ${read}`);
  if (second && read <= 0) failures.push("the repeated change-intent call read nothing from cache");
  return verdict(2, "change intent twice: cache_read_input_tokens > 0", facts, failures);
}

/** 3. count_tokens on the parser prompt: below Haiku 5.5's 512-token cache minimum. */
export function judgeParserTokenCount(count: number | null, error: string | null): Verdict {
  const facts: string[] = [];
  const failures: string[] = [];
  if (error !== null) failures.push(`count_tokens failed: ${error}`);
  if (count !== null) {
    facts.push(`count_tokens ${count} (minimum cacheable prompt 512)`);
    if (count >= 512) {
      failures.push(
        `the parser prompt is ${count} tokens — it now clears 512 and should be cached`,
      );
    }
  } else if (error === null) {
    failures.push("no count came back");
  }
  facts.push("count_tokens is free: no cost line");
  return verdict(3, "parser prompt below 512 tokens (count_tokens)", facts, failures);
}

/** 4. discovery at medium: 1–3 searches, JSON after joining text blocks, under 4,000 output. */
export function judgeDiscovery(
  obs: Observation,
  parsed: { ok: boolean; candidates: number; detail: string | null },
): Verdict {
  const { facts, failures } = common(obs, 1);
  endTurn(obs, failures);
  const e = obs.exchanges[0];
  if (e) {
    facts.push(`searches ${searches(e)} (cap 3)`);
    if (searches(e) < 1) failures.push("discovery ran no search");
    if (searches(e) > 3) failures.push(`discovery ran ${searches(e)} searches, over its cap of 3`);
    if (e.response.usage.output_tokens >= 4_000) {
      failures.push(`output ${e.response.usage.output_tokens} is not under 4,000`);
    }
  }
  facts.push(`JSON ${parsed.ok ? "read" : "unreadable"}, ${parsed.candidates} candidate(s)`);
  if (!parsed.ok)
    failures.push(`the joined text was not the JSON asked for: ${parsed.detail ?? ""}`);
  return verdict(4, "discovery: searches, JSON across text blocks, <4,000 output", facts, failures);
}

/** 5. the web search provider runs exactly one search. */
export function judgeOneSearch(obs: Observation, hits: number): Verdict {
  const { facts, failures } = common(obs, 1);
  const e = obs.exchanges[0];
  if (e) {
    facts.push(`searches ${searches(e)}, ${hits} hit(s)`);
    if (searches(e) !== 1) failures.push(`ran ${searches(e)} searches, not exactly one`);
  }
  return verdict(5, "web search: exactly one search", facts, failures);
}

/** 6. FAQ over ~200 questions and prices over 6 pages finish inside their caps. */
export function judgeRoomToFinish(
  obs: Observation,
  read: readonly { label: string; ok: boolean; count: number }[],
): Verdict {
  const { facts, failures } = common(obs, 2);
  endTurn(obs, failures);
  for (const [i, e] of obs.exchanges.entries()) {
    if (e.response.stop_reason === "max_tokens") {
      failures.push(`call ${i + 1} hit max_tokens (${e.max_tokens})`);
    }
  }
  for (const r of read) {
    facts.push(`${r.label} ${r.count}`);
    if (!r.ok) failures.push(`${r.label}: the app could not read the answer`);
  }
  return verdict(6, "FAQ (~200 questions) + prices (6 pages): no max_tokens", facts, failures);
}

/** 7. hard limits on a 13.5 answer map to the expected codes (the set Haiku 4.5's reading gives). */
export function judgeLimits(
  obs: Observation,
  got: readonly string[],
  expected: readonly string[],
): Verdict {
  const { facts, failures } = common(obs, 1);
  endTurn(obs, failures);
  const a = [...new Set(got)].sort();
  const b = [...new Set(expected)].sort();
  facts.push(`codes ${a.join(", ") || "(none)"} · expected ${b.join(", ")}`);
  if (a.join() !== b.join()) failures.push("the extracted codes do not match the expected set");
  return verdict(7, "hard limits: codes match", facts, failures);
}

export interface ParserReading {
  /** The extracted revenue.monthly_revenue after the app's own coercion, or why it failed. */
  money: { amount_minor: number; currency: string } | null;
  is_estimate: boolean | null;
  wording: string | null;
  /** The llm_calls rows this run wrote for the parser workload, newest first. */
  db_models: readonly string[];
  db_error: string | null;
}

/** 8. verify:parser's sentence: the 4.5 extraction, and llm_calls naming claude-haiku-5-5. */
export function judgeParser(
  obs: Observation,
  reading: ParserReading,
  expected: { amount_minor: number; currency: string; hedge: string },
): Verdict {
  const { facts, failures } = common(obs, 1);
  endTurn(obs, failures);
  const m = reading.money;
  facts.push(m ? `Money(${m.amount_minor}, ${m.currency})` : "no money value");
  facts.push(`estimate ${String(reading.is_estimate)} "${reading.wording ?? ""}"`);
  if (!m || m.amount_minor !== expected.amount_minor || m.currency !== expected.currency) {
    failures.push(`expected Money(${expected.amount_minor}, ${expected.currency})`);
  }
  if (reading.is_estimate !== true) failures.push("the hedge was not marked an estimate");
  if (!(reading.wording ?? "").toLowerCase().includes(expected.hedge)) {
    failures.push(`the owner's wording "${expected.hedge}" was not kept`);
  }
  if (reading.db_error !== null) {
    failures.push(`llm_calls could not be read: ${reading.db_error}`);
  } else {
    facts.push(`llm_calls ${reading.db_models.join(", ") || "(no row)"}`);
    if (reading.db_models.length === 0) failures.push("no llm_calls row was written");
    else if (reading.db_models[0] !== VERIFY_MODEL) {
      failures.push(`llm_calls names ${reading.db_models[0]}, not ${VERIFY_MODEL}`);
    }
  }
  return verdict(8, "parser: 4.5's extraction, llm_calls names claude-haiku-5-5", facts, failures);
}

export function formatVerdict(v: Verdict): string {
  const head = `${v.n}. ${v.pass ? "PASS" : "FAIL"}  ${v.title}`;
  const facts = `     ${v.facts.join(" · ")}`;
  const why = v.failures.map((f) => `     ✗ ${f}`);
  return [head, facts, ...why].join("\n");
}

export function summarize(verdicts: readonly Verdict[]): { passed: number; failed: number } {
  const passed = verdicts.filter((v) => v.pass).length;
  return { passed, failed: verdicts.length - passed };
}

/* ── the cost ceiling, printed before anything is spent ── */

export interface PlannedCall {
  label: string;
  /** A generous estimate of the prompt, search results included. */
  input_tokens: number;
  /** The call's own max_tokens: the most it can bill for output. */
  max_tokens: number;
  searches: number;
}

/** The eight checks' calls, at their real caps (count_tokens is free). */
export const PLANNED_CALLS: readonly PlannedCall[] = [
  { label: "classify", input_tokens: 600, max_tokens: 1_000, searches: 0 },
  { label: "support intent", input_tokens: 400, max_tokens: 1_000, searches: 0 },
  { label: "change intent ×2", input_tokens: 2 * 1_500, max_tokens: 2 * 1_000, searches: 0 },
  { label: "discovery", input_tokens: 60_000, max_tokens: 4_000, searches: 3 },
  { label: "web search", input_tokens: 20_000, max_tokens: 1_000, searches: 1 },
  { label: "FAQ, 200 questions", input_tokens: 8_000, max_tokens: 6_000, searches: 0 },
  { label: "prices, 6 pages", input_tokens: 9_000, max_tokens: 3_000, searches: 0 },
  { label: "hard limits", input_tokens: 800, max_tokens: 3_000, searches: 0 },
  { label: "parser", input_tokens: 1_000, max_tokens: 2_000, searches: 0 },
];

/** Worst case: every call uses its whole output cap, priced as if uncached. */
export function costCeilingEur(calls: readonly PlannedCall[] = PLANNED_CALLS): number {
  return calls.reduce(
    (sum, c) =>
      sum +
      costEur(VERIFY_MODEL, {
        input_tokens: c.input_tokens,
        output_tokens: c.max_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }) +
      webSearchCostEur(c.searches),
    0,
  );
}
