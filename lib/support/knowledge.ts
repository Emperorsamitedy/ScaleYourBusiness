// The sayable set — Phase 4 Session B (P4-05), the stranger-facing READ.
//
// A support answer is grounded ONLY in knowledge_entries rows with
// status "public", and every such row was born from a proposal the
// owner approved (the writer is lib/crm/knowledge.ts, on the trusted
// side). This module reads them and picks the few relevant to a
// question — by plain word overlap, no model, no embeddings: a lookup
// that costs nothing and cannot be talked into anything.

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { knowledgeEntries } from "../../db/schema";

export type KnowledgeEntryRow = typeof knowledgeEntries.$inferSelect;

export async function publicKnowledge(profileId: string): Promise<KnowledgeEntryRow[]> {
  return db
    .select()
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.profile_id, profileId), eq(knowledgeEntries.status, "public")))
    .orderBy(knowledgeEntries.published_at);
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "you",
  "your",
  "can",
  "how",
  "what",
  "when",
  "where",
  "does",
  "do",
  "did",
  "with",
  "have",
  "has",
  "this",
  "that",
  "there",
  "from",
  "about",
  "any",
  "much",
  "many",
  "please",
  "hello",
  "thanks",
]);

/** Lower-cased words of three letters or more, stopwords out, deduplicated. */
export function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

/** Light stemming so "hours" meets "hour" and "deliveries" meets "delivery". */
function stem(word: string): string {
  return word.replace(/(ies|es|s)$/u, "").replace(/ing$/u, "");
}

/**
 * How many of the question's words appear in the entry's question or
 * answer. Deterministic, explainable, and the whole of the retrieval.
 */
export function overlapScore(
  question: string,
  entry: Pick<KnowledgeEntryRow, "question" | "answer">,
): number {
  const haystack = new Set(tokenize(`${entry.question} ${entry.answer}`).map(stem));
  // Unique STEMS of the question: "open" and "opening" are one idea, one point.
  const asked = new Set(tokenize(question).map(stem));
  let score = 0;
  for (const word of asked) {
    if (haystack.has(word)) score += 1;
  }
  return score;
}

/** The small set of entries a question could be answered from — or none. */
export const MAX_GROUNDING_ENTRIES = 8;
/** Below this many public entries, every one goes in: the model can judge coverage cheaply. */
export const SMALL_KNOWLEDGE_BASE = 12;

export function selectEntries(
  question: string,
  entries: readonly KnowledgeEntryRow[],
): KnowledgeEntryRow[] {
  const scored = entries
    .map((entry) => ({ entry, score: overlapScore(question, entry) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.published_at.localeCompare(b.entry.published_at));
  if (scored.length > 0) return scored.slice(0, MAX_GROUNDING_ENTRIES).map((s) => s.entry);
  if (entries.length > 0 && entries.length <= SMALL_KNOWLEDGE_BASE) return [...entries];
  return [];
}
