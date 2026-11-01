// Rule 8 per language (L-2 of TASKS-LANGUAGES.md, plan rule 5): the
// interviewer's cached prefix is the instructions plus the bank — and, for
// a language other than English, that language's words beside it. Each
// language is its own cache entry, byte-stable from turn to turn, so turn
// two reads from the cache in every language. English's prefix is exactly
// what it was before L-2.
//
// The model is a fake that caches the way the API does: an exact prefix
// (every system block up to and including the cache breakpoint) seen
// before is a cache read; a new one is a cache write. No network call.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CostLog from "../llm/cost-log";
import type { LlmCallRecord } from "../llm/cost-log";

const fake = vi.hoisted(() => ({
  seen: new Set<string>(),
  prefixes: [] as string[],
}));

/** The cacheable prefix of a request: the system blocks through the last breakpoint. */
function prefixOf(params: { system?: { text: string; cache_control?: unknown }[] }): string {
  const blocks = params.system ?? [];
  const last = blocks.map((b) => b.cache_control !== undefined).lastIndexOf(true);
  return JSON.stringify(blocks.slice(0, last + 1));
}

vi.mock("../llm/client", () => ({
  anthropicClient: () => ({
    messages: {
      create: async (params: {
        system?: { text: string; cache_control?: unknown }[];
        messages: { content: string }[];
      }) => {
        const prefix = prefixOf(params);
        fake.prefixes.push(prefix);
        const tokens = Math.ceil(prefix.length / 4);
        const hit = fake.seen.has(prefix);
        fake.seen.add(prefix);
        const user = params.messages[0]?.content ?? "";
        const id = /CANDIDATES \(choose exactly one\): ([^,\n]+)/.exec(user)?.[1]?.trim() ?? "";
        return {
          content: [
            { type: "text", text: JSON.stringify({ next_question_id: id, selection_reason: "r" }) },
          ],
          stop_reason: "end_turn",
          stop_details: null,
          usage: {
            input_tokens: 400,
            output_tokens: 20,
            cache_creation_input_tokens: hit ? 0 : tokens,
            cache_read_input_tokens: hit ? tokens : 0,
          },
        };
      },
    },
  }),
}));
vi.mock("../llm/cost-log", async (importOriginal) => ({
  ...(await importOriginal<typeof CostLog>()),
  recordLlmCall: async (record: LlmCallRecord) => {
    void record;
  },
}));

const { db } = await import("../../db");
const { accounts, businessProfiles, fieldRecords } = await import("../../db/schema");
const { loadBank } = await import("../bank/loader");
const { createField } = await import("../core/field");
const { fieldId } = await import("../core/ids");
const { isoDateTime } = await import("../core/iso");
const { LOCALES } = await import("../i18n/locales");
const { writeField } = await import("../profile/field-store");
const { pickNextQuestion, resetInterviewerBankCache } = await import("./interviewer");
const { buildSystemBlocks, loadInterviewerBank } = await import("./prompt");

const made: { account: string; profile: string }[] = [];

beforeAll(async () => {
  vi.stubEnv("SONNET_MODEL", "claude-sonnet-5");
  await loadBank("specs/question-bank-v1.json");
});

beforeEach(() => {
  fake.seen.clear();
  fake.prefixes.length = 0;
  resetInterviewerBankCache();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  for (const m of made) {
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, m.profile));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, m.profile));
    await db.delete(accounts).where(eq(accounts.id, m.account));
  }
});

async function profile(): Promise<{ account: string; profile: string }> {
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

/** Two real interviewer turns, the second after an answer (a genuinely different suffix). */
async function twoTurns(locale: (typeof LOCALES)[number]) {
  const ids = await profile();
  const t1 = await pickNextQuestion({
    accountId: ids.account,
    profileId: ids.profile,
    asked: [],
    locale,
  });
  if (!t1) throw new Error("turn 1 returned no question");
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    ids.profile,
    createField<string>({
      id: fieldId(t1.question.writes_to),
      value: "Cache Kft.",
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note: null,
    }),
  );
  const t2 = await pickNextQuestion({
    accountId: ids.account,
    profileId: ids.profile,
    asked: [{ question_id: t1.question.id, answer_repr: '"Cache Kft."' }],
    locale,
  });
  if (!t2) throw new Error("turn 2 returned no question");
  return { t1: t1.calls[0]!, t2: t2.calls[0]!, picked: t2.question.id };
}

describe("rule 8, per language: turn two reads the cache", () => {
  for (const locale of LOCALES) {
    it(`${locale}: turn 1 writes the cache, turn 2 reads it, the prefix byte-identical`, async () => {
      const { t1, t2 } = await twoTurns(locale);
      expect(t1.cache_creation_input_tokens).toBeGreaterThan(0);
      expect(t2.cache_read_input_tokens).toBeGreaterThan(0);
      expect(t2.cache_creation_input_tokens).toBe(0);
      // The bank is most of the prefix: what turn 2 read covers it.
      expect(t2.cache_read_input_tokens).toBeGreaterThan(5_000);
      expect(fake.prefixes[0]).toBe(fake.prefixes[1]);
    });
  }

  it("keeps one cache entry per language, and English's exactly as before L-2", async () => {
    for (const locale of LOCALES) await twoTurns(locale);
    // Seven languages, seven prefixes: no language reads another's words.
    expect(new Set(fake.prefixes).size).toBe(LOCALES.length);
    const english = JSON.stringify(buildSystemBlocks(await loadInterviewerBank()));
    expect(fake.prefixes[0]).toBe(english);
    expect(english).not.toContain("prompt_local");
    expect(english).not.toContain("LANGUAGE");
  });

  it("tells the model the language and gives it the overlay's words", async () => {
    const bank = await loadInterviewerBank("de-DE");
    const [instructions, block] = buildSystemBlocks(bank);
    // The instructions block is the same in every language; the bank block names it.
    expect(instructions?.text).toBe(buildSystemBlocks(await loadInterviewerBank())[0]?.text);
    expect(block?.cache_control).toEqual({ type: "ephemeral" });
    expect(block?.text).toContain("LANGUAGE de-DE");
    expect(block?.text).toContain("The owner reads this interview in German.");
    const de = JSON.parse(readFileSync("specs/question-bank-v1.de-DE.json", "utf8")) as {
      questions: Record<string, { prompt: string }>;
    };
    expect(block?.text).toContain(`"prompt_local":${JSON.stringify(de.questions["1.1"]?.prompt)}`);
    // Two independent loads build the same bytes (the cache's precondition).
    const again = buildSystemBlocks(await loadInterviewerBank("de-DE"));
    expect(again[1]?.text).toBe(block?.text);
  });
});
