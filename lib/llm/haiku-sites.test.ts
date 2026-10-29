// The Haiku 5.5 move (2026-10-24), proven at every live call site with a
// fake client: each sends claude-haiku-5-5 with an explicit effort, room
// for thinking and no sampling parameters; each reads its answer from
// behind leading thinking blocks; and each sends a refusal down its own
// failure path instead of parsing it. The Sonnet sites read by type too.

import "dotenv/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CostLog from "./cost-log";

const fake = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  replies: [] as unknown[],
}));
vi.mock("./client", () => ({
  anthropicClient: () => ({
    messages: {
      create: async (params: Record<string, unknown>) => {
        fake.sent.push(params);
        const next = fake.replies.shift();
        if (!next) throw new Error("no fake reply queued");
        return next;
      },
    },
  }),
}));
// Metering is proven elsewhere (research/metering); here it must not need a database.
vi.mock("./cost-log", async (importOriginal) => ({
  ...(await importOriginal<typeof CostLog>()),
  recordLlmCall: async () => undefined,
}));

import { coerceChangeIntent, liveChangeIntentLlm } from "../assistant/intent";
import { liveGroupLlm } from "../blindspots/finder";
import { liveAnswerLlm } from "../chat/service";
import { livePriceLlm, newRunBudget, readWithModel } from "../competitors/model";
import { liveDraftLlm as liveContentDraftLlm } from "../content/draft";
import { FaqError, liveFaqLlm } from "../crm/faq";
import { coerceSchedule, liveScheduleLlm } from "../hours/schedule";
import { ParserError, liveExtractionLlm } from "../parser/parse";
import { coerceKind, liveClassifyLlm } from "../proposals/generate";
import { coerceLimits, liveLimitLlm } from "../proposals/hard-limits";
import { ResearchError, liveResearchLlm } from "../research/competitor";
import { coerceFallback, liveReviewParseLlm } from "../reviews/fallback";
import { originalMail } from "../reviews/parse";
import { liveDiscoveryLlm } from "../research/discovery";
import { liveSearchProvider } from "../research/live";
import { liveDraftLlm as liveReplyDraftLlm } from "../support-desk/draft";
import { coerceSupportIntent, liveSupportAnswerLlm, liveSupportIntentLlm } from "../support/chat";
import { ModelRefusalError } from "./answer";

const usage = {
  input_tokens: 800,
  output_tokens: 120,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
};
const thinking = { type: "thinking", thinking: "", signature: "sig" };

/** A response that opens with thinking, as Haiku 5.5's can. */
const thinksThen = (...content: unknown[]) => ({
  content: [thinking, ...content],
  stop_reason: "end_turn",
  stop_details: null,
  usage,
});
const text = (t: string) => ({ type: "text", text: t });
/** A decline: HTTP 200, stop_reason "refusal" — with text that must NOT be read. */
const refusal = (bait: string) => ({
  content: [text(bait)],
  stop_reason: "refusal",
  stop_details: { type: "refusal", category: "general_harms", explanation: null },
  usage,
});

const args = { system: "s", user: "u", accountId: "acct-haiku" };

function lastSent(): Record<string, unknown> {
  const params = fake.sent.at(-1);
  if (!params) throw new Error("nothing was sent");
  return params;
}

function expectHaiku(effort: "low" | "medium"): void {
  const params = lastSent();
  expect(params.model).toBe("claude-haiku-5-5");
  expect((params.output_config as { effort?: string }).effort).toBe(effort);
  expect(params.max_tokens as number).toBeGreaterThanOrEqual(1_000);
  for (const banned of ["temperature", "top_p", "top_k", "thinking", "fallbacks"]) {
    expect(params).not.toHaveProperty(banned);
  }
  const messages = params.messages as { role: string }[];
  expect(messages.at(-1)?.role).toBe("user"); // no assistant prefill
}

beforeEach(() => {
  fake.sent.length = 0;
  fake.replies.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("owner chat intent (feature 33): low effort; a refusal is the harmless 'ask'", () => {
  const json = '{"intent":"request","change":{"kind":"reply_time","reply_hours":4}}';

  it("reads the JSON behind thinking, and keeps its cache breakpoint", async () => {
    fake.replies.push(thinksThen(text(json)));
    const got = await liveChangeIntentLlm(args);
    expect(got.text).toBe(json);
    expectHaiku("low");
    expect(lastSent().system).toEqual([
      { type: "text", text: "s", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("gives no text on a refusal, which coerces to a question with no change", async () => {
    fake.replies.push(refusal(json));
    const got = await liveChangeIntentLlm(args);
    expect(got.text).toBe("");
    expect(coerceChangeIntent(got.text)).toEqual({ intent: "ask", change: null });
    expect(got.calls).toHaveLength(1); // still metered
  });
});

describe("demand topics grouping: low effort; a refusal throws rather than write empty topics", () => {
  it("reads behind thinking", async () => {
    fake.replies.push(thinksThen(text('{"topics":[]}')));
    expect((await liveGroupLlm(args)).text).toBe('{"topics":[]}');
    expectHaiku("low");
  });
  it("throws on a refusal", async () => {
    fake.replies.push(refusal('{"topics":[{"label":"x","members":[0]}]}'));
    await expect(liveGroupLlm(args)).rejects.toBeInstanceOf(ModelRefusalError);
  });
});

describe("competitor prices: low effort; a refusal skips the pages with why", () => {
  it("reads behind thinking", async () => {
    fake.replies.push(thinksThen(text('{"pages":[]}')));
    expect((await livePriceLlm(args)).text).toBe('{"pages":[]}');
    expectHaiku("low");
  });
  it("skips every page in the batch, and reads no offer from the refusal", async () => {
    fake.replies.push(
      refusal('{"pages":[{"page":0,"offers":[{"name":"Tea","price":"5","currency":"EUR"}]}]}'),
    );
    const read = await readWithModel({
      pages: [{ url: "https://shop.example/prices", text: "Tea 5 EUR", currencies: ["EUR"] }],
      accountId: "00000000-0000-4000-8000-000000000001",
      budget: newRunBudget(),
      llm: livePriceLlm,
      now: new Date("2026-10-24T10:00:00Z"),
      usage: async () => ({ account_calls: 0, total_eur: 0 }),
    });
    expect(read.byUrl.size).toBe(0);
    expect(read.skipped).toEqual([
      { url: "https://shop.example/prices", reason: expect.stringMatching(/declined/) as string },
    ]);
  });
});

describe("FAQ clustering: low effort; a refusal fails the run, said plainly", () => {
  it("reads behind thinking", async () => {
    fake.replies.push(thinksThen(text('{"clusters":[]}')));
    expect((await liveFaqLlm(args)).text).toBe('{"clusters":[]}');
    expectHaiku("low");
  });
  it("throws a FaqError on a refusal", async () => {
    fake.replies.push(refusal('{"clusters":[]}'));
    await expect(liveFaqLlm(args)).rejects.toBeInstanceOf(FaqError);
  });
});

describe("opening hours: low effort; a refusal throws, so no schedule is written", () => {
  const json =
    '{"days":[{"day":"mon","closed":false,"periods":[{"open":"09:00","close":"17:00"}],"quote":"Mon 9-5"}],"unparsed":[]}';
  it("reads behind thinking", async () => {
    fake.replies.push(thinksThen(text(json)));
    const got = await liveScheduleLlm(args);
    expect(coerceSchedule(got.text).days.mon).toEqual([{ open: "09:00", close: "17:00" }]);
    expectHaiku("low");
  });
  it("throws on a refusal", async () => {
    fake.replies.push(refusal(json));
    await expect(liveScheduleLlm(args)).rejects.toBeInstanceOf(ModelRefusalError);
  });
});

describe("answer parser: low effort; a refusal is a ParserError", () => {
  it("reads behind thinking", async () => {
    fake.replies.push(thinksThen(text('{"fields":[]}')));
    expect((await liveExtractionLlm(args)).text).toBe('{"fields":[]}');
    expectHaiku("low");
  });
  it("throws a ParserError naming the refusal", async () => {
    fake.replies.push(refusal('{"fields":[{"field_key":"x","value":1}]}'));
    await expect(liveExtractionLlm(args)).rejects.toThrow(ParserError);
    fake.replies.push(refusal("{}"));
    await expect(liveExtractionLlm(args)).rejects.toThrow(/declined/);
  });
});

describe("proposal classification: low effort; a refusal is unclassifiable, skipped", () => {
  it("reads behind thinking, with room for it (max_tokens was 100)", async () => {
    fake.replies.push(thinksThen(text('{"kind":"price_increase"}')));
    expect(coerceKind((await liveClassifyLlm(args)).text)).toBe("price_increase");
    expectHaiku("low");
  });
  it("gives no text on a refusal: coerceKind says null, never a guessed kind", async () => {
    fake.replies.push(refusal('{"kind":"price_increase"}'));
    const got = await liveClassifyLlm(args);
    expect(got.text).toBe("");
    expect(coerceKind(got.text)).toBeNull();
  });
});

describe("hard limits: MEDIUM effort (rule 14's one judgement); a refusal throws", () => {
  it("reads behind thinking", async () => {
    fake.replies.push(thinksThen(text('{"limits":[{"code":"other","quote":"never lie"}]}')));
    const got = await liveLimitLlm(args);
    expect(coerceLimits(got.text)).toEqual([
      { code: "other", quote: "never lie", enforcement: "manual" },
    ]);
    expectHaiku("medium");
  });
  it("throws on a refusal, so no empty limits fact unblocks anything", async () => {
    fake.replies.push(refusal('{"limits":[]}'));
    await expect(liveLimitLlm(args)).rejects.toBeInstanceOf(ModelRefusalError);
  });
});

describe("competitor research extraction: low effort; a refusal is a ResearchError", () => {
  it("reads behind thinking", async () => {
    fake.replies.push(thinksThen(text('{"fields":{}}')));
    expect((await liveResearchLlm(args)).text).toBe('{"fields":{}}');
    expectHaiku("low");
  });
  it("throws on a refusal", async () => {
    fake.replies.push(refusal('{"fields":{"name":"x"}}'));
    await expect(liveResearchLlm(args)).rejects.toThrow(ResearchError);
  });
});

describe("competitor discovery: MEDIUM effort with web search; a refusal is a ResearchError", () => {
  it("reads the text behind thinking and search blocks, and gives the date", async () => {
    fake.replies.push(
      thinksThen(
        { type: "server_tool_use", id: "t", name: "web_search", input: { query: "q" } },
        { type: "web_search_tool_result", tool_use_id: "t", content: [] },
        thinking,
        text('{"candidates":[]}'),
      ),
    );
    expect((await liveDiscoveryLlm(args)).text).toBe('{"candidates":[]}');
    expectHaiku("medium");
    expect(lastSent().system).toMatch(/The current date is \d{4}-\d{2}-\d{2}\.$/);
    expect(lastSent()).not.toHaveProperty("output_config.format"); // thinking stays on with tools
  });
  it("throws on a refusal", async () => {
    fake.replies.push(refusal('{"candidates":[{"name":"x","url":"https://x.example/"}]}'));
    await expect(liveDiscoveryLlm(args)).rejects.toThrow(ResearchError);
  });
});

describe("competitor web search: low effort; a refusal yields no hits, it throws", () => {
  const hit = {
    type: "web_search_tool_result",
    tool_use_id: "t",
    content: [{ type: "web_search_result", url: "https://a.example/", title: "A", page_age: null }],
  };
  it("reads the hits behind thinking", async () => {
    fake.replies.push(thinksThen(hit, text("done")));
    const hits = await liveSearchProvider("Bodza Bár", 5, "acct-haiku");
    expect(hits.map((h) => h.url)).toEqual(["https://a.example/"]);
    expectHaiku("low");
  });
  it("throws on a refusal, even with result blocks present", async () => {
    fake.replies.push({ ...refusal("done"), content: [hit] });
    await expect(liveSearchProvider("Bodza Bár", 5, "acct-haiku")).rejects.toThrow(ResearchError);
  });
});

describe("review notification fallback (idea 45): low effort; a refusal files it unread", () => {
  const json = '{"stars":2,"reviewer":null,"text":"slow","link":null}';
  const mail = originalMail({
    from: "businessprofile-noreply@google.com",
    subject: "New review",
    text: "slow",
  })!;
  it("reads the JSON behind thinking, under the review_parse workload", async () => {
    fake.replies.push(thinksThen(text(json)));
    const got = await liveReviewParseLlm(args);
    expect(coerceFallback(got.text, mail)).toMatchObject({ stars: 2, text: "slow" });
    expectHaiku("low");
    expect(got.calls[0]?.workload).toBe("review_parse");
  });
  it("gives no text on a refusal: nothing is copied, never the declined text", async () => {
    fake.replies.push(refusal(json));
    const got = await liveReviewParseLlm(args);
    expect(got.text).toBe("");
    expect(coerceFallback(got.text, mail)).toMatchObject({ stars: null, text: null });
    expect(got.calls).toHaveLength(1); // still metered
  });
});

describe("customer support intent: low effort; a refusal hands over to a person", () => {
  it("reads behind thinking, with room for it (max_tokens was 60)", async () => {
    fake.replies.push(thinksThen(text('{"intent":"social"}')));
    expect(coerceSupportIntent((await liveSupportIntentLlm(args)).text)).toBe("social");
    expectHaiku("low");
  });
  it("throws on a refusal: postCustomerMessage's unavailable path escalates", async () => {
    fake.replies.push(refusal('{"intent":"social"}'));
    await expect(liveSupportIntentLlm(args)).rejects.toBeInstanceOf(ModelRefusalError);
  });
  it("leaves the Sonnet answer as it was: no effort sent, a refusal is just no answer", async () => {
    fake.replies.push(refusal('{"answer":"x","grounded":true,"used":[]}'));
    const got = await liveSupportAnswerLlm(args);
    expect(got.text).toBe("");
    expect(lastSent().model).toBe("claude-sonnet-5");
    expect(lastSent().output_config).not.toHaveProperty("effort");
  });
});

describe("the Sonnet sites read by type too (no model change)", () => {
  it("owner chat answer, content draft and reply draft find text behind thinking", async () => {
    fake.replies.push(thinksThen(text("answer")), thinksThen(text("post")));
    fake.replies.push(thinksThen(text('{"draft":"hi"}')));
    expect((await liveAnswerLlm(args)).text).toBe("answer");
    expect(lastSent().model).toBe("claude-sonnet-5");
    expect((await liveContentDraftLlm(args)).text).toBe("post");
    expect(lastSent().model).toBe("claude-sonnet-5");
    expect((await liveReplyDraftLlm(args)).text).toBe('{"draft":"hi"}');
    expect(lastSent().model).toBe("claude-sonnet-5");
  });
});
