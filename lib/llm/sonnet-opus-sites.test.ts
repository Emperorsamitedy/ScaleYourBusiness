// M-2 prep, proven at every Sonnet and Opus call site with a fake client:
//
//   · SONNET_MODEL / DIAGNOSIS_MODEL unset → today's models and today's
//     request bodies, byte for byte (toStrictEqual on the whole body);
//   · claude-sonnet-5-5 → no `disabled` thinking anywhere (between_tools at
//     the interviewer, at effort high or below), an explicit effort on the
//     answer sites, the interviewer's bank prefix and breakpoint unchanged;
//   · claude-opus-5-5 → an explicit effort, adaptive thinking;
//   · both → no sampling parameters, no prefill, no forced tool_choice, the
//     answer read from behind a thinking block, the cost logged under the
//     model actually used, and a refusal sent down its site's failure path.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CostLog from "./cost-log";
import type { LlmCallRecord } from "./cost-log";

const fake = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  replies: [] as unknown[],
  logged: [] as { model: string; workload: string }[],
}));
vi.mock("./client", () => ({
  anthropicClient: () => ({
    messages: {
      create: async (params: Record<string, unknown>) => {
        fake.sent.push(params);
        const next = fake.replies.shift();
        if (!next) throw new Error("no fake reply queued");
        return typeof next === "function" ? (next as (p: unknown) => unknown)(params) : next;
      },
    },
  }),
}));
// Metering is proven elsewhere; here it records which model was logged, without a database.
vi.mock("./cost-log", async (importOriginal) => ({
  ...(await importOriginal<typeof CostLog>()),
  recordLlmCall: async (record: LlmCallRecord) => {
    fake.logged.push({ model: record.model, workload: record.workload });
  },
}));

const { db } = await import("../../db");
const { accounts, businessProfiles } = await import("../../db/schema");
const { loadBank } = await import("../bank/loader");
const { liveReviewLlm } = await import("../care/review");
const { liveAnswerLlm } = await import("../chat/service");
const { draftItem, liveDraftLlm: liveContentDraftLlm } = await import("../content/draft");
const { liveBriefLlm } = await import("../content/brief");
const { DiagnosisRefusalError, diagnosisLlmFor, liveDiagnosisLlm } =
  await import("../diagnosis/findings");
const { liveRecommendationsLlm } = await import("../diagnosis/recommendations");
const { InterviewerError, interviewerRequest, pickNextQuestion } =
  await import("../interviewer/interviewer");
const { buildSystemBlocks, loadInterviewerBank } = await import("../interviewer/prompt");
const { liveDraftLlm: liveReplyDraftLlm } = await import("../support-desk/draft");
const { coerceReply, liveReviewReplyLlm } = await import("../review-desk/draft");
const { coerceAnswer, liveSupportAnswerLlm } = await import("../support/chat");
const { ModelRefusalError } = await import("./answer");

const usage = {
  input_tokens: 900,
  output_tokens: 150,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
const thinking = { type: "thinking", thinking: "", signature: "sig" };
const text = (t: string) => ({ type: "text", text: t });
/** A response that opens with thinking, as the 5.5 models' can. */
const thinksThen = (...content: unknown[]) => ({
  content: [thinking, ...content],
  stop_reason: "end_turn",
  stop_details: null,
  usage,
});
/** A decline: HTTP 200, stop_reason "refusal", with bait text that must NOT be read. */
const refusal = (bait: string) => ({
  content: [text(bait)],
  stop_reason: "refusal",
  stop_details: { type: "refusal", category: "general_harms", explanation: null },
  usage,
});

const args = { system: "s", user: "u", accountId: "acct-m2" };

function lastSent(): Record<string, unknown> {
  const params = fake.sent.at(-1);
  if (!params) throw new Error("nothing was sent");
  return params;
}

/** What every request must never carry, on either model. */
function expectClean(params: Record<string, unknown>): void {
  for (const banned of ["temperature", "top_p", "top_k", "tool_choice", "fallbacks"]) {
    expect(params).not.toHaveProperty(banned);
  }
  const messages = params.messages as { role: string }[];
  expect(messages.at(-1)?.role).toBe("user"); // no assistant prefill
  expect(JSON.stringify(params.thinking ?? null)).not.toContain('"disabled"');
}

const schemaFormat = { type: "json_schema", schema: expect.any(Object) };

beforeEach(() => {
  fake.sent.length = 0;
  fake.replies.length = 0;
  fake.logged.length = 0;
  vi.stubEnv("SONNET_MODEL", undefined);
  vi.stubEnv("DIAGNOSIS_MODEL", undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/* ── unset env: today's bodies, exactly ── */

describe("SONNET_MODEL and DIAGNOSIS_MODEL unset: exactly today's models and request bodies", () => {
  it("owner chat answer", async () => {
    fake.replies.push(thinksThen(text("a")));
    await liveAnswerLlm(args);
    expect(lastSent()).toStrictEqual({
      model: "claude-sonnet-5",
      max_tokens: 400,
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "u" }],
    });
  });

  it("content draft", async () => {
    fake.replies.push(thinksThen(text("a")));
    await liveContentDraftLlm(args);
    expect(lastSent()).toStrictEqual({
      model: "claude-sonnet-5",
      max_tokens: 900,
      system: "s",
      messages: [{ role: "user", content: "u" }],
    });
  });

  it("customer support answer", async () => {
    fake.replies.push(thinksThen(text("{}")));
    await liveSupportAnswerLlm(args);
    expect(lastSent()).toStrictEqual({
      model: "claude-sonnet-5",
      max_tokens: 400,
      system: "s",
      output_config: { format: schemaFormat },
      messages: [{ role: "user", content: "u" }],
    });
  });

  it("creative brief (P3-51)", async () => {
    fake.replies.push(thinksThen(text("{}")));
    await liveBriefLlm(args);
    expect(lastSent()).toStrictEqual({
      model: "claude-sonnet-5",
      max_tokens: 2_500,
      system: "s",
      messages: [{ role: "user", content: "u" }],
    });
    expect(fake.logged.at(-1)).toEqual({ model: "claude-sonnet-5", workload: "creative_brief" });
  });

  it("support reply draft", async () => {
    fake.replies.push(thinksThen(text("{}")));
    await liveReplyDraftLlm(args);
    expect(lastSent()).toStrictEqual({
      model: "claude-sonnet-5",
      max_tokens: 700,
      system: "s",
      output_config: { format: schemaFormat },
      messages: [{ role: "user", content: "u" }],
    });
  });

  it("review reply suggestion (idea 45)", async () => {
    fake.replies.push(thinksThen(text("{}")));
    await liveReviewReplyLlm(args);
    expect(lastSent()).toStrictEqual({
      model: "claude-sonnet-5",
      max_tokens: 600,
      system: "s",
      output_config: { format: schemaFormat },
      messages: [{ role: "user", content: "u" }],
    });
    expect(fake.logged.at(-1)).toEqual({ model: "claude-sonnet-5", workload: "review_reply" });
  });

  it("diagnosis, recommendations and care review", async () => {
    const opus = (max_tokens: number) => ({
      model: "claude-opus-4-8",
      max_tokens,
      thinking: { type: "adaptive" },
      system: "s",
      output_config: { format: schemaFormat },
      messages: [{ role: "user", content: "u" }],
    });
    fake.replies.push(thinksThen(text("{}")), thinksThen(text("{}")), thinksThen(text("{}")));
    await liveDiagnosisLlm(args);
    expect(lastSent()).toStrictEqual(opus(8_000));
    await liveRecommendationsLlm(args);
    expect(lastSent()).toStrictEqual(opus(6_000));
    await liveReviewLlm(args);
    expect(lastSent()).toStrictEqual(opus(8_000));
  });

  it("interviewer", async () => {
    const system = buildSystemBlocks(await loadInterviewerBank());
    expect(interviewerRequest("claude-sonnet-5", system, "m")).toStrictEqual({
      model: "claude-sonnet-5",
      max_tokens: 300,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: schemaFormat },
      system,
      messages: [{ role: "user", content: "m" }],
    });
  });
});

/* ── Sonnet 5.5 ── */

describe("SONNET_MODEL=claude-sonnet-5-5", () => {
  beforeEach(() => {
    vi.stubEnv("SONNET_MODEL", "claude-sonnet-5-5");
  });

  const answerSites = [
    { name: "owner chat answer", run: () => liveAnswerLlm(args), workload: "chat" },
    { name: "content draft", run: () => liveContentDraftLlm(args), workload: "content" },
    { name: "support answer", run: () => liveSupportAnswerLlm(args), workload: "support" },
    { name: "support reply draft", run: () => liveReplyDraftLlm(args), workload: "support_draft" },
    { name: "creative brief", run: () => liveBriefLlm(args), workload: "creative_brief" },
    { name: "review reply", run: () => liveReviewReplyLlm(args), workload: "review_reply" },
  ];

  for (const site of answerSites) {
    it(`${site.name}: the 5.5 model, an explicit effort, and the answer behind thinking`, async () => {
      fake.replies.push(thinksThen(text("the answer")));
      const got = await site.run();
      const params = lastSent();
      expect(params.model).toBe("claude-sonnet-5-5");
      expect(params).not.toHaveProperty("thinking"); // adaptive, the API default
      expect((params.output_config as { effort?: string }).effort).toBe("low");
      expect(params.max_tokens as number).toBeGreaterThanOrEqual(1_200);
      expectClean(params);
      expect(got.text).toBe("the answer");
      expect(fake.logged.at(-1)).toEqual({ model: "claude-sonnet-5-5", workload: site.workload });
    });
  }

  it("owner chat answer keeps its cache breakpoint", async () => {
    fake.replies.push(thinksThen(text("a")));
    await liveAnswerLlm(args);
    expect(lastSent().system).toEqual([
      { type: "text", text: "s", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("support sites keep their output schema next to the effort", async () => {
    fake.replies.push(thinksThen(text("{}")), thinksThen(text("{}")));
    await liveSupportAnswerLlm(args);
    expect(lastSent().output_config).toStrictEqual({ effort: "low", format: schemaFormat });
    await liveReplyDraftLlm(args);
    expect(lastSent().output_config).toStrictEqual({ effort: "low", format: schemaFormat });
  });

  it("refusals go down each site's own path, never read as an answer", async () => {
    const bait = '{"answer":"bait","grounded":true,"used":["x"]}';
    fake.replies.push(refusal(bait), refusal(bait), refusal(bait), refusal(bait), refusal(bait));
    expect((await liveAnswerLlm(args)).text).toBe(""); // "no answer worth giving"
    await expect(liveContentDraftLlm(args)).rejects.toBeInstanceOf(ModelRefusalError);
    expect(coerceAnswer((await liveSupportAnswerLlm(args)).text).grounded).toBe(false); // a person
    expect(coerceAnswer((await liveReplyDraftLlm(args)).text).grounded).toBe(false); // write it yourself
    await expect(liveBriefLlm(args)).rejects.toBeInstanceOf(ModelRefusalError); // no brief
    expect(fake.logged).toHaveLength(5); // every declined call still metered
  });

  it("a declined review reply is no draft, never the declined text", async () => {
    fake.replies.push(refusal('{"reply":"We will refund you in full."}'));
    const got = await liveReviewReplyLlm(args);
    expect(got.text).toBe("");
    expect(coerceReply(got.text)).toBeNull();
    expect(lastSent().output_config).toStrictEqual({ effort: "low", format: schemaFormat });
  });

  it("a declined content draft makes no draft", async () => {
    fake.replies.push(refusal("Buy now! 50% off!"));
    await expect(
      draftItem({
        card: { traits: [], exemplars: [], boundaries: [] } as never,
        item: {
          format: "post",
          channel_label: "x",
          date: "2026-10-24",
          focus: "f",
          brief: "b",
        } as never,
        kind: "social_post" as never,
        accountId: "acct-m2",
      }),
    ).rejects.toBeInstanceOf(ModelRefusalError);
  });

  it("the interviewer: between_tools at low effort, the bank prefix byte-identical (rule 8)", async () => {
    const system = buildSystemBlocks(await loadInterviewerBank());
    const now = interviewerRequest("claude-sonnet-5", system, "m");
    const next = interviewerRequest("claude-sonnet-5-5", system, "m");
    expect(next.model).toBe("claude-sonnet-5-5");
    expect(next.thinking).toStrictEqual({ type: "between_tools" }); // nothing else inside
    expect(next.output_config).toStrictEqual(now.output_config); // effort low ≤ high
    expect(next.system).toBe(now.system); // same blocks, same breakpoint
    expect(JSON.stringify(next.system)).toBe(JSON.stringify(now.system));
    const blocks = next.system as { cache_control?: unknown }[];
    expect(blocks.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expectClean(next as unknown as Record<string, unknown>);
  });
});

/* ── the interviewer end to end, both models ── */

describe("the interviewer's pick, on both Sonnets (fake client, real resolver)", () => {
  const made: { account: string; profile: string }[] = [];
  /** Picks the first CANDIDATES id from the user turn, behind a thinking block. */
  const pickFirst = (params: unknown) => {
    const user = (params as { messages: { content: string }[] }).messages[0]?.content ?? "";
    const id = /CANDIDATES \(choose exactly one\): ([^,\n]+)/.exec(user)?.[1]?.trim() ?? "";
    return thinksThen(text(JSON.stringify({ next_question_id: id, selection_reason: "first" })));
  };

  async function profile(): Promise<{ account: string; profile: string }> {
    await loadBank("specs/question-bank-v1.json");
    const [account] = await db
      .insert(accounts)
      .values({ reporting_currency: "EUR", locale: "en-GB" })
      .returning();
    const [p] = await db
      .insert(businessProfiles)
      .values({ account_id: account!.id, schema_version: "1.0.0" })
      .returning();
    const ids = { account: account!.id, profile: p!.id };
    made.push(ids);
    return ids;
  }

  afterAll(async () => {
    for (const m of made) {
      await db.delete(businessProfiles).where(eq(businessProfiles.id, m.profile));
      await db.delete(accounts).where(eq(accounts.id, m.account));
    }
  });

  for (const model of ["claude-sonnet-5", "claude-sonnet-5-5"] as const) {
    it(`${model}: reads the pick behind thinking and logs the model used`, async () => {
      vi.stubEnv("SONNET_MODEL", model);
      const ids = await profile();
      fake.replies.push(pickFirst);
      const next = await pickNextQuestion({
        accountId: ids.account,
        profileId: ids.profile,
        asked: [],
      });
      expect(next?.selection_reason).toBe("first");
      expect(next?.calls[0]?.model).toBe(model);
      expect(fake.logged.at(-1)).toEqual({ model, workload: "interviewer" });
      const params = lastSent();
      expect(params.model).toBe(model);
      expect(params.thinking).toStrictEqual(
        model === "claude-sonnet-5" ? { type: "disabled" } : { type: "between_tools" },
      );
      if (model === "claude-sonnet-5-5") expectClean(params);
    });
  }

  it("a refusal is an InterviewerError, never parsed", async () => {
    vi.stubEnv("SONNET_MODEL", "claude-sonnet-5-5");
    const ids = await profile();
    fake.replies.push(refusal('{"next_question_id":"1.1","selection_reason":"bait"}'));
    await expect(
      pickNextQuestion({ accountId: ids.account, profileId: ids.profile, asked: [] }),
    ).rejects.toBeInstanceOf(InterviewerError);
  });

  it("an explicit model argument wins over the env (the recalibration harness)", async () => {
    vi.stubEnv("SONNET_MODEL", "claude-sonnet-5");
    const ids = await profile();
    fake.replies.push(pickFirst);
    await pickNextQuestion({
      accountId: ids.account,
      profileId: ids.profile,
      asked: [],
      model: "claude-sonnet-5-5",
    });
    expect(lastSent().model).toBe("claude-sonnet-5-5");
  });
});

/* ── Opus 5.5 ── */

describe("DIAGNOSIS_MODEL=claude-opus-5-5", () => {
  beforeEach(() => {
    vi.stubEnv("DIAGNOSIS_MODEL", "claude-opus-5-5");
  });

  const opusSites = [
    { name: "diagnosis", run: () => liveDiagnosisLlm(args), cap: 16_000, workload: "diagnosis" },
    {
      name: "recommendations",
      run: () => liveRecommendationsLlm(args),
      cap: 12_000,
      workload: "diagnosis",
    },
    { name: "care review", run: () => liveReviewLlm(args), cap: 16_000, workload: "alert_review" },
  ];

  for (const site of opusSites) {
    it(`${site.name}: Opus 5.5, explicit effort high, adaptive thinking, JSON behind thinking`, async () => {
      fake.replies.push(thinksThen(text('{"ok":true}')));
      const got = await site.run();
      const params = lastSent();
      expect(params.model).toBe("claude-opus-5-5");
      expect(params.thinking).toStrictEqual({ type: "adaptive" });
      expect(params.output_config).toStrictEqual({ effort: "high", format: schemaFormat });
      expect(params.max_tokens).toBe(site.cap);
      expectClean(params);
      expect(got.text).toBe('{"ok":true}');
      expect(got.calls[0]?.model).toBe("claude-opus-5-5");
      expect(fake.logged.at(-1)).toEqual({ model: "claude-opus-5-5", workload: site.workload });
    });
  }

  it("diagnosis and recommendations throw a refusal; the review's comes back as no text", async () => {
    const bait = '{"summary":"bait","findings":[]}';
    fake.replies.push(refusal(bait), refusal(bait), refusal(bait));
    await expect(liveDiagnosisLlm(args)).rejects.toBeInstanceOf(DiagnosisRefusalError);
    await expect(liveRecommendationsLlm(args)).rejects.toBeInstanceOf(DiagnosisRefusalError);
    expect((await liveReviewLlm(args)).text).toBe(""); // → "unusable", a person takes over
    expect(fake.logged).toHaveLength(3);
  });

  it("diagnosisLlmFor names its model regardless of the env (the harness runs both)", async () => {
    fake.replies.push(thinksThen(text("{}")), thinksThen(text("{}")));
    await diagnosisLlmFor("claude-opus-4-8")(args);
    expect(lastSent().model).toBe("claude-opus-4-8");
    expect(lastSent().output_config).toStrictEqual({ format: schemaFormat });
    await diagnosisLlmFor("claude-opus-5-5")(args);
    expect(lastSent().model).toBe("claude-opus-5-5");
  });

  it("reports the stop_reason so the harness can see a max_tokens cut", async () => {
    fake.replies.push({ ...thinksThen(text("{")), stop_reason: "max_tokens" });
    expect((await liveDiagnosisLlm(args)).stop_reason).toBe("max_tokens");
  });
});
