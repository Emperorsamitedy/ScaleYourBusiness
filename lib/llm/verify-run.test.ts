// M-1: the whole verify:models run against a fake client — the wiring the
// owner will rely on the first time a key exists. The app's own live
// functions run unchanged (the fake stands where the SDK client stands),
// their real cost lines are captured, and check 8 reads the llm_calls
// rows they wrote to this test database.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  model: "claude-haiku-5-5",
  changeCalls: 0,
  sent: [] as Record<string, unknown>[],
  countTokens: 431,
}));

vi.mock("./client", () => {
  const usage = (over: Record<string, number> = {}) => ({
    input_tokens: 700,
    output_tokens: 120,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
    server_tool_use: { web_search_requests: over.searches ?? 0 },
  });
  const reply = (text: string, u = usage(), extra: unknown[] = []) => ({
    model: fake.model,
    stop_reason: "end_turn",
    stop_details: null,
    content: [{ type: "thinking", thinking: "", signature: "s" }, ...extra, { type: "text", text }],
    usage: u,
  });
  const client = {
    messages: {
      countTokens: async () => ({ input_tokens: fake.countTokens }),
      create: async (params: Record<string, unknown>) => {
        fake.sent.push(params);
        const system = params.system;
        const sys =
          typeof system === "string" ? system : ((system as { text: string }[])[0]?.text ?? "");
        const user = (params.messages as { content: string }[])[0]?.content ?? "";
        if (sys.includes("classify a business recommendation")) {
          return reply('{"kind":"price_increase"}');
        }
        if (sys.includes("classify one message a CUSTOMER")) return reply('{"intent":"question"}');
        if (sys.includes("one message from a small business owner")) {
          fake.changeCalls++;
          return reply(
            '{"intent":"request","change":{"kind":"reply_time"}}',
            usage(
              fake.changeCalls === 1
                ? { cache_creation_input_tokens: 780 }
                : { cache_read_input_tokens: 780 },
            ),
          );
        }
        if (sys.includes("find direct competitors")) {
          return reply(
            '{"candidates":[{"name":"Rival Bakery","url":"https://rival-bakery.example/","evidence":"Sells sourdough in Szeged."}]}',
            usage({ searches: 2, output_tokens: 1_400 }),
          );
        }
        if (sys.includes("Run exactly one web search")) {
          return reply("done", usage({ searches: 1 }), [
            {
              type: "web_search_tool_result",
              tool_use_id: "t",
              content: [
                {
                  type: "web_search_result",
                  url: "https://a.example/",
                  title: "A",
                  page_age: null,
                },
              ],
            },
          ]);
        }
        if (sys.includes("group customer questions")) {
          const ids = [...user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);
          return reply(
            JSON.stringify({
              clusters: [{ question: "Do you deliver?", members: ids.slice(0, 20) }],
            }),
            usage({ output_tokens: 900 }),
          );
        }
        if (sys.includes("read a price list")) {
          return reply(
            JSON.stringify({
              pages: [
                {
                  page: 1,
                  offers: [
                    { name: "Sourdough loaf 1", price: "300", currency: "HUF", from: false },
                  ],
                },
              ],
            }),
          );
        }
        if (sys.includes("extract hard limits")) {
          return reply(
            JSON.stringify({
              limits: [
                { code: "no_discounts", quote: "We never discount" },
                { code: "no_paid_ads", quote: "I won't pay for advertising" },
                { code: "no_cold_outreach", quote: "Never send cold emails" },
                { code: "other", quote: "no plastic packaging" },
              ],
            }),
          );
        }
        if (sys.includes("extract structured answers")) {
          return reply(
            JSON.stringify({
              fields: [
                {
                  field_key: "revenue.monthly_revenue",
                  value: { amount_major: 4_500_000 },
                  is_estimate: true,
                  estimate_wording: "about",
                },
              ],
            }),
          );
        }
        throw new Error(`the fake has no reply for: ${sys.slice(0, 60)}`);
      },
    },
  };
  return { anthropicClient: () => client };
});

const { db } = await import("../../db");
const { llmCalls } = await import("../../db/schema");
const { runVerifyModels } = await import("./verify-run");
const { summarize } = await import("./verify-models");
const { anthropicClient } = await import("./client");

const accounts: string[] = [];
async function run() {
  const accountId = randomUUID();
  accounts.push(accountId);
  const lines: string[] = [];
  const out = await runVerifyModels({ accountId, print: (l) => lines.push(l) });
  return { ...out, lines, accountId };
}

beforeEach(() => {
  fake.model = "claude-haiku-5-5";
  fake.changeCalls = 0;
  fake.countTokens = 431;
  fake.sent.length = 0;
});

afterAll(async () => {
  for (const id of accounts) await db.delete(llmCalls).where(eq(llmCalls.account_id, id));
});

describe("npm run verify:models, end to end on a fake client", () => {
  it("runs all eight checks through the app's own functions and passes them", async () => {
    const { verdicts, lines, spent_eur, accountId } = await run();
    expect(verdicts.map((v) => v.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(verdicts.filter((v) => !v.pass).map((v) => [v.n, v.failures])).toEqual([]);
    expect(summarize(verdicts)).toEqual({ passed: 8, failed: 0 });
    // Ten model calls, each logged by the app and each written to llm_calls.
    expect(fake.sent).toHaveLength(10);
    expect(spent_eur).toBeGreaterThan(0);
    const rows = await db.select().from(llmCalls).where(eq(llmCalls.account_id, accountId));
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => r.model))).toEqual(new Set(["claude-haiku-5-5"]));
    // Numbered lines with the facts.
    expect(lines.some((l) => l.startsWith("2. PASS"))).toBe(true);
    expect(lines.join("\n")).toContain("call 2 cache_read_input_tokens 780");
    expect(lines.join("\n")).toContain("count_tokens 431");
  });

  it("sends the app's real requests: Haiku 5.5, explicit effort, no sampling", async () => {
    await run();
    for (const params of fake.sent) {
      expect(params.model).toBe("claude-haiku-5-5");
      expect((params.output_config as { effort?: string }).effort).toMatch(/^(low|medium)$/);
      for (const banned of ["temperature", "top_p", "top_k", "thinking"]) {
        expect(params).not.toHaveProperty(banned);
      }
    }
  });

  it("fails every check when the API answers as another model", async () => {
    fake.model = "claude-haiku-4-5";
    const { verdicts } = await run();
    // Check 3 is a token count: no response model to judge.
    expect(verdicts.filter((v) => v.pass).map((v) => v.n)).toEqual([3]);
  });

  it("fails check 3 when the parser prompt clears the 512-token minimum", async () => {
    fake.countTokens = 600;
    const { verdicts } = await run();
    expect(verdicts.find((v) => v.n === 3)?.pass).toBe(false);
  });

  it("puts console.log and the client back afterwards", async () => {
    const log = console.log;
    const create = anthropicClient().messages.create;
    await run();
    expect(console.log).toBe(log);
    expect(anthropicClient().messages.create).toBe(create);
  });
});
