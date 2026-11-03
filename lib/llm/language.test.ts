// L-5 of TASKS-LANGUAGES.md, rule 5: what the model writes is in the right
// language — the person's for what they read, the business's for what its
// customers read — and the prompt says so after anything cached, so the
// cached prefix (rule 8) is byte-identical in every language.
//
// No real model call: the client is a fake that caches the way the API does
// (an exact prefix through the last breakpoint seen before is a read).

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CostLog from "./cost-log";

const fake = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  seen: new Set<string>(),
  reply: "{}",
}));

/** The cacheable prefix: every system block through the last breakpoint. */
function prefixOf(params: Record<string, unknown>): string | null {
  const blocks = (params.system ?? []) as { cache_control?: unknown }[];
  if (!Array.isArray(blocks)) return null;
  const last = blocks.map((b) => b.cache_control !== undefined).lastIndexOf(true);
  return last < 0 ? null : JSON.stringify(blocks.slice(0, last + 1));
}

vi.mock("./client", () => ({
  anthropicClient: () => ({
    messages: {
      create: async (params: Record<string, unknown>) => {
        fake.sent.push(params);
        const prefix = prefixOf(params);
        const hit = prefix !== null && fake.seen.has(prefix);
        if (prefix !== null) fake.seen.add(prefix);
        const tokens = prefix === null ? 0 : Math.ceil(prefix.length / 4);
        return {
          content: [{ type: "text", text: fake.reply }],
          stop_reason: "end_turn",
          stop_details: null,
          usage: {
            input_tokens: 300,
            output_tokens: 40,
            cache_creation_input_tokens: hit ? 0 : tokens,
            cache_read_input_tokens: hit ? tokens : 0,
          },
        };
      },
    },
  }),
}));
vi.mock("./cost-log", async (importOriginal) => ({
  ...(await importOriginal<typeof CostLog>()),
  recordLlmCall: async () => undefined,
}));

const { db } = await import("../../db");
const { accounts, businessProfiles, users } = await import("../../db/schema");
const { LOCALES } = await import("../i18n/locales");
const {
  FACTS_AS_GIVEN,
  LANGUAGE_HEADING,
  customerLanguageLine,
  ownerLanguageLine,
  splitLanguageLine,
} = await import("./language");
const { businessLanguage, ownerLanguage } = await import("./language-of");
const { answerSystemBlocks, liveAnswerLlm } = await import("../chat/service");
const { answerSystem } = await import("../support/chat");
const { draftSystem } = await import("../support-desk/draft");
const { replyProblem, replySystem } = await import("../review-desk/draft");
const { draftItem } = await import("../content/draft");
const { briefSystem, wordCount } = await import("../content/brief");
const { threeSentences } = await import("../diagnosis/findings");
const { PARSER_SYSTEM } = await import("../parser/parse");
const { LIMIT_SYSTEM } = await import("../proposals/hard-limits");
const { SCHEDULE_SYSTEM } = await import("../hours/schedule");
const { DISCOVERY_SYSTEM } = await import("../research/discovery");

beforeEach(() => {
  fake.sent.length = 0;
  fake.seen.clear();
  fake.reply = "{}";
});

/** The three the brief names: the default, a Latin language with a register, and Chinese. */
const SAMPLE = ["en", "de-DE", "zh-Hans"] as const;
const NAMED = { en: "English", "de-DE": "German", "zh-Hans": "Simplified Chinese" } as const;

describe("the instruction names the language and the register, in English", () => {
  it("for the person", () => {
    expect(ownerLanguageLine("en")).toBe(
      `${LANGUAGE_HEADING} Write every sentence the owner reads in English. Keep JSON keys, enum values, ids, codes and field keys exactly as specified, in English; only the human-readable text is written in that language. Names, quotes and figures stay exactly as given, and no currency is converted.`,
    );
    expect(ownerLanguageLine("de-DE")).toContain('in German, addressing them formally, as "Sie".');
    expect(ownerLanguageLine("zh-Hans")).toContain(
      'in Simplified Chinese, addressing them politely, as "您"',
    );
    expect(ownerLanguageLine("es-ES")).toContain(
      'Spanish (Spain), addressing them formally, as "usted"',
    );
    expect(ownerLanguageLine("fr-FR")).toContain('as "vous"');
    expect(ownerLanguageLine("hu-HU")).toContain('as "Ön", with third-person verbs');
    expect(ownerLanguageLine("ru-RU")).toContain('as "вы" (lower case)');
  });

  it("for the business's customers", () => {
    expect(customerLanguageLine("de-DE")).toContain(
      "the business's customers read in German, the business's own language for its customers",
    );
    expect(customerLanguageLine("en")).toContain("customers read in English");
  });

  it("for a brief with two readers", () => {
    const line = splitLanguageLine("de-DE", "zh-Hans", "the offer", "each hook");
    expect(line).toContain("Write the offer — what the owner reads — in German");
    expect(line).toContain(
      "Write each hook — what the business's customers hear — in Simplified Chinese",
    );
  });
});

describe("rule 8: the owner chat's cached block is byte-identical in every language", () => {
  it("the language rides after the breakpoint, uncached, and turn two reads the cache in any language", async () => {
    const system = "RULES\n\nWhat the profile currently holds: …";
    const reads: number[] = [];
    for (const locale of LOCALES) {
      const { calls } = await liveAnswerLlm({
        system,
        user: "How is my margin?",
        accountId: "acct-l5",
        language: ownerLanguageLine(locale),
      });
      reads.push(calls[0]!.cache_read_input_tokens);
    }
    const blocks = fake.sent.map((p) => p.system as { text: string; cache_control?: unknown }[]);
    for (const [i, b] of blocks.entries()) {
      expect(b).toHaveLength(2);
      expect(b[0]).toStrictEqual(answerSystemBlocks(system)[0]); // the breakpoint, unchanged
      expect(b[1]).toStrictEqual({ type: "text", text: ownerLanguageLine(LOCALES[i]!) });
      expect(b[1]).not.toHaveProperty("cache_control");
    }
    // One cache entry serves every language: the first call writes, the rest read.
    expect(new Set(fake.sent.map(prefixOf)).size).toBe(1);
    expect(reads[0]).toBe(0);
    expect(reads.slice(1).every((n) => n > 0)).toBe(true);
  });

  it("without a language the body is exactly today's (one cached block)", async () => {
    await liveAnswerLlm({ system: "s", user: "u", accountId: "acct-l5" });
    expect(fake.sent[0]!.system).toStrictEqual(answerSystemBlocks("s"));
  });
});

describe("customer-facing text is in the business's language, named last", () => {
  const entry = {
    id: "k1",
    question: "Wann haben Sie geöffnet?",
    answer: "Mo–Fr 9–18 Uhr.",
  } as never;

  for (const locale of SAMPLE) {
    it(`${locale}: the widget answer, the reply draft and the review reply`, () => {
      const line = customerLanguageLine(locale);
      for (const system of [
        answerSystem("Bäckerei Kranz", [entry], locale),
        draftSystem("Bäckerei Kranz", [entry], locale),
        replySystem({
          businessName: "Bäckerei Kranz",
          entries: [entry],
          limits: [],
          language: locale,
        }),
      ]) {
        expect(system.endsWith(line)).toBe(true);
        expect(system).toContain(`customers read in ${NAMED[locale]}`);
        // The old "in the customer's own language" clause can't contradict it.
        expect(system).not.toMatch(/language when it (is not|isn't) English/);
      }
    });
  }

  it("a content draft (post, campaign email, follow-up) is told the business's language", async () => {
    fake.reply = "Frisch aus dem Ofen.";
    for (const locale of SAMPLE) {
      await draftItem({
        card: { traits: [], exemplars: [], boundaries: [] } as never,
        item: {
          date: "2026-11-03",
          channel_id: "c",
          channel_label: "instagram",
          format: "post",
          goal_id: null,
          focus: "bread",
          brief: "A post about the bread.",
          evidence: [],
        },
        kind: "post",
        accountId: "acct-l5",
        language: locale,
      });
      expect(String(fake.sent.at(-1)!.system).endsWith(customerLanguageLine(locale))).toBe(true);
    }
  });

  it("a brief: the owner's parts in their language, hooks and scripts in the business's", () => {
    const s = briefSystem("de-DE", "zh-Hans");
    expect(s).toContain("— what the owner reads — in German");
    expect(s).toContain(
      "each hook and script — what the business's customers hear — in Simplified Chinese",
    );
    expect(briefSystem("en", "en")).toContain("in English");
  });
});

describe("validators accept correct non-English output", () => {
  it("the summary keeps three sentences in every language", () => {
    expect(threeSentences("Eins. Zwei! Drei? Vier.")).toBe("Eins. Zwei! Drei?");
    expect(threeSentences("Маржа низкая. Затраты растут. Начните с цены. Потом склад.")).toBe(
      "Маржа низкая. Затраты растут. Начните с цены.",
    );
    expect(threeSentences("Hay margen. ¿Lo sabía? ¡Suba el precio! Luego el stock.")).toBe(
      "Hay margen. ¿Lo sabía? ¡Suba el precio!",
    );
    expect(threeSentences("您的毛利率偏低。成本在上升。请先调价。然后再看库存。")).toBe(
      "您的毛利率偏低。成本在上升。请先调价。",
    );
    expect(
      threeSentences("Szörp 0.5L returns 4.5 million HUF. Second sentence. Third. Fourth."),
    ).toBe("Szörp 0.5L returns 4.5 million HUF. Second sentence. Third.");
  });

  it("a Chinese script is counted by how long it takes to say, not as one word", () => {
    const script = "早上七点，我们的面包刚出炉。".repeat(4); // 48 characters, about 12 seconds
    expect(wordCount(script)).toBeGreaterThanOrEqual(25);
    expect(wordCount(script)).toBeLessThanOrEqual(85);
    expect(wordCount("Fresh bread at seven — every day")).toBe(7); // English exactly as before
  });

  it("a review reply offering money or something free is caught in every language", () => {
    for (const offer of [
      "Le ofrecemos un descuento en su próxima visita.",
      "Su próximo café es gratis.",
      "Gerne schicken wir Ihnen einen Gutschein.",
      "Wir gewähren Ihnen einen Sonderrabatt.",
      "Nous vous proposons un remboursement.",
      "Votre prochain dessert est offert par la maison.",
      "Szívesen adunk Önnek kedvezményt.",
      "A következő kávé ingyenes.",
      "Мы предложим вам скидку.",
      "Мы вернём вам деньги.",
      "我们愿意为您退款。",
      "下次光临可享受八折。",
    ]) {
      expect(replyProblem(offer, null), offer).toBe("offer");
    }
  });

  it("an honest reply passes in every language", () => {
    for (const fine of [
      "Gracias por su reseña. Vale, lo revisaremos con el equipo.",
      "Vielen Dank für Ihre Bewertung. Bitte melden Sie sich direkt bei uns.",
      "Merci pour votre avis. Nous travaillons à la réduction des délais.",
      "Köszönjük a véleményét, kérjük, keressen minket közvetlenül.",
      "Спасибо за отзыв. Пожалуйста, свяжитесь с нами напрямую.",
      "感谢您的评价，请直接与我们联系。",
    ]) {
      expect(replyProblem(fine, null), fine).toBeNull();
    }
  });
});

describe("facts stay in the language they were given (rule 4)", () => {
  it("every extraction prompt says so", () => {
    for (const system of [PARSER_SYSTEM, LIMIT_SYSTEM, SCHEDULE_SYSTEM, DISCOVERY_SYSTEM]) {
      expect(system).toContain(FACTS_AS_GIVEN);
    }
  });
});

describe("whose language: the business's setting, and the owner's own through the gate", () => {
  const made: { account: string; profile: string }[] = [];
  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const m of made) {
      await db.delete(users).where(eq(users.account_id, m.account));
      await db.delete(businessProfiles).where(eq(businessProfiles.id, m.profile));
    }
    await db.delete(accounts).where(
      inArray(
        accounts.id,
        made.map((m) => m.account),
      ),
    );
  });

  it("reads the business's language, and the owner's (English while in review for a non-reviewer)", async () => {
    const [account] = await db
      .insert(accounts)
      .values({ reporting_currency: "EUR", locale: "de-DE" })
      .returning();
    const [profile] = await db
      .insert(businessProfiles)
      .values({ account_id: account!.id, schema_version: "1.0.0", language: "fr-FR" })
      .returning();
    made.push({ account: account!.id, profile: profile!.id });
    await db.insert(users).values({
      account_id: account!.id,
      email: "l5-owner@example.test",
      display_name: "Owner",
      role: "owner",
      language: "de-DE",
    });
    expect(await businessLanguage(profile!.id)).toBe("fr-FR");
    vi.stubEnv("LANGUAGE_REVIEW_ACCOUNTS", "");
    expect(await ownerLanguage(account!.id)).toBe("en"); // the gate (rule 6)
    vi.stubEnv("LANGUAGE_REVIEW_ACCOUNTS", "l5-owner@example.test");
    expect(await ownerLanguage(account!.id)).toBe("de-DE");
    expect(await ownerLanguage("00000000-0000-0000-0000-000000000000")).toBe("en");
  });
});
