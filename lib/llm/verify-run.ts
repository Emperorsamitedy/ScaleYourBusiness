// M-1 — the Haiku 5.5 move (PR #34) checked against the real API: the run.
//
// The eight checks PR #34 listed, each through the app's OWN live LLM
// function (the same code path production runs, the real client) on
// synthetic inputs only. A tape on the client records every response on
// its way back; the app's own llm_call lines are captured as it logs them.
// lib/llm/verify-models.ts judges them into PASS / FAIL lines.
//
// Imported only by scripts/verify-models.ts, after it has checked the key,
// printed the cost ceiling, had --yes, and pointed DATABASE_URL where the
// owner asked — the database pool reads DATABASE_URL at import. The test
// (verify-run.test.ts) runs it whole against a fake client.

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../../db";
import { llmCalls } from "../../db/schema";
import { anthropicClient } from "./client";
import { CHANGE_INTENT_SYSTEM, liveChangeIntentLlm } from "../assistant/intent";
import { CLASSIFY_SYSTEM, coerceKind, liveClassifyLlm } from "../proposals/generate";
import { LIMIT_SYSTEM, coerceLimits, liveLimitLlm } from "../proposals/hard-limits";
import {
  DISCOVERY_SYSTEM,
  cleanCandidates,
  extractJson,
  liveDiscoveryLlm,
} from "../research/discovery";
import { liveSearchProvider } from "../research/live";
import { CLUSTER_SYSTEM, coerceClusters, liveFaqLlm } from "../crm/faq";
import {
  PRICE_SYSTEM,
  buildPricePrompt,
  livePriceLlm,
  parsePriceAnswer,
} from "../competitors/model";
import { PARSER_MODEL, PARSER_SYSTEM, liveExtractionLlm, parserUserMessage } from "../parser/parse";
import { coerceParsedValue } from "../parser/coerce";
import { SUPPORT_INTENT_SYSTEM, liveSupportIntentLlm } from "../support/chat";
import type { Exchange, LoggedCall, Observation, Verdict } from "./verify-models";
import {
  formatVerdict,
  judgeCacheRead,
  judgeDiscovery,
  judgeJsonWithinCap,
  judgeLimits,
  judgeOneSearch,
  judgeParser,
  judgeParserTokenCount,
  judgeRoomToFinish,
} from "./verify-models";

/* ── synthetic inputs (never customer data) ── */

const CLASSIFY_INPUT =
  "Raise the price of the sourdough loaf by 8%\n\nThe loaf sells out by noon every day and flour costs are up a fifth since spring.";
const SUPPORT_INPUT = "Hi! Do you deliver on Sundays, or only on weekdays?";
const CHANGE_INPUTS = [
  "Change Saturday opening hours to 9 till 2",
  "Set the reply time to 4 hours please",
] as const;
const DISCOVERY_INPUT = [
  "THE BUSINESS, IN THE OWNER'S OWN WORDS:",
  "- what it does: a small independent sourdough bakery and coffee counter",
  "- what it sells: sourdough loaves, pastries, filter coffee",
  "- country: Hungary (Szeged)",
  "",
  "Find their direct competitors.",
].join("\n");
const SEARCH_QUERY = "independent sourdough bakery Szeged";
const LIMITS_INPUT =
  "We never discount — no sales, no coupons, ever. I won't pay for advertising. " +
  "Never send cold emails to people who didn't ask for them. And no plastic packaging, full stop.";
const LIMITS_EXPECTED = ["no_discounts", "no_paid_ads", "no_cold_outreach", "other"];
const PARSER_SENTENCE = "about 4 and a half million a month, before tax";

/** ~200 customer questions over ten topics — the FAQ check's batch. */
function faqQuestions(): { id: string; question: string }[] {
  const topics = [
    ["Do you deliver to", "Can you bring an order to", "Is delivery possible to", "Do you ship to"],
    [
      "What time do you open on",
      "Are you open on",
      "What are your hours on",
      "When do you close on",
    ],
    [
      "Is the sourdough vegan",
      "Does the rye loaf have milk in it",
      "Is there egg in the",
      "Are your loaves dairy-free",
    ],
    [
      "Can I order a birthday cake for",
      "Do you make custom cakes for",
      "Could you bake a cake for",
      "Do you take cake orders for",
    ],
    [
      "Do you have gluten-free bread",
      "Is anything gluten free",
      "Do you bake without wheat",
      "Any coeliac-safe options",
    ],
    ["Can I pay by card", "Do you take contactless", "Is cash only", "Can I pay with my phone"],
    [
      "Do you sell gift cards",
      "Can I buy a voucher",
      "Do you have gift vouchers",
      "Is there a gift card",
    ],
    [
      "Can I reserve a loaf for",
      "Can you hold bread for me until",
      "Can I pre-order for",
      "Do you take pre-orders for",
    ],
    [
      "Is there parking near",
      "Where can I park by",
      "Is there a car park at",
      "Can I park outside",
    ],
    [
      "Do you cater for",
      "Can you supply bread for",
      "Do you do wholesale for",
      "Could you cater an event on",
    ],
  ];
  const tails = ["Saturday", "the weekend", "Szeged centre", "next week", "Friday"];
  const out: { id: string; question: string }[] = [];
  for (const phrasings of topics) {
    for (const p of phrasings)
      for (const t of tails) out.push({ id: randomUUID(), question: `${p} ${t}?` });
  }
  return out; // 10 × 4 × 5 = 200
}

/** Six synthetic competitor price pages, each near the 4,000-character cap. */
function pricePages(): { url: string; text: string; currencies: string[] }[] {
  const items = [
    "Sourdough loaf",
    "Rye loaf",
    "Croissant",
    "Cinnamon roll",
    "Baguette",
    "Seeded roll",
    "Focaccia",
    "Filter coffee",
  ];
  return Array.from({ length: 6 }, (_, p) => {
    const lines = items.map((name, i) => `${name} ${p + 1} — ${(i + 2) * 150 + p * 10} Ft`);
    const filler =
      " Baked fresh every morning from flour milled in the region, shaped by hand and left to rise overnight.".repeat(
        30,
      );
    return {
      url: `https://bakery-${p + 1}.example/prices`,
      text: `Price list, bakery ${p + 1}. ${lines.join(". ")}.${filler}`.slice(0, 3_900),
      currencies: ["HUF"],
    };
  });
}

/* ── the run ── */

/**
 * Run the eight checks, printing each verdict as it lands. Restores
 * console.log and the client's create() before returning.
 */
export async function runVerifyModels(opts: {
  accountId: string;
  print?: (line: string) => void;
}): Promise<{ verdicts: Verdict[]; spent_eur: number }> {
  // The tape: the real client, its responses recorded on the way back.
  const client = anthropicClient();
  const tape: Exchange[] = [];
  const original = { create: client.messages.create, log: console.log };
  const create = client.messages.create.bind(client.messages);
  client.messages.create = ((params: { max_tokens: number }, options?: unknown) =>
    (create as (p: unknown, o?: unknown) => Promise<Exchange["response"]>)(params, options).then(
      (response) => {
        tape.push({ max_tokens: params.max_tokens, response });
        return response;
      },
    )) as unknown as typeof client.messages.create;

  // The app's own cost lines, captured as it logs them.
  const logged: LoggedCall[] = [];
  const passThrough = console.log.bind(console);
  const print = opts.print ?? ((line: string) => passThrough(line));
  console.log = (...parts: unknown[]) => {
    const [first] = parts;
    if (typeof first === "string" && first.startsWith('{"at"')) {
      try {
        const r = JSON.parse(first) as { event?: string } & LoggedCall;
        if (r.event === "llm_call") {
          logged.push({ model: r.model, workload: r.workload, cost_eur: r.cost_eur });
          return;
        }
      } catch {
        /* not ours — print it */
      }
    }
    passThrough(...parts);
  };

  try {
    return await checks();
  } finally {
    console.log = original.log;
    client.messages.create = original.create;
  }

  async function checks(): Promise<{ verdicts: Verdict[]; spent_eur: number }> {
    async function observe<T>(
      fn: () => Promise<T>,
    ): Promise<{ obs: Observation; value: T | null }> {
      const [t0, l0] = [tape.length, logged.length];
      let value: T | null = null;
      let error: string | null = null;
      try {
        value = await fn();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      return { obs: { exchanges: tape.slice(t0), logged: logged.slice(l0), error }, value };
    }

    const acct = opts.accountId;
    const verdicts: Verdict[] = [];
    const report = (v: Verdict) => {
      verdicts.push(v);
      print(formatVerdict(v));
    };
    const jsonOk = (t: string): boolean => {
      try {
        JSON.parse(t);
        return true;
      } catch {
        return false;
      }
    };
    print("");

    // 1. classify + support intent
    {
      const { obs, value } = await observe(async () => {
        const a = await liveClassifyLlm({
          system: CLASSIFY_SYSTEM,
          user: CLASSIFY_INPUT,
          accountId: acct,
        });
        const b = await liveSupportIntentLlm({
          system: SUPPORT_INTENT_SYSTEM,
          user: SUPPORT_INPUT,
          accountId: acct,
        });
        return [a.text, b.text] as const;
      });
      const complete = value
        ? [
            coerceKind(value[0]) !== null,
            jsonOk(value[1]) &&
              ["question", "wants_human", "social"].includes(
                String((JSON.parse(value[1]) as { intent?: unknown }).intent),
              ),
          ]
        : [];
      report(judgeJsonWithinCap(obs, complete));
    }

    // 2. change intent twice, within seconds
    {
      const { obs } = await observe(async () => {
        for (const user of CHANGE_INPUTS) {
          await liveChangeIntentLlm({ system: CHANGE_INTENT_SYSTEM, user, accountId: acct });
        }
      });
      report(judgeCacheRead(obs));
    }

    // The parser's question and user turn, shared by checks 3 and 8.
    const asked = {
      writes_to: "revenue.monthly_revenue",
      input: { type: "money" },
      prompt: { en: "Roughly how much revenue does the business bring in per month?" },
    };
    const others = [
      {
        writes_to: "identity.team_size",
        input: { type: "number" },
        prompt: { en: "How many people work in the business, including you?" },
      },
      {
        writes_to: "revenue.order_count_monthly",
        input: { type: "number" },
        prompt: { en: "About how many orders or sales do you make in a month?" },
      },
    ];
    const parserUser = parserUserMessage(asked, others, new Map(), PARSER_SENTENCE);

    // 3. count_tokens on the parser prompt
    {
      let count: number | null = null;
      let error: string | null = null;
      try {
        const r = await client.messages.countTokens({
          model: PARSER_MODEL,
          system: PARSER_SYSTEM,
          messages: [{ role: "user", content: "." }],
        });
        count = r.input_tokens;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      report(judgeParserTokenCount(count, error));
    }

    // 4. discovery at medium
    {
      const { obs, value } = await observe(() =>
        liveDiscoveryLlm({ system: DISCOVERY_SYSTEM, user: DISCOVERY_INPUT, accountId: acct }),
      );
      let parsed = { ok: false, candidates: 0, detail: null as string | null };
      if (value) {
        try {
          parsed = {
            ok: true,
            candidates: cleanCandidates(extractJson(value.text), null).kept.length,
            detail: null,
          };
        } catch (e) {
          parsed = { ok: false, candidates: 0, detail: e instanceof Error ? e.message : String(e) };
        }
      }
      report(judgeDiscovery(obs, parsed));
    }

    // 5. one web search
    {
      const { obs, value } = await observe(() => liveSearchProvider(SEARCH_QUERY, 5, acct));
      report(judgeOneSearch(obs, value?.length ?? 0));
    }

    // 6. FAQ over ~200 questions, prices over 6 pages
    {
      const questions = faqQuestions();
      const pages = pricePages();
      const { obs, value } = await observe(async () => {
        const faq = await liveFaqLlm({
          system: CLUSTER_SYSTEM,
          user: questions.map((q) => `[${q.id}] ${q.question}`).join("\n"),
          accountId: acct,
        });
        const prices = await livePriceLlm({
          system: PRICE_SYSTEM,
          user: buildPricePrompt(pages),
          accountId: acct,
        });
        return [faq.text, prices.text] as const;
      });
      const read = value
        ? [
            {
              label: `FAQ clusters from ${questions.length} questions:`,
              ok: jsonOk(value[0]),
              count: coerceClusters(value[0], new Set(questions.map((q) => q.id))).length,
            },
            {
              label: `offers read from ${pages.length} pages:`,
              ok: jsonOk(value[1]),
              count: [...parsePriceAnswer(value[1], pages).values()].reduce(
                (s, o) => s + o.length,
                0,
              ),
            },
          ]
        : [];
      report(judgeRoomToFinish(obs, read));
    }

    // 7. hard limits on a synthetic 13.5 answer
    {
      const { obs, value } = await observe(() =>
        liveLimitLlm({ system: LIMIT_SYSTEM, user: LIMITS_INPUT, accountId: acct }),
      );
      let codes: string[];
      try {
        codes = value ? coerceLimits(value.text).map((l) => l.code) : [];
      } catch {
        codes = []; // unreadable JSON: no codes, which the judge reports
      }
      report(judgeLimits(obs, codes, LIMITS_EXPECTED));
    }

    // 8. the parser's canonical sentence, and the llm_calls row it wrote
    {
      const since = new Date().toISOString();
      const { obs, value } = await observe(() =>
        liveExtractionLlm({ system: PARSER_SYSTEM, user: parserUser, accountId: acct }),
      );
      let money: { amount_minor: number; currency: string } | null = null;
      let isEstimate: boolean | null = null;
      let wording: string | null = null;
      if (value && jsonOk(value.text)) {
        const fields =
          (
            JSON.parse(value.text) as {
              fields?: {
                field_key: string;
                value: unknown;
                is_estimate: boolean;
                estimate_wording: string;
              }[];
            }
          ).fields ?? [];
        const f = fields.find((x) => x.field_key === asked.writes_to);
        if (f) {
          isEstimate = f.is_estimate;
          wording = f.estimate_wording;
          const c = coerceParsedValue({ type: "money" }, f.value, [], "HUF");
          if (c.ok) money = c.value as { amount_minor: number; currency: string };
        }
      }
      let dbModels: string[] = [];
      let dbError: string | null = null;
      try {
        const rows = await db
          .select({ model: llmCalls.model })
          .from(llmCalls)
          .where(
            and(
              eq(llmCalls.account_id, acct),
              eq(llmCalls.workload, "parser"),
              gte(llmCalls.at, since),
            ),
          )
          .orderBy(desc(llmCalls.at));
        dbModels = rows.map((r) => r.model);
      } catch (e) {
        dbError = e instanceof Error ? e.message : String(e);
      }
      report(
        judgeParser(
          obs,
          { money, is_estimate: isEstimate, wording, db_models: dbModels, db_error: dbError },
          { amount_minor: 450_000_000, currency: "HUF", hedge: "about" },
        ),
      );
    }

    return { verdicts, spent_eur: logged.reduce((s, c) => s + c.cost_eur, 0) };
  }
}
